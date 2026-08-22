const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+/giu
const DEVICE_OR_UNC_PATH_PATTERN = /(?:\\\\[?.]\\|\\\\)[^\s'"<>]+/gu
const WINDOWS_PATH_PATTERN = /\b[A-Za-z]:\\[^\s'"<>]+/gu
const POSIX_PATH_PATTERN = /(^|[\s'"(=,:])\/(?:[^\s'"<>)]*\/)*[^\s'"<>),]*/gu
const BEARER_PATTERN = /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu
const SECRET_ASSIGNMENT_PATTERN = /\b(api[_-]?key|access[_-]?token|auth(?:orization)?|password|secret|token)\s*[:=]\s*([^\s,;]+)/giu
const QUERY_PATTERN = /\?[A-Za-z0-9_.~%+-]+=[^\s'"<>]*/gu

/** Redacts serialization-bound failure text without changing its stable category. */
export function sanitizeOpenCodeBridgeFailureMessage(value: unknown): string {
  const text = typeof value === 'string' ? value : String(value)
  const sanitized = text
    .replace(URL_PATTERN, '[endpoint redacted]')
    .replace(DEVICE_OR_UNC_PATH_PATTERN, '[path redacted]')
    .replace(WINDOWS_PATH_PATTERN, '[path redacted]')
    .replace(POSIX_PATH_PATTERN, '$1[path redacted]')
    .replace(BEARER_PATTERN, match => `${match.split(/\s/u, 1)[0]} [redacted]`)
    .replace(SECRET_ASSIGNMENT_PATTERN, '$1=[redacted]')
    .replace(QUERY_PATTERN, '?[redacted]')
    .replace(/[\r\n\t]+/gu, ' ')
    .trim()
  return sanitized.slice(0, 512) || 'OpenCode operation failed [redacted]'
}
