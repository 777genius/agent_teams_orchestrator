/** Parse the media type, not a substring in arbitrary parameters. Headers joins
 * duplicate Content-Type occurrences with commas, which this grammar rejects. */
export function isOpenCodeEventStreamContentType(value: string | null): boolean {
  if (value === null || value.length > 8192) return false
  const media = /^[\t ]*([!#$%&'*+.^_`|~0-9A-Za-z-]+)\/([!#$%&'*+.^_`|~0-9A-Za-z-]+)/.exec(value)
  if (!media || media[1]!.toLowerCase() !== 'text' || media[2]!.toLowerCase() !== 'event-stream') return false
  let offset = media[0].length
  const names = new Set<string>()
  const parameter = /[\t ]*;[\t ]*([!#$%&'*+.^_`|~0-9A-Za-z-]+)=([!#$%&'*+.^_`|~0-9A-Za-z-]+|"(?:[\t !#-\[\]-~\x80-\xff]|\\[\t \x21-\x7e\x80-\xff])*")/y
  while (offset < value.length) {
    if (/^[\t ]*$/.test(value.slice(offset))) return true
    parameter.lastIndex = offset
    const next = parameter.exec(value)
    if (!next) return false
    const name = next[1]!.toLowerCase()
    if (names.has(name)) return false
    names.add(name)
    offset = parameter.lastIndex
  }
  return true
}
