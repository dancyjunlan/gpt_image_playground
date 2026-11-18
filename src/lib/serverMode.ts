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
  /** secret 渠道模型，留空时沿用 model */
  secretModel?: string
  openaiEnabled?: boolean
  agnesEnabled?: boolean
  secretEnabled?: boolean
  /** 部署端允许在设置页输入密码后切换浏览器直连 */
  directAccessAvailable?: boolean
}

/** 直连模式下浏览器保存的上游凭据，仅在本机 localStorage 中 */
export interface DirectCredentials {
  protocol: 'openai' | 'agnes' | 'secret'
  baseUrl: string
  apiKey: string
  authHeader: 'bearer' | 'apikey'
}

/** 服务端模式下前端使用的占位 Key，请求会经 Worker 转发，实际鉴权由服务端注入 */
export const SERVICE_MANAGED_API_KEY = 'server-managed'
/** 服务端代理路径，落在 Worker 的 /api/* 路由里 */
export const SERVER_PROXY_PREFIX = '/api/proxy'

const STORAGE_KEY = 'gpt-image-server-config'
const TOKEN_STORAGE_KEY = 'gpt-image-server-token'
const DIRECT_STORAGE_KEY = 'gpt-image-direct-credentials'
const CONFIG_ENDPOINT = '/api/server-config'
const SESSION_ENDPOINT = '/api/session'
const DIRECT_ENDPOINT = '/api/direct-credentials'
const SERVER_PROFILE_ID = 'default-openai'
const SERVER_AGNES_PROFILE_ID = 'default-agnes'
const SERVER_SECRET_PROFILE_ID = 'default-secret'
const SERVER_DIRECT_PROFILE_ID = 'default-direct'
const SERVER_PROFILE_NAME = '部署端配置'
const SERVER_AGNES_PROFILE_NAME = 'Agnes Image'
const SERVER_SECRET_PROFILE_NAME = 'secret'
const SERVER_DIRECT_PROFILE_NAME = '直连（本机密钥）'
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
    secretEnabled: record.secretEnabled === true,
    directAccessAvailable: record.directAccessAvailable === true,
    ...(typeof record.model === 'string' && record.model.trim() ? { model: record.model.trim() } : {}),
    ...(typeof record.agnesModel === 'string' && record.agnesModel.trim() ? { agnesModel: record.agnesModel.trim() } : {}),
    ...(typeof record.secretModel === 'string' && record.secretModel.trim() ? { secretModel: record.secretModel.trim() } : {}),
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

/** 部署端是否允许切换直连 */
export function isDirectAccessAvailable() {
  return Boolean(cached?.directAccessAvailable)
}

export function getDirectCredentials(): DirectCredentials | null {
  try {
    const raw = localStorage.getItem(DIRECT_STORAGE_KEY)
    if (!raw) return null
    const record = JSON.parse(raw) as Partial<DirectCredentials>
    if (typeof record.baseUrl !== 'string' || !record.baseUrl.trim()) return null
    if (typeof record.apiKey !== 'string' || !record.apiKey.trim()) return null
    return {
      protocol: record.protocol === 'agnes' || record.protocol === 'secret' ? record.protocol : 'openai',
      baseUrl: record.baseUrl.trim(),
      apiKey: record.apiKey.trim(),
      authHeader: record.authHeader === 'apikey' ? 'apikey' : 'bearer',
    }
  } catch {
    return null
  }
}

/** 输入直连密码，验证通过后把上游凭据保存在本机，并返回它 */
export async function unlockDirectAccess(password: string, protocol: 'openai' | 'agnes' | 'secret' = 'openai') {
  const response = await fetch(DIRECT_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password, protocol }),
    cache: 'no-store',
  })
  const payload = await response.json().catch(() => ({})) as Partial<DirectCredentials> & { ok?: boolean; error?: { message?: string } }
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error?.message || `验证失败（HTTP ${response.status}）`)
  }
  if (!payload.baseUrl || !payload.apiKey) throw new Error('部署端没有返回可用的上游凭据')

  const credentials: DirectCredentials = {
    protocol: payload.protocol === 'agnes' || payload.protocol === 'secret' ? payload.protocol : 'openai',
    baseUrl: payload.baseUrl,
    apiKey: payload.apiKey,
    authHeader: payload.authHeader === 'apikey' ? 'apikey' : 'bearer',
  }
  writeStorage(DIRECT_STORAGE_KEY, JSON.stringify(credentials))
  return credentials
}

/** 退出直连，浏览器里保存的凭据一并清除 */
export function lockDirectAccess() {
  writeStorage(DIRECT_STORAGE_KEY, null)
}

export function isDirectServerProfile(profileId?: string) {
  return profileId === SERVER_DIRECT_PROFILE_ID
}

/**
 * 服务端模式下的预置配置：API 配置全部来自部署端，前端只保留一个占位配置，
 * 用户无需也无法填写地址与密钥。地址留空，因为代理开启时地址不参与拼接。
 */
export function isAgnesServerProfile(profileId?: string) {
  return profileId === SERVER_AGNES_PROFILE_ID
}

export function isSecretServerProfile(profileId?: string) {
  return profileId === SERVER_SECRET_PROFILE_ID
}

export function createServerPresetConfig(config?: Pick<ServerConfig, 'model' | 'agnesModel' | 'secretModel' | 'openaiEnabled' | 'agnesEnabled' | 'secretEnabled'> | string) {
  const resolved = typeof config === 'string' || config === undefined
    ? { model: config, openaiEnabled: true, agnesEnabled: false, secretEnabled: false }
    : config
  const openaiEnabled = resolved.openaiEnabled !== false
  const agnesEnabled = resolved.agnesEnabled === true
  const secretEnabled = resolved.secretEnabled === true
  const openaiModel = resolved.model?.trim() || SERVER_PROFILE_MODEL
  const agnesModel = resolved.agnesModel?.trim() || SERVER_AGNES_PROFILE_MODEL
  // secret 渠道和渠道 1 同模型，留空时直接复用
  const secretModel = resolved.secretModel?.trim() || openaiModel
  // 只有本机存过直连凭据，才下发直连配置
  const direct = getDirectCredentials()
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
    ...(secretEnabled ? [{
      id: SERVER_SECRET_PROFILE_ID,
      name: SERVER_SECRET_PROFILE_NAME,
      provider: 'openai' as const,
      baseUrl: '',
      apiKey: SERVICE_MANAGED_API_KEY,
      model: secretModel,
      imageGenerationModel: secretModel,
      timeout: 600,
      apiMode: 'images' as const,
      apiProxy: true,
      codexCli: false,
      transparentBackgroundMethod: 'api' as const,
      isDefault: !openaiEnabled && !agnesEnabled,
    }] : []),
    // 已验证直连密码时，额外给出一条带真实地址和密钥的配置：请求由浏览器直接发往上游
    ...(direct ? [{
      id: SERVER_DIRECT_PROFILE_ID,
      name: SERVER_DIRECT_PROFILE_NAME,
      provider: 'openai' as const,
      baseUrl: direct.baseUrl,
      apiKey: direct.apiKey,
      model: direct.protocol === 'agnes' ? agnesModel : openaiModel,
      imageGenerationModel: direct.protocol === 'agnes' ? agnesModel : openaiModel,
      timeout: 600,
      apiMode: 'images' as const,
      apiProxy: false,
      codexCli: false,
      transparentBackgroundMethod: 'api' as const,
      isDefault: false,
    }] : []),
  ]
  return { customProviders: [], profiles }
}
