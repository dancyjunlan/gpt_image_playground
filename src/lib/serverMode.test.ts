import { describe, expect, it } from 'vitest'

import { createServerModeHeaders, buildApiUrl } from './devProxy'
import {
  SERVICE_MANAGED_API_KEY,
  createServerPresetConfig,
  isServerManagedKey,
  loadServerConfig,
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
