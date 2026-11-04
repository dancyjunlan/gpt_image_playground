/**
 * Grok Imagine Image（Roko / NewAPI 图像任务协议）。
 *
 * 只有 grok-imagine-image-* 走这条路，普通 grok 聊天模型仍用标准 generations。
 * 提交 POST /v1/images/tasks，再轮询 GET /v1/tasks/{task_id}。
 * size 只能是比例，resolution 为 1K/2K；参考图必须是公网 URL，不能是 data URI。
 */

const RATIOS = [
  { key: '1:1', value: 1 },
  { key: '3:4', value: 3 / 4 },
  { key: '4:3', value: 4 / 3 },
  { key: '16:9', value: 16 / 9 },
  { key: '9:16', value: 9 / 16 },
  { key: '2:3', value: 2 / 3 },
  { key: '3:2', value: 3 / 2 },
  { key: '21:9', value: 21 / 9 },
] as const

export function isGrokImagineModel(model: unknown) {
  return typeof model === 'string' && /grok-imagine-image/i.test(model.trim())
}

export function mapGrokImagineSize(size: unknown): { size: string; resolution: '1K' | '2K' } {
  if (typeof size === 'string' && size.trim().toLowerCase() === 'auto') {
    return { size: 'auto', resolution: '1K' }
  }
  if (typeof size === 'string' && RATIOS.some((item) => item.key === size.trim())) {
    return { size: size.trim(), resolution: '1K' }
  }

  const trimmed = typeof size === 'string' ? size.trim() : ''
  const match = trimmed.match(/^(\d+)\s*[xX×]\s*(\d+)$/)
  if (!match) return { size: '1:1', resolution: '1K' }

  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { size: '1:1', resolution: '1K' }
  }

  const maxEdge = Math.max(width, height)
  const pixels = width * height
  const resolution: '1K' | '2K' = maxEdge >= 1600 || pixels >= 1_800_000 ? '2K' : '1K'

  const target = width / height
  let best: (typeof RATIOS)[number] = RATIOS[0]
  let bestDelta = Math.abs(Math.log(target / best.value))
  for (const ratio of RATIOS) {
    const delta = Math.abs(Math.log(target / ratio.value))
    if (delta < bestDelta) {
      best = ratio
      bestDelta = delta
    }
  }
  return { size: best.key, resolution }
}

export function mapGrokImagineQuality(quality: unknown): 'low' | 'medium' {
  const value = typeof quality === 'string' ? quality.trim().toLowerCase() : ''
  return value === 'low' ? 'low' : 'medium'
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function bytesToDataUrl(bytes: Uint8Array, mime: string) {
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return `data:${mime || 'image/png'};base64,${btoa(binary)}`
}

async function fileToBytes(value: unknown): Promise<{ bytes: Uint8Array; mime: string } | null> {
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return { bytes: new Uint8Array(await value.arrayBuffer()), mime: value.type || 'image/png' }
  }
  if (typeof value === 'string' && value.startsWith('data:')) {
    const match = value.match(/^data:([^;]+);base64,(.+)$/)
    if (!match) return null
    const binary = atob(match[2])
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
    return { bytes, mime: match[1] || 'image/png' }
  }
  return null
}

export async function peekRequestModel(body: Uint8Array, contentType: string): Promise<string> {
  const type = contentType.toLowerCase()
  if (type.includes('multipart/form-data')) {
    const request = new Request('https://grok.local/peek', {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
    })
    const form = await request.formData()
    return String(form.get('model') || '')
  }
  try {
    const payload = asRecord(JSON.parse(new TextDecoder().decode(body)))
    return typeof payload?.model === 'string' ? payload.model : ''
  } catch {
    return ''
  }
}

export type GrokImagineRewrite = {
  body: Uint8Array
  contentType: string
  path: string
  inputs: Array<{ bytes: Uint8Array; mime: string }>
}

export async function rewriteGrokImagineRequest(
  body: Uint8Array,
  contentType: string,
  publicOrigin: string,
  jobId: string,
): Promise<GrokImagineRewrite> {
  const type = contentType.toLowerCase()
  let payload: Record<string, unknown> = {}
  const inputs: Array<{ bytes: Uint8Array; mime: string }> = []
  const urls: string[] = []

  const takeUrl = (value: unknown) => {
    if (typeof value === 'string' && /^https?:\/\//i.test(value.trim())) urls.push(value.trim())
  }

  if (type.includes('multipart/form-data')) {
    const request = new Request('https://grok.local/images/tasks', {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
    })
    const form = await request.formData()
    payload = {
      model: String(form.get('model') || ''),
      prompt: String(form.get('prompt') || ''),
      size: String(form.get('size') || '1:1'),
      quality: String(form.get('quality') || 'medium'),
      n: form.get('n') ? Number(form.get('n')) : 1,
    }
    for (const key of ['image[]', 'image', 'images', 'image_urls']) {
      for (const item of form.getAll(key)) {
        if (typeof item === 'string') takeUrl(item)
        else {
          const file = await fileToBytes(item)
          if (file) inputs.push(file)
        }
      }
    }
  } else {
    payload = asRecord(JSON.parse(new TextDecoder().decode(body))) ?? {}
    const extra = asRecord(payload.extra_body)
    const candidates = [payload.image_urls, payload.images, payload.image, extra?.image, extra?.image_urls]
    for (const candidate of candidates) {
      const list = Array.isArray(candidate) ? candidate : candidate ? [candidate] : []
      for (const item of list) {
        takeUrl(item)
        const file = await fileToBytes(item)
        if (file) inputs.push(file)
      }
    }
  }

  const mapped = mapGrokImagineSize(payload.size)
  const hosted = inputs.slice(0, 3).map((_, index) => `${publicOrigin.replace(/\/+$/, '')}/api/jobs/${jobId}/input/${index}`)
  const imageUrls = [...urls, ...hosted].slice(0, 3)
  const next: Record<string, unknown> = {
    model: typeof payload.model === 'string' ? payload.model.trim() : '',
    prompt: typeof payload.prompt === 'string' ? payload.prompt : '',
    size: mapped.size,
    resolution: mapped.resolution,
    quality: mapGrokImagineQuality(payload.quality),
  }
  const n = Number(payload.n)
  if (Number.isFinite(n) && n > 1) next.n = Math.min(10, Math.trunc(n))
  if (imageUrls.length) next.image_urls = imageUrls

  return {
    body: new TextEncoder().encode(JSON.stringify(next)),
    contentType: 'application/json',
    path: 'images/tasks',
    inputs: inputs.slice(0, 3),
  }
}

export function readGrokTaskId(payload: unknown) {
  const record = asRecord(payload) ?? {}
  const nested = asRecord(record.data)
  const taskId = record.task_id ?? record.id ?? nested?.task_id ?? nested?.id
  return typeof taskId === 'string' && taskId.trim() ? taskId.trim() : ''
}

export function readGrokTaskState(payload: unknown) {
  const record = asRecord(payload) ?? {}
  const state = typeof record.state === 'string' ? record.state : typeof record.status === 'string' ? record.status : ''
  return state.trim().toLowerCase()
}

export function readGrokTaskError(payload: unknown) {
  const record = asRecord(payload) ?? {}
  const error = asRecord(record.error)
  const message = error?.message ?? record.fail_reason ?? record.error
  return typeof message === 'string' && message.trim() ? message.trim() : 'Grok 图像任务失败'
}

function collectUrls(payload: unknown): string[] {
  const record = asRecord(payload) ?? {}
  const urls: string[] = []
  const take = (value: unknown) => {
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) urls.push(value)
  }
  take(record.result_url)
  const assets = Array.isArray(record.assets) ? record.assets : []
  for (const asset of assets) {
    const item = asRecord(asset)
    take(item?.url)
  }
  const data = record.data
  if (Array.isArray(data)) {
    for (const item of data) {
      const entry = asRecord(item)
      take(entry?.url)
      const results = Array.isArray(entry?.results) ? entry.results : []
      for (const result of results) take(asRecord(result)?.url ?? result)
    }
  } else {
    const nested = asRecord(data)
    const results = Array.isArray(nested?.results) ? nested.results : []
    for (const result of results) take(asRecord(result)?.url ?? result)
    take(nested?.url)
    take(nested?.result_url)
  }
  return Array.from(new Set(urls))
}

export async function pollGrokImagineTask(
  base: string,
  taskId: string,
  headers: Headers,
  timeoutMs: number,
): Promise<unknown> {
  const deadline = Date.now() + timeoutMs
  let last: unknown = null
  while (Date.now() < deadline) {
    const response = await fetch(`${base}/tasks/${encodeURIComponent(taskId)}`, {
      headers,
      cache: 'no-store',
      signal: AbortSignal.timeout(Math.min(30_000, Math.max(1000, deadline - Date.now()))),
    })
    const text = await response.text()
    if (!response.ok) throw new Error(`查询 Grok 任务失败 HTTP ${response.status}：${text.slice(0, 300)}`)
    try {
      last = JSON.parse(text)
    } catch {
      throw new Error(`Grok 任务状态不是 JSON：${text.slice(0, 200)}`)
    }
    const state = readGrokTaskState(last)
    if (state === 'completed' || state === 'success' || state === 'succeeded') return last
    if (state === 'failed' || state === 'error' || state === 'cancelled') {
      throw new Error(readGrokTaskError(last))
    }
    await new Promise((resolve) => setTimeout(resolve, 2500))
  }
  throw new Error('等待 Grok 图像任务超时')
}

export async function collectGrokImagineImages(payload: unknown, fallbackMime: string): Promise<Array<{ mime: string; base64: string }>> {
  const images: Array<{ mime: string; base64: string }> = []
  for (const url of collectUrls(payload)) {
    const response = await fetch(url, { cache: 'no-store' })
    if (!response.ok) throw new Error(`无法下载 Grok 图片（HTTP ${response.status}）`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const mime = response.headers.get('Content-Type')?.split(';')[0] || fallbackMime
    images.push({ mime, base64: bytesToDataUrl(bytes, mime).replace(/^data:[^;]+;base64,/, '') })
  }
  return images
}
