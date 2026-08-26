/**
 * Hosted approval text is browser-visible and must never disclose a host path.
 * Detect path grammars rather than a list of familiar host roots: arbitrary
 * POSIX roots, Windows drive/UNC/device paths, home expansion, and traversal
 * segments are all sensitive.
 */
const boundary = String.raw`(?:^|[\s"'\x60()\[\]{}<>,;=])`
const pathTail = String.raw`(?=$|[\s"'\x60()\[\]{}<>,;])`
const HOST_PATHS = [
  String.raw`${boundary}file:///[^\s"'\x60]*${pathTail}`,
  String.raw`${boundary}/[^\s"'\x60]*${pathTail}`,
  String.raw`${boundary}[A-Za-z]:[\\/][^\s"'\x60]*${pathTail}`,
  String.raw`${boundary}\\\\[?.]\\[^\s"'\x60]+${pathTail}`,
  String.raw`${boundary}\\\\[^\\\s"'\x60]+\\[^\\\s"'\x60]+(?:\\[^\s"'\x60]*)*${pathTail}`,
  String.raw`${boundary}//[^/\s"'\x60]+/[^/\s"'\x60]+(?:/[^\s"'\x60]*)*${pathTail}`,
  String.raw`${boundary}~(?:[A-Za-z0-9._-]+)?[\\/][^\s"'\x60]*${pathTail}`,
  String.raw`${boundary}(?:\.\.[\\/])+(?:[^\s"'\x60]*)${pathTail}`,
  String.raw`${boundary}[^\s"'\x60\\/]+[\\/](?:\.\.[\\/])+(?:[^\s"'\x60]*)${pathTail}`,
].map(source => new RegExp(source, 'u'))

export function containsHostPath(value: string): boolean {
  return HOST_PATHS.some(pattern => pattern.test(value))
}
