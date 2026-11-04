/**
 * 服务端模式：部署到带 Worker 的 Cloudflare Worker 后，上游 API 地址和 Key 都由服务端保管。
 * 运行期配置在页面启动前从 `/api/server-config` 读取并缓存，未配置服务端时接口返回 404，
 * 这里静默退化为纯静态部署（保持原有“密钥保存在浏览器”的行为）。
 */

export interface ServerConfig {
  serverMode: boolean
  passwordRequired: boolean
  apiProxyAvailable: boolean
  apiProxyLocked: boolean
  /** 部署端启用了后台任务：长耗时生成不占用浏览器连接，失败还会自动重试 */
  backgroundJobs: boolean
  /** 部署端建议的默认模型 ID，留空时前端使用内置默认值 */
  model?: string
  agnesModel?: string
  openaiEnabled?: boolean
  agnesEnabled?: boolean
}

/** 服务端模式下前端使用的占位 Key，请求会经 Worker 转发，实际鉴权由服务端注入 */
export const SERVICE_MANAGED_API_KEY = 'server-managed'
/** 服务端代理路径，落在 Worker 的 /api/* 路由里 */
export const SERVER_PROXY_PREFIX = '/api/proxy'

const STORAGE_KEY = 'gpt-image-server-config'
const TOKEN_STORAGE_KEY = 'gpt-image-server-token'
const CONFIG_ENDPOINT = '/api/server-config'
const SESSION_ENDPOINT = '/api/session'
const SERVER_PROFILE_ID = 'default-openai'
const SERVER_AGNES_PROFILE_ID = 'default-agnes'
const SERVER_PROFILE_NAME = '部署端配置'
const SERVER_AGNES_PROFILE_NAME = 'Agnes Image'
const SERVER_PROFILE_MODEL = 'gpt-image-1'
const SERVER_AGNES_PROFILE_MODEL = 'agnes-image-2.5-flash'

let cached: ServerConfig | null = readCachedConfig()

function readCachedConfig(): ServerConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? normalizeServerConfig(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

function writeStorage(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* 隐私模式下写入失败时忽略，本次会话仍按内存里的配置运行 */
  }
}

function normalizeServerConfig(input: unknown): ServerConfig | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  if (record.serverMode !== true) return null
  return {
    serverMode: true,
    passwordRequired: record.passwordRequired === true,
    apiProxyAvailable: record.apiProxyAvailable !== false,
    apiProxyLocked: record.apiProxyLocked !== false,
    backgroundJobs: record.backgroundJobs === true,
    openaiEnabled: record.openaiEnabled !== false,
    agnesEnabled: record.agnesEnabled === true,
    ...(typeof record.model === 'string' && record.model.trim() ? { model: record.model.trim() } : {}),
    ...(typeof record.agnesModel === 'string' && record.agnesModel.trim() ? { agnesModel: record.agnesModel.trim() } : {}),
  }
}

/** 启动时调用一次；请求失败（纯静态部署）时返回 null，且不再重试 */
export async function loadServerConfig(): Promise<ServerConfig | null> {
  try {
    const response = await fetch(CONFIG_ENDPOINT, { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const config = normalizeServerConfig(await response.json())
    cached = config
    writeStorage(STORAGE_KEY, config ? JSON.stringify(config) : null)
    return config
  } catch (err) {
    console.warn('读取服务端配置失败，按纯静态部署运行：', err)
    cached = null
    writeStorage(STORAGE_KEY, null)
    writeStorage(TOKEN_STORAGE_KEY, null)
    return null
  }
}

export function getServerConfig(): ServerConfig | null {
  return cached
}

export function isServerMode(): boolean {
  return Boolean(cached?.serverMode)
}

export function clearServerSession() {
  cached = null
  writeStorage(STORAGE_KEY, null)
  writeStorage(TOKEN_STORAGE_KEY, null)
}

export function getServerToken() {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY) ?? ''
  } catch {
    return ''
  }
}

export async function submitAccessPassword(password: string) {
  const response = await fetch(SESSION_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
    cache: 'no-store',
  })
  const payload = await response.json().catch(() => ({})) as { ok?: boolean; token?: string; error?: { message?: string } }
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error?.message || `验证失败（HTTP ${response.status}）`)
  }
  if (payload.token) {
    try {
      localStorage.setItem(TOKEN_STORAGE_KEY, payload.token)
    } catch {
      /* 写入失败时只依赖 Cookie */
    }
  }
  return true
}

/** 服务端模式下提交时要求的“API Key”只是占位值，用于通过前端完整性检查 */
export function isServerManagedKey(apiKey: string) {
  return apiKey === SERVICE_MANAGED_API_KEY
}

/** 服务端模式下是否需要先验证访问口令（Cookie 或本地令牌仍有效时不打扰用户） */
export async function isAccessPasswordSatisfied() {
  if (!cached?.passwordRequired) return true
  try {
    const response = await fetch(SESSION_ENDPOINT, { cache: 'no-store' })
    return response.ok
  } catch {
    return false
  }
}

/** 部署端启用了后台任务时，客户端改用「提交任务 → 轮询」的异步协议 */
export function isBackgroundJobsEnabled() {
  return Boolean(cached?.backgroundJobs)
}

/**
 * 服务端模式下的预置配置：API 配置全部来自部署端，前端只保留一个占位配置，
 * 用户无需也无法填写地址与密钥。地址留空，因为代理开启时地址不参与拼接。
 */
export function isAgnesServerProfile(profileId?: string) {
  return profileId === SERVER_AGNES_PROFILE_ID
}

export function createServerPresetConfig(config?: Pick<ServerConfig, 'model' | 'agnesModel' | 'openaiEnabled' | 'agnesEnabled'> | string) {
  const resolved = typeof config === 'string' || config === undefined
    ? { model: config, openaiEnabled: true, agnesEnabled: false }
    : config
  const openaiEnabled = resolved.openaiEnabled !== false
  const agnesEnabled = resolved.agnesEnabled === true
  const openaiModel = resolved.model?.trim() || SERVER_PROFILE_MODEL
  const agnesModel = resolved.agnesModel?.trim() || SERVER_AGNES_PROFILE_MODEL
  const profiles = [
    ...(openaiEnabled ? [{
      id: SERVER_PROFILE_ID,
      name: SERVER_PROFILE_NAME,
      provider: 'openai' as const,
      baseUrl: '',
      apiKey: SERVICE_MANAGED_API_KEY,
      model: openaiModel,
      imageGenerationModel: openaiModel,
      timeout: 600,
      apiMode: 'images' as const,
      apiProxy: true,
      codexCli: false,
      transparentBackgroundMethod: 'api' as const,
      isDefault: true,
    }] : []),
    ...(agnesEnabled ? [{
      id: SERVER_AGNES_PROFILE_ID,
      name: SERVER_AGNES_PROFILE_NAME,
      provider: 'openai' as const,
      baseUrl: '',
      apiKey: SERVICE_MANAGED_API_KEY,
      model: agnesModel,
      imageGenerationModel: agnesModel,
      timeout: 600,
      apiMode: 'images' as const,
      apiProxy: true,
      codexCli: false,
      transparentBackgroundMethod: 'api' as const,
      isDefault: !openaiEnabled,
    }] : []),
  ]
  return { customProviders: [], profiles }
}
