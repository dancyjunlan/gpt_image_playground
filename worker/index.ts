/// <reference lib="es2022" />
/**
 * Cloudflare Worker 服务端：静态资源由 assets 直接返回，这里只处理 /api/* 请求。
 *
 * - GET  /api/server-config  前端启动时读取的运行期配置（不含任何密钥）
 * - POST /api/session        校验访问口令，成功时下发 HttpOnly 令牌 Cookie
 * - ALL  /api/proxy/*        转发到 UPSTREAM_BASE_URL，并在服务端注入上游 API Key
 *
 * 上游 API Key 只存在于 Worker 的环境变量中，不会出现在前端代码或响应里。
 */

interface Env {
  ASSETS: { fetch: (request: Request) => Promise<Response> }
  IMAGE_JOBS: DurableObjectNamespace
  UPSTREAM_BASE_URL: string
  UPSTREAM_API_KEY?: string
  UPSTREAM_AUTH_HEADER?: string
  DEFAULT_IMAGE_MODEL?: string
  ACCESS_PASSWORD?: string
  PROXY_TIMEOUT_MS?: string
  JOB_MAX_ATTEMPTS?: string
}

type UpstreamAuth = 'bearer' | 'apikey' | 'basic' | 'none'

const PROXY_PREFIX = '/api/proxy/'
const JOBS_PREFIX = '/api/jobs'
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60
const CLOCK_SKEW_SECONDS = 60
const SESSION_COOKIE = 'gip_session'

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  })

const readEnv = (value: string | undefined) => String.prototype.trim.call(value ?? '')

function getUpstreamBase(env: Env) {
  const raw = readEnv(env.UPSTREAM_BASE_URL)
  if (!raw) return null
  const withScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(raw) ? raw : `https://${raw}`
  const url = new URL(withScheme)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  return url.toString().replace(/\/+$/, '')
}

function getAuthHeader(env: Env): UpstreamAuth {
  const value = readEnv(env.UPSTREAM_AUTH_HEADER).toLowerCase()
  return value === 'apikey' || value === 'basic' || value === 'none' ? value : 'bearer'
}

function buildUpstreamAuth(env: Env): Record<string, string> {
  const key = readEnv(env.UPSTREAM_API_KEY)
  if (!key) return {}
  switch (getAuthHeader(env)) {
    case 'apikey':
      return { 'X-Api-Key': key }
    case 'basic':
      return { Authorization: `Basic ${key}` }
    case 'none':
      return {}
    default:
      return { Authorization: `Bearer ${key}` }
  }
}

function isServerConfig(env: Env) {
  return Boolean(getUpstreamBase(env))
}

function getPublicConfig(env: Env) {
  const serverMode = isServerConfig(env)
  return {
    serverMode,
    // 只有服务端模式（有上游地址）才需要口令；否则是纯静态部署，接口全部不可用
    passwordRequired: serverMode && Boolean(readEnv(env.ACCESS_PASSWORD)),
    apiProxyAvailable: serverMode,
    apiProxyLocked: serverMode,
    // 后台任务模式下浏览器不保持长连接，由 Durable Object 跑完再取结果
    backgroundJobs: serverMode && Boolean(env.IMAGE_JOBS),
    model: readEnv(env.DEFAULT_IMAGE_MODEL) || undefined,
  }
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const toBase64Url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

async function importHmacKey(secret: string) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  )
}

/** 令牌是无状态签名串，密钥由访问口令派生，改口令即可让旧令牌全部失效 */
async function createSessionToken(password: string, expiresAt: number) {
  const key = await importHmacKey(`session:${password}`)
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(String(expiresAt)))
  return `${expiresAt}.${toBase64Url(signature)}`
}

function readCookie(request: Request, name: string) {
  const header = request.headers.get('Cookie')
  if (!header) return ''
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx < 0) continue
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim()
  }
  return ''
}

function readSessionToken(request: Request) {
  const header = readEnv(request.headers.get('X-Session-Token') ?? undefined)
  return header || readCookie(request, SESSION_COOKIE)
}

async function verifySession(request: Request, env: Env) {
  const password = readEnv(env.ACCESS_PASSWORD)
  if (!password) return true

  const token = readSessionToken(request)
  const [expiresRaw, signature] = token.split('.')
  if (!expiresRaw || !signature) return false

  const expiresAt = Number(expiresRaw)
  if (!Number.isFinite(expiresAt)) return false
  const now = Math.floor(Date.now() / 1000)
  if (expiresAt + CLOCK_SKEW_SECONDS < now) return false

  const key = await importHmacKey(`session:${password}`)
  return crypto.subtle.verify(
    'HMAC',
    key,
    Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0)),
    new TextEncoder().encode(String(expiresAt)),
  )
}

function getProxyTimeout(env: Env) {
  const value = Number(readEnv(env.PROXY_TIMEOUT_MS))
  return Number.isFinite(value) && value >= 1000 ? value : 600_000
}

/** 浏览器侧的 Authorization 一律丢掉，由服务端按环境变量重新注入 */
function buildProxyHeaders(request: Request, env: Env) {
  const headers = new Headers()
  const contentType = request.headers.get('Content-Type')
  const accept = request.headers.get('Accept')
  if (contentType) headers.set('Content-Type', contentType)
  if (accept) headers.set('Accept', accept)
  Object.entries(buildUpstreamAuth(env)).forEach(([name, value]) => headers.set(name, value))
  return headers
}

function buildProxyResponse(upstream: Response) {
  const headers = new Headers()
  for (const name of ['Content-Type', 'Content-Disposition', 'X-Request-Id']) {
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }
  // 流式透传响应体：图片既可能是 b64_json，也可能是 SSE 分片，不在这里解析
  return new Response(upstream.body, { status: upstream.status, headers })
}

async function handleProxy(request: Request, env: Env) {
  const base = getUpstreamBase(env)
  if (!base) return json({ error: { message: '服务端未配置上游 API 地址，请设置 UPSTREAM_BASE_URL' } }, 503)

  const url = new URL(request.url)
  const path = url.pathname.slice(PROXY_PREFIX.length)
  if (!path) return json({ error: { message: '缺少上游接口路径' } }, 400)

  const target = `${base}/${path}${url.search}`
  // 上游生成时间通常远长于普通接口，这里只做上限保护，超时按网关错误返回
  const timeout = getProxyTimeout(env)
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(new Error(`上游请求超过 ${timeout / 1000} 秒`)), timeout)

  const init: RequestInit & { duplex?: string } = {
    method: request.method,
    headers: buildProxyHeaders(request, env),
    signal: controller.signal,
    redirect: 'follow',
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = request.body
    init.duplex = 'half'
  }

  try {
    const upstream = await fetch(target, init as RequestInit)
    return buildProxyResponse(upstream)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const aborted = controller.signal.aborted
    return json(
      { error: { message: aborted ? `上游请求超过 ${timeout / 1000} 秒已中断：${message}` : `无法连接上游接口：${message}` } },
      aborted ? 504 : 502,
    )
  } finally {
    clearTimeout(timeoutId)
  }
}

async function handleSession(request: Request, env: Env) {
  if (request.method === 'GET') {
    // 供前端静默检查已有 Cookie 是否仍然有效
    const ok = await verifySession(request, env)
    return json({ ok }, ok ? 200 : 401)
  }
  if (request.method !== 'POST') return json({ error: { message: '请使用 POST' } }, 405)

  const password = readEnv(env.ACCESS_PASSWORD)
  if (!password) return json({ ok: true })

  let submitted = ''
  try {
    const payload = (await request.json()) as { password?: unknown }
    submitted = typeof payload?.password === 'string' ? payload.password : ''
  } catch {
    submitted = ''
  }
  if (!submitted) return json({ ok: false, error: { message: '请输入访问口令' } }, 400)

  const [expected, actual] = await Promise.all([sha256Hex(password), sha256Hex(submitted)])
  if (expected !== actual) return json({ ok: false, error: { message: '访问口令不正确' } }, 401)

  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS
  const token = await createSessionToken(password, expiresAt)
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : ''
  return json({ ok: true, token, expiresAt }, 200, {
    'Set-Cookie': `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure}`,
  })
}

/** 创建后台任务：请求体交给 Durable Object 保存，立即返回任务 ID */
async function handleCreateJob(request: Request, env: Env) {
  if (request.method !== 'POST') return json({ error: { message: '请使用 POST' } }, 405)

  const url = new URL(request.url)
  const upstream = url.searchParams.get('upstream') ?? 'images/generations'
  if (!/^[\w./-]+$/.test(upstream)) return json({ error: { message: '上游路径不合法' } }, 400)

  const id = crypto.randomUUID()
  const stub = env.IMAGE_JOBS.get(env.IMAGE_JOBS.idFromName(id))
  const target = new URL(`https://job.internal/?action=start&job=${encodeURIComponent(id)}&upstream=${encodeURIComponent(upstream)}&origin=${encodeURIComponent(url.origin)}`)

  const init: RequestInit & { duplex?: string } = {
    method: 'POST',
    headers: {
      'X-Upstream-Content-Type': request.headers.get('Content-Type') || 'application/json',
      'X-Upstream-Accept': request.headers.get('Accept') || 'application/json',
    },
    body: request.body,
    duplex: 'half',
  }
  const started = await stub.fetch(target.toString(), init as RequestInit)
  if (!started.ok) return json({ error: { message: '创建后台任务失败' } }, 502)
  return json({ id, status: 'pending' }, 202)
}

async function handleJob(request: Request, env: Env, jobId: string) {
  const url = new URL(request.url)
  const action = url.pathname.endsWith('/image') ? 'image' : 'status'
  const stub = env.IMAGE_JOBS.get(env.IMAGE_JOBS.idFromName(jobId))
  const target = `https://job.internal/?action=${action}${url.search ? `&${url.search.slice(1)}` : ''}`
  const upstream = await stub.fetch(target)
  // 图片响应直接透传，状态响应补上缓存控制
  if (action === 'image') return upstream
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/api/server-config') {
      if (request.method !== 'GET') return json({ error: { message: '请使用 GET' } }, 405)
      return json(getPublicConfig(env))
    }

    if (url.pathname === '/api/session') return handleSession(request, env)

    if (url.pathname === JOBS_PREFIX || url.pathname.startsWith(`${JOBS_PREFIX}/`)) {
      if (!(await verifySession(request, env))) {
        return json({ error: { message: '访问口令已失效，请刷新页面重新验证' } }, 401)
      }
      if (url.pathname === JOBS_PREFIX || url.pathname === `${JOBS_PREFIX}/`) return handleCreateJob(request, env)

      const rest = url.pathname.slice(JOBS_PREFIX.length + 1)
      const [jobId] = rest.split('/').filter(Boolean)
      if (!jobId) return json({ error: { message: '缺少任务 ID' } }, 400)
      return handleJob(request, env, jobId)
    }

    if (url.pathname.startsWith(PROXY_PREFIX)) {
      if (!(await verifySession(request, env))) {
        return json({ error: { message: '访问口令已失效，请刷新页面重新验证' } }, 401)
      }
      return handleProxy(request, env)
    }

    if (url.pathname.startsWith('/api/')) {
      return json({ error: { message: '未知的接口' } }, 404)
    }

    return env.ASSETS.fetch(request)
  },
}

export { ImageJob } from './jobs'
