import { describe, expect, it } from 'vitest'

import {
  isGrokImagineModel,
  mapGrokImagineQuality,
  mapGrokImagineSize,
  readGrokTaskId,
  readGrokTaskState,
  rewriteGrokImagineRequest,
} from '../../worker/grokImagine'

describe('grok imagine rewrite', () => {
  it('only matches imagine image models', () => {
    expect(isGrokImagineModel('grok-imagine-image-2.0')).toBe(true)
    expect(isGrokImagineModel('grok-3')).toBe(false)
    expect(isGrokImagineModel('gpt-image-2.5-sunburst')).toBe(false)
  })

  it('maps pixel sizes to Grok ratio plus 1K/2K resolution', () => {
    expect(mapGrokImagineSize('1024x1024')).toEqual({ size: '1:1', resolution: '1K' })
    expect(mapGrokImagineSize('2560x1440')).toEqual({ size: '16:9', resolution: '2K' })
    expect(mapGrokImagineQuality('high')).toBe('medium')
    expect(mapGrokImagineQuality('low')).toBe('low')
  })

  it('rewrites generations JSON into images/tasks payload', async () => {
    const rewritten = await rewriteGrokImagineRequest(
      new TextEncoder().encode(JSON.stringify({
        model: 'grok-imagine-image-2.0',
        prompt: 'a lake',
        size: '2048x2048',
        quality: 'high',
        n: 2,
      })),
      'application/json',
      'https://example.workers.dev',
      'job-1',
    )
    const payload = JSON.parse(new TextDecoder().decode(rewritten.body)) as Record<string, unknown>
    expect(rewritten.path).toBe('images/tasks')
    expect(payload).toMatchObject({
      model: 'grok-imagine-image-2.0',
      prompt: 'a lake',
      size: '1:1',
      resolution: '2K',
      quality: 'medium',
      n: 2,
    })
  })

  it('reads task_id from submit response', () => {
    expect(readGrokTaskId({ id: 'x', task_id: 'task-1' })).toBe('task-1')
    expect(readGrokTaskState({ state: 'in_progress' })).toBe('in_progress')
  })
})
