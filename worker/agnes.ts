/**
 * Agnes Image 2.5 Flash 请求改写。
 *
 * 路径仍是 POST /v1/images/generations，但请求体不是标准 OpenAI Images：
 * - size 用 1K/2K/3K/4K 档位，并配合 ratio
 * - 图生图走 extra_body.image（URL 或 data URI）
 * - response_format 必须放 extra_body，不能放顶层
 */

export const AGNES_DEFAULT_BASE_URL = 'https://apihub.agnes-ai.com/v1'
export const AGNES_DEFAULT_MODEL = 'agnes-image-2.5-flash'

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

export type AgnesSize = {
  size: string
  ratio?: string
}

export function mapAgnesSize(size: unknown): AgnesSize {
  if (typeof size !== 'string' || !size.trim()) return { size: '1K', ratio: '1:1' }
  const trimmed = size.trim()
  if (/^[1-4]K$/i.test(trimmed)) return { size: trimmed.toUpperCase(), ratio: '1:1' }

  const match = trimmed.match(/^(\d+)\s*[xX×]\s*(\d+)$/)
  if (!match) return { size: '1K', ratio: '1:1' }

  const width = Number(match[1])
  const height = Number(match[2])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { size: '1K', ratio: '1:1' }
  }

  const maxEdge = Math.max(width, height)
  const pixels = width * height
  const tier = maxEdge >= 3200 || pixels >= 7_000_000
    ? '4K'
    : maxEdge >= 2800 || pixels >= 5_500_000
      ? '3K'
      : maxEdge >= 1600 || pixels >= 1_800_000
        ? '2K'
        : '1K'

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

  return { size: tier, ratio: best.key }
}

function bytesToDataUrl(bytes: Uint8Array, mime: string) {
  const chunkSize = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return `data:${mime || 'image/png'};base64,${btoa(binary)}`
}

async function fileToDataUrl(value: unknown): Promise<string | null> {
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    const bytes = new Uint8Array(await value.arrayBuffer())
    return bytesToDataUrl(bytes, value.type || 'image/png')
  }
  return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export async function rewriteAgnesRequest(body: Uint8Array, contentType: string, fallbackModel: string): Promise<{ body: Uint8Array; contentType: string; path: string }> {
  const type = contentType.toLowerCase()
  let payload: Record<string, unknown>

  if (type.includes('multipart/form-data')) {
    const request = new Request('https://agnes.local/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
    })
    const form = await request.formData()
    const images: string[] = []
    for (const key of ['image[]', 'image', 'images']) {
      for (const item of form.getAll(key)) {
        const dataUrl = await fileToDataUrl(item)
        if (dataUrl) images.push(dataUrl)
      }
    }
    payload = {
      model: String(form.get('model') || fallbackModel),
      prompt: String(form.get('prompt') || ''),
      size: String(form.get('size') || '1K'),
    }
    if (images.length) payload.image = images
  } else {
    const text = new TextDecoder().decode(body)
    const parsed = JSON.parse(text) as unknown
    payload = asRecord(parsed) ?? {}
  }

  const extra = asRecord(payload.extra_body) ?? {}
  const mapped = mapAgnesSize(payload.size)
  const images = Array.isArray(payload.image)
    ? payload.image.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    : Array.isArray(extra.image)
      ? extra.image.filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
      : []

  const nextExtra: Record<string, unknown> = {
    ...extra,
    response_format: 'b64_json',
  }
  if (images.length) nextExtra.image = images

  const next: Record<string, unknown> = {
    model: typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : fallbackModel,
    prompt: typeof payload.prompt === 'string' ? payload.prompt : '',
    size: mapped.size,
    extra_body: nextExtra,
    return_base64: true,
  }
  if (mapped.ratio) next.ratio = mapped.ratio

  return {
    body: new TextEncoder().encode(JSON.stringify(next)),
    contentType: 'application/json',
    path: 'images/generations',
  }
}

export async function collectAgnesImages(payload: unknown, fallbackMime: string): Promise<Array<{ mime: string; base64: string }>> {
  const record = asRecord(payload) ?? {}
  const items = Array.isArray(record.data) ? record.data : Array.isArray(payload) ? payload : []
  const images: Array<{ mime: string; base64: string }> = []

  for (const item of items) {
    const entry = asRecord(item)
    if (!entry) continue
    const raw = typeof entry.b64_json === 'string' ? entry.b64_json : typeof entry.base64 === 'string' ? entry.base64 : ''
    if (raw.trim()) {
      images.push({ mime: fallbackMime, base64: raw.replace(/^data:[^;]+;base64,/, '') })
      continue
    }
    if (typeof entry.url === 'string' && /^https?:\/\//i.test(entry.url)) {
      const response = await fetch(entry.url, { cache: 'no-store' })
      if (!response.ok) throw new Error(`无法下载 Agnes 图片（HTTP ${response.status}）`)
      const bytes = new Uint8Array(await response.arrayBuffer())
      const mime = response.headers.get('Content-Type')?.split(';')[0] || fallbackMime
      images.push({ mime, base64: bytesToDataUrl(bytes, mime).replace(/^data:[^;]+;base64,/, '') })
    }
  }

  return images
}
