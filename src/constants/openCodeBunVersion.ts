/** Windows readonly opens require the upstream FILE_WRITE_ATTRIBUTES fix. */
export function openCodeBunVersion(platform: string = process.platform): '1.3.11' | '1.4.3' {
  return platform === 'win32' ? '1.4.3' : '1.3.11'
}
