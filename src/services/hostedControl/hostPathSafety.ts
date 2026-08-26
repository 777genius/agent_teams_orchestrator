/**
 * Hosted approval text is browser-visible and must never disclose a host path.
 * Detect path grammars rather than a list of familiar host roots: arbitrary
 * POSIX roots, Windows drive/UNC/device paths, home expansion, and traversal
 * segments are all sensitive.
 */
const boundary = String.raw`(?:^|[\s"'\x60()\[\]{}<>,;=:])`
const pathTail = String.raw`(?=$|[\s"'\x60()\[\]{}<>,;])`
const HOST_PATHS = [
  String.raw`${boundary}(?:cwd|file):(?:/{0,3}|\\+)[^\s"'\x60]*${pathTail}`,
  String.raw`${boundary}/[^\s"'\x60]*${pathTail}`,
  String.raw`${boundary}[A-Za-z]:[\\/][^\s"'\x60]*${pathTail}`,
  String.raw`${boundary}(?:\\\\[?.]\\|\\(?:\?\?|Device|GLOBALROOT)\\)[^\s"'\x60]+${pathTail}`,
  String.raw`${boundary}\\\\[^\\\s"'\x60]+\\[^\\\s"'\x60]+(?:\\[^\s"'\x60]*)*${pathTail}`,
  String.raw`${boundary}//[^/\s"'\x60]+/[^/\s"'\x60]+(?:/[^\s"'\x60]*)*${pathTail}`,
  String.raw`${boundary}~(?:[A-Za-z0-9._-]+)?[\\/][^\s"'\x60]*${pathTail}`,
  String.raw`${boundary}(?:\.\.[\\/])+(?:[^\s"'\x60]*)${pathTail}`,
  String.raw`${boundary}[^\s"'\x60\\/]+[\\/](?:\.\.[\\/])+(?:[^\s"'\x60]*)${pathTail}`,
  // Relative multi-component filesystem forms are host paths too. Browser
  // summaries have no legitimate reason to expose an owner-local cwd path.
  String.raw`${boundary}(?:\.?[A-Za-z0-9_~@+-][^\s"'\x60\\/:]*[\\/]){1,}[^\s"'\x60\\/:]+${pathTail}`,
].map(source => new RegExp(source, 'u'))

export function containsHostPath(value: string): boolean {
  return normalizedCandidates(value).some(candidate =>
    HOST_PATHS.some(pattern => pattern.test(withoutWebUrls(candidate))),
  )
}

function normalizedCandidates(value: string): string[] {
  const candidates = new Set<string>()
  let current = normalizePathText(value)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    candidates.add(current)
    try {
      const decoded = decodeURIComponent(current)
      if (decoded === current) break
      current = normalizePathText(decoded)
    } catch {
      break
    }
  }
  return [...candidates]
}

function normalizePathText(value: string): string {
  return value.normalize('NFKC')
    .replace(/[\u2215\u2044\u29f8\uff0f]/gu, '/')
    .replace(/[\u2216\u29f5\ufe68\uff3c]/gu, '\\')
}

function withoutWebUrls(value: string): string {
  return value.replace(/https?:\/\/[^\s"'\x60()\[\]{}<>,;]+/giu, 'web-url')
}
