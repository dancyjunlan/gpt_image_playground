import { describe, expect, it, vi } from 'vitest'

import { createServerModeHeaders, buildApiUrl, shouldUseApiProxy } from './devProxy'
import {
  SERVICE_MANAGED_API_KEY,
  createServerPresetConfig,
  getDirectCredentials,
  isDirectModeEnabled,
  isServerManagedKey,
  lockDirectAccess,
  loadServerConfig,
  setDirectModeEnabled,
  unlockDirectAccess,
} from './serverMode'

describe('serverMode', () => {
  it('只把占位 Key 当作服务端托管', () => {
    expect(isServerManagedKey(SERVICE_MANAGED_API_KEY)).toBe(true)
    expect(isServerManagedKey('sk-real')).toBe(false)
  })

  it('生成的预置配置指向同源代理且不含真实密钥', () => {
    const preset = createServerPresetConfig('my-model')
    const profile = preset.profiles[0]
    expect(profile.apiProxy).toBe(true)
    expect(profile.apiKey).toBe(SERVICE_MANAGED_API_KEY)
    expect(profile.model).toBe('my-model')
    expect(profile.isDefault).toBe(true)
  })

  it('Agnes 启用时额外下发独立配置', () => {
    const preset = createServerPresetConfig({
      model: 'gpt-image-1',
      agnesModel: 'agnes-image-2.5-flash',
      openaiEnabled: true,
      agnesEnabled: true,
    })
    expect(preset.profiles.map((profile) => profile.id)).toEqual(['default-openai', 'default-agnes'])
    expect(preset.profiles[1]).toMatchObject({
      name: 'Agnes Image',
      model: 'agnes-image-2.5-flash',
      apiProxy: true,
      apiKey: SERVICE_MANAGED_API_KEY,
    })
  })

  it('secret 渠道启用时追加第三套配置且复用渠道 1 的模型', () => {
    const preset = createServerPresetConfig({
      model: 'gpt-image-2.5-sunburst, grok-imagine-image-2.0',
      agnesModel: 'agnes-image-2.5-flash',
      openaiEnabled: true,
      agnesEnabled: true,
      secretEnabled: true,
    })
    expect(preset.profiles.map((profile) => profile.id)).toEqual([
      'default-openai',
      'default-agnes',
      'default-secret',
    ])
    expect(preset.profiles[2]).toMatchObject({
      name: 'secret',
      model: 'gpt-image-2.5-sunburst, grok-imagine-image-2.0',
      apiProxy: true,
      apiKey: SERVICE_MANAGED_API_KEY,
    })
  })

  it('只有 secret 渠道时它成为默认配置', () => {
    const preset = createServerPresetConfig({
      model: 'gpt-image-2',
      openaiEnabled: false,
      agnesEnabled: false,
      secretEnabled: true,
    })
    expect(preset.profiles).toHaveLength(1)
    expect(preset.profiles[0]).toMatchObject({ id: 'default-secret', isDefault: true })
  })

  it('解锁直连后保存凭据并生成绕开代理的直连配置', async () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) },
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = (() => Promise.resolve(new Response(JSON.stringify({
      ok: true,
      protocol: 'openai',
      baseUrl: 'https://upstream.example.com/v1',
      apiKey: 'sk-direct',
      authHeader: 'bearer',
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))) as typeof fetch
    try {
      const credentials = await unlockDirectAccess('pass', 'openai')
      expect(credentials).toEqual({
        protocol: 'openai',
        baseUrl: 'https://upstream.example.com/v1',
        apiKey: 'sk-direct',
        authHeader: 'bearer',
      })
      expect(getDirectCredentials()?.apiKey).toBe('sk-direct')

      // 直连不再依赖额外配置项，而是由开关控制
      expect(isDirectModeEnabled()).toBe(false)
      setDirectModeEnabled(true)
      expect(isDirectModeEnabled()).toBe(true)

      const preset = createServerPresetConfig({ model: 'gpt-image-1', openaiEnabled: true })
      expect(preset.profiles.some((profile) => profile.id === 'default-direct')).toBe(false)
      // 带真实地址的配置一律不走代理，避免合并后 id 丢失导致又走 Worker
      expect(shouldUseApiProxy(true, null, { baseUrl: 'https://upstream.example.com/v1' })).toBe(false)
      lockDirectAccess()
      expect(getDirectCredentials()).toBeNull()
      expect(isDirectModeEnabled()).toBe(false)
    } finally {
      globalThis.fetch = originalFetch
      vi.unstubAllGlobals()
    }
  })

  it('纯静态部署时读取配置失败并返回 null', async () => {
    const original = globalThis.fetch
    globalThis.fetch = (() => Promise.resolve(new Response('Not Found', { status: 404 }))) as typeof fetch
    try {
      await expect(loadServerConfig()).resolves.toBeNull()
      // 未进入服务端模式时不附加访问口令头，等同原来的浏览器直连行为
      expect(createServerModeHeaders({ Authorization: 'Bearer x' })).toEqual({ Authorization: 'Bearer x' })
      expect(buildApiUrl('https://api.example.com/v1', 'images/generations', null, false)).toBe(
        'https://api.example.com/v1/images/generations',
      )
    } finally {
      globalThis.fetch = original
    }
  })
})
