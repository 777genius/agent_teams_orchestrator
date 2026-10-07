const MAX_BYTES = 1024 * 1024
const MAX_TOKENS = 16_384
const MAX_DEPTH = 32
/** Bound consumed bytes and JSON complexity BEFORE parsing, including chunked lists. */
export async function readOpenCodeBoundedHttpResponse(response: Response, signal: AbortSignal, maxItems: number, remainingMs?: () => number): Promise<unknown> {
  const cancelBody = () => { void response.body?.cancel().catch(() => undefined) }
  let deadlineExpired = false
  const check = () => { signal.throwIfAborted(); if (deadlineExpired || remainingMs && remainingMs() <= 0) throw new Error('V1 terminal operation deadline expired') }
  try { check() } catch (error) { cancelBody(); throw error }
  const declared = Number(response.headers.get('content-length'))
  if (!response.ok || declared > MAX_BYTES) {
    cancelBody()
    throw new Error(!response.ok ? `OpenCode request failed (${response.status} ${response.statusText})` : 'V1 terminal body byte budget exceeded')
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
      if (depth > MAX_DEPTH || tokens > MAX_TOKENS) throw new Error('V1 terminal JSON depth/token budget exceeded')
    }
  }
  try {
    while (true) {
      check()
      const chunk = await reader.read()
      check()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_BYTES) throw new Error('V1 terminal body byte budget exceeded')
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
