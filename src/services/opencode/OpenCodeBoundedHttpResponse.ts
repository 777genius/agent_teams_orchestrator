const MAX_BYTES = 1024 * 1024
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024
export class OpenCodeV1ReadUnavailableError extends Error {}
const MAX_DEPTH = 32
/** Bound consumed bytes and JSON complexity BEFORE parsing, including chunked lists. */
export async function readOpenCodeBoundedHttpResponse(response: Response, signal: AbortSignal, maxItems: number, remainingMs?: () => number, kind: 'metadata' | 'transcript' = 'metadata'): Promise<unknown> {
  const maxBytes = kind === 'transcript' && response.ok ? MAX_TRANSCRIPT_BYTES : MAX_BYTES
  // JSON tokens each consume at least one byte; avoid a smaller arbitrary limit
  // rejecting tool metadata within the accepted transcript byte budget.
  const maxTokens = kind === 'transcript' ? maxBytes : 16_384
  const cancelBody = () => { void response.body?.cancel().catch(() => undefined) }
  let deadlineExpired = false
  const check = () => { signal.throwIfAborted(); if (deadlineExpired || remainingMs && remainingMs() <= 0) throw new OpenCodeV1ReadUnavailableError('V1 terminal operation deadline expired') }
  try { check() } catch (error) { cancelBody(); throw error }
  const declared = Number(response.headers.get('content-length'))
  if (!response.ok || declared > maxBytes) {
    cancelBody()
    if (!response.ok) throw new Error(`OpenCode request failed (${response.status} ${response.statusText})`)
    throw new OpenCodeV1ReadUnavailableError('V1 terminal body byte budget exceeded')
  }
  const reader = response.body?.getReader()
  if (!reader) return undefined
  const cancel = () => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener('abort', cancel, { once: true })
  const remaining = remainingMs?.()
  const deadline = remaining !== undefined && Number.isFinite(remaining)
    ? setTimeout(() => { deadlineExpired = true; cancel() }, Math.max(0, remaining)) : undefined
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let text = '', bytes = 0, depth = 0, tokens = 0, items = 0
  let quoted = false, escaped = false, primitive = false, topValue = true
  const scan = (chunk: string) => {
    for (const char of chunk) {
      if (quoted) {
        if (escaped) escaped = false
        else if (char === '\\') escaped = true
        else if (char === '"') quoted = false
        continue
      }
      if (/\s/.test(char)) continue
      if (depth === 1 && topValue && char !== ']' && char !== ',') {
        topValue = false
        if (++items > maxItems) throw new Error('V1 terminal list count budget exceeded')
      }
      if (char === '"') { quoted = true; tokens++; primitive = false }
      else if (char === '{' || char === '[') { depth++; tokens++; primitive = false }
      else if (char === '}' || char === ']') { depth--; primitive = false }
      else if (char === ',' || char === ':') { primitive = false; if (depth === 1 && char === ',') topValue = true }
      else if (!primitive) { primitive = true; tokens++ }
      if (depth > MAX_DEPTH || tokens > maxTokens) throw new Error('V1 terminal JSON depth/token budget exceeded')
    }
  }
  try {
    while (true) {
      check()
      const chunk = await reader.read()
      check()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) throw new OpenCodeV1ReadUnavailableError('V1 terminal body byte budget exceeded')
      const decoded = decoder.decode(chunk.value, { stream: true })
      scan(decoded)
      text += decoded
    }
    const last = decoder.decode()
    scan(last)
    text += last
    check()
    const value: unknown = text.trim() ? JSON.parse(text) : undefined
    check()
    return value
  } catch (error) { cancel(); throw error }
  finally { clearTimeout(deadline); signal.removeEventListener('abort', cancel); reader.releaseLock() }
}
