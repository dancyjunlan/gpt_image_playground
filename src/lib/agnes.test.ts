import { describe, expect, it } from 'vitest'

import { mapAgnesSize, rewriteAgnesRequest } from '../../worker/agnes'

describe('agnes request rewrite', () => {
  it('maps pixel sizes to Agnes size tiers and ratios', () => {
    expect(mapAgnesSize('1024x1024')).toEqual({ size: '1K', ratio: '1:1' })
    expect(mapAgnesSize('2560x1440')).toEqual({ size: '2K', ratio: '16:9' })
    expect(mapAgnesSize('3840x2160')).toEqual({ size: '4K', ratio: '16:9' })
    expect(mapAgnesSize('2K')).toEqual({ size: '2K', ratio: '1:1' })
  })

  it('moves response_format and reference images into extra_body', async () => {
    const rewritten = await rewriteAgnesRequest(
      new TextEncoder().encode(JSON.stringify({
        model: 'agnes-image-2.5-flash',
        prompt: 'a cat',
        size: '2048x2048',
        response_format: 'b64_json',
        image: ['data:image/png;base64,aaa'],
      })),
      'application/json',
      'agnes-image-2.5-flash',
    )
    const payload = JSON.parse(new TextDecoder().decode(rewritten.body)) as Record<string, unknown>
    expect(rewritten.path).toBe('images/generations')
    expect(payload).toMatchObject({
      model: 'agnes-image-2.5-flash',
      prompt: 'a cat',
      size: '2K',
      ratio: '1:1',
      return_base64: true,
    })
    expect(payload.response_format).toBeUndefined()
    expect(payload.extra_body).toMatchObject({
      response_format: 'b64_json',
      image: ['data:image/png;base64,aaa'],
    })
  })
})
