/**
 * 生图任务的后台执行器。
 *
 * 浏览器只负责「提交任务」和「轮询状态」，长耗时的上游请求在 Durable Object 里跑：
 * 浏览器关掉、手机切后台、Wi-Fi 抖动都不会中断生成，失败还能按退避自动重试。
 *
 * 每个任务一个实例，请求体分片存在 DO 存储里（单值上限 128 KiB），
 * 由 alarm 触发执行，避免依赖 Worker 请求的存活时间。
 */

import { collectAgnesImages, rewriteAgnesRequest } from './agnes'

interface JobEnv {
  UPSTREAM_BASE_URL: string
  UPSTREAM_API_KEY?: string
  UPSTREAM_AUTH_HEADER?: string
  UPSTREAM_PROTOCOL?: string
  AGNES_BASE_URL?: string
  AGNES_API_KEY?: string
  AGNES_AUTH_HEADER?: string
  AGNES_IMAGE_MODEL?: string
  PROXY_TIMEOUT_MS?: string
  JOB_MAX_ATTEMPTS?: string
}

interface JobMeta {
  publicId: string
  protocol: 'openai' | 'agnes'
  upstreamPath: string
  origin: string
  contentType: string
  accept: string
  chunkCount: number
  status: 'pending' | 'running' | 'completed' | 'failed'
  attempts: number
  error?: string
  images?: Array<{ mime: string; bytes: number }>
}

const CHUNK_SIZE = 100_000
const RETRY_DELAYS_MS = [5_000, 20_000, 60_000]

const readEnv = (value: string | undefined) => String.prototype.trim.call(value ?? '')

function bytesToBase64(bytes: Uint8Array) {
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

function normalizeBaseUrl(raw: string) {
  if (!raw) return null
  const withScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(raw) ? raw : `https://${raw}`
  return new URL(withScheme).toString().replace(/\/+$/, '')
}

function getJobProtocol(env: JobEnv, requested?: string | null): 'openai' | 'agnes' {
  if (requested === 'agnes' || requested === 'openai') return requested
  return readEnv(env.UPSTREAM_PROTOCOL).toLowerCase() === 'agnes' ? 'agnes' : 'openai'
}

function getUpstreamBase(env: JobEnv, protocol: 'openai' | 'agnes' = 'openai') {
  return normalizeBaseUrl(readEnv(protocol === 'agnes' ? env.AGNES_BASE_URL : env.UPSTREAM_BASE_URL))
}

function buildUpstreamAuth(env: JobEnv, protocol: 'openai' | 'agnes' = 'openai'): Record<string, string> {
  const key = readEnv(protocol === 'agnes' ? env.AGNES_API_KEY : env.UPSTREAM_API_KEY)
  if (!key) return {}
  const mode = readEnv(protocol === 'agnes' ? env.AGNES_AUTH_HEADER : env.UPSTREAM_AUTH_HEADER).toLowerCase()
  if (mode === 'apikey') return { 'X-Api-Key': key }
  if (mode === 'basic') return { Authorization: `Basic ${key}` }
  if (mode === 'none') return {}
  return { Authorization: `Bearer ${key}` }
}

function getAttemptLimit(env: JobEnv) {
  const value = Number(readEnv(env.JOB_MAX_ATTEMPTS))
  return Number.isFinite(value) && value >= 1 ? Math.min(5, Math.trunc(value)) : 3
}

function getRequestTimeout(env: JobEnv) {
  const value = Number(readEnv(env.PROXY_TIMEOUT_MS))
  return Number.isFinite(value) && value >= 1000 ? value : 300_000
}

/** 从上游响应里取出图片，统一成 {mime, base64} */
function extractImages(payload: unknown, fallbackMime: string): Array<{ mime: string; base64: string }> {
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const items = Array.isArray(record.data) ? record.data : Array.isArray(payload) ? payload : []
  const images: Array<{ mime: string; base64: string }> = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const entry = item as Record<string, unknown>
    const base64 = typeof entry.b64_json === 'string' ? entry.b64_json : typeof entry.base64 === 'string' ? entry.base64 : ''
    if (!base64) continue
    const format = typeof entry.output_format === 'string' ? entry.output_format : ''
    images.push({ mime: format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : fallbackMime, base64 })
  }
  return images
}

export class ImageJob {
  private state: DurableObjectState
  private env: JobEnv

  constructor(state: DurableObjectState, env: JobEnv) {
    this.state = state
    this.env = env
  }

  private async readMeta() {
    return await this.state.storage.get<JobMeta>('meta') ?? null
  }

  private async readBody(meta: JobMeta) {
    const parts: Uint8Array[] = []
    let total = 0
    for (let i = 0; i < meta.chunkCount; i += 1) {
      const chunk = await this.state.storage.get<ArrayBuffer | Uint8Array | string>(`chunk:${i}`)
      if (!chunk) continue
      const bytes = typeof chunk === 'string'
        ? Uint8Array.from(atob(chunk), (char) => char.charCodeAt(0))
        : chunk instanceof Uint8Array
          ? chunk
          : new Uint8Array(chunk)
      parts.push(bytes)
      total += bytes.length
    }
    const merged = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
      merged.set(part, offset)
      offset += part.length
    }
    return merged
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const action = url.searchParams.get('action') ?? 'status'

    if (action === 'start') return this.start(request, url)
    if (action === 'status') return this.status()
    if (action === 'image') return this.image(Number(url.searchParams.get('index') ?? '0'))

    return new Response(JSON.stringify({ error: { message: '未知的任务操作' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    })
  }

  private async start(request: Request, url: URL) {
    const existing = await this.readMeta()
    if (existing) return this.status()

    const body = new Uint8Array(await request.arrayBuffer())
    const chunkCount = Math.max(1, Math.ceil(body.length / CHUNK_SIZE) || 1)
    for (let i = 0; i < chunkCount; i += 1) {
      await this.state.storage.put(`chunk:${i}`, body.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE))
    }

    const meta: JobMeta = {
      publicId: url.searchParams.get('job') ?? this.state.id.toString(),
      protocol: getJobProtocol(this.env, url.searchParams.get('protocol')),
      upstreamPath: url.searchParams.get('upstream') ?? 'images/generations',
      origin: url.searchParams.get('origin') ?? '',
      contentType: request.headers.get('X-Upstream-Content-Type') || 'application/json',
      accept: request.headers.get('X-Upstream-Accept') || 'application/json',
      chunkCount,
      status: 'pending',
      attempts: 0,
    }
    await this.state.storage.put('meta', meta)
    await this.state.storage.setAlarm(Date.now())
    return this.status()
  }

  private async status() {
    const meta = await this.readMeta()
    if (!meta) {
      return Response.json({ status: 'failed', error: { message: '任务不存在或已过期' } }, { status: 404 })
    }
    if (meta.status === 'failed') {
      return Response.json({ status: 'failed', error: { message: meta.error || '生成失败' } })
    }
    if (meta.status !== 'completed') {
      return Response.json({ status: 'pending' })
    }
    const images = meta.images ?? []
    const origin = meta.origin
    const jobId = meta.publicId
    return Response.json({
      status: 'completed',
      result: {
        data: images.map((_: { mime: string; bytes: number }, index: number) => ({
          url: `${origin}/api/jobs/${jobId}/image?index=${index}`,
        })),
      },
    })
  }

  private async image(index: number) {
    const meta = await this.readMeta()
    const info = meta?.images?.[index]
    if (!meta || !info) return new Response('Not Found', { status: 404 })

    const chunks: string[] = []
    for (let i = 0; i < info.bytes; i += 1) {
      const chunk = await this.state.storage.get<string>(`image:${index}:${i}`)
      if (chunk) chunks.push(chunk)
    }
    const binary = atob(chunks.join(''))
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)

    return new Response(bytes, {
      headers: {
        'Content-Type': info.mime,
        'Cache-Control': 'private, max-age=86400',
        'Content-Disposition': `inline; filename="image-${index + 1}.${info.mime.split('/')[1] || 'png'}"`,
      },
    })
  }

  /** 由 alarm 触发：真正调用上游，失败按退避重试 */
  async alarm() {
    const meta = await this.readMeta()
    if (!meta || meta.status === 'completed' || meta.status === 'failed') return

    const protocol = meta.protocol || 'openai'
    const base = getUpstreamBase(this.env, protocol)
    if (!base) return this.fail(protocol === 'agnes' ? '服务端未配置 Agnes API 地址' : '服务端未配置上游 API 地址')

    meta.status = 'running'
    meta.attempts += 1
    await this.state.storage.put('meta', meta)

    try {
      let body = await this.readBody(meta)
      let contentType = meta.contentType
      let path = meta.upstreamPath
      if (protocol === 'agnes') {
        const rewritten = await rewriteAgnesRequest(body, contentType, readEnv(this.env.AGNES_IMAGE_MODEL) || 'agnes-image-2.5-flash')
        body = new Uint8Array(rewritten.body)
        contentType = rewritten.contentType
        path = rewritten.path
      }

      const headers = new Headers()
      headers.set('Content-Type', contentType)
      headers.set('Accept', meta.accept)
      Object.entries(buildUpstreamAuth(this.env, protocol)).forEach(([name, value]) => headers.set(name, value))

      const response = await fetch(`${base}/${path}`, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(getRequestTimeout(this.env)),
      })

      const text = await response.text()
      if (!response.ok) {
        throw new Error(`上游返回 HTTP ${response.status}：${text.slice(0, 300)}`)
      }

      let payload: unknown
      try {
        payload = JSON.parse(text)
      } catch {
        throw new Error(`上游返回的不是 JSON：${text.slice(0, 200)}`)
      }

      const fallbackMime = meta.contentType.includes('json') && text.includes('"output_format":"webp"') ? 'image/webp' : 'image/png'
      const images = protocol === 'agnes'
        ? await collectAgnesImages(payload, fallbackMime)
        : extractImages(payload, fallbackMime)
      if (!images.length) {
        throw new Error(`上游没有返回可识别的图片：${text.slice(0, 200)}`)
      }

      const saved: Array<{ mime: string; bytes: number }> = []
      for (let index = 0; index < images.length; index += 1) {
        const { mime, base64 } = images[index]
        const count = Math.max(1, Math.ceil(base64.length / CHUNK_SIZE))
        for (let i = 0; i < count; i += 1) {
          await this.state.storage.put(`image:${index}:${i}`, base64.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE))
        }
        saved.push({ mime, bytes: count })
      }

      meta.status = 'completed'
      meta.images = saved
      meta.error = undefined
      await this.state.storage.put('meta', meta)
      await this.cleanupPayload(meta)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const delay = RETRY_DELAYS_MS[meta.attempts - 1]
      if (meta.attempts < getAttemptLimit(this.env) && delay !== undefined) {
        meta.status = 'pending'
        meta.error = message
        await this.state.storage.put('meta', meta)
        await this.state.storage.setAlarm(Date.now() + delay)
        return
      }
      await this.fail(message)
    }
  }

  private async fail(message: string) {
    const meta = await this.readMeta()
    if (!meta) return
    meta.status = 'failed'
    meta.error = message
    await this.state.storage.put('meta', meta)
    await this.cleanupPayload(meta)
  }

  /** 任务结束后删掉请求体分片，图片本身保留供前端下载 */
  private async cleanupPayload(meta: JobMeta) {
    for (let i = 0; i < meta.chunkCount; i += 1) {
      await this.state.storage.delete(`chunk:${i}`)
    }
  }
}
