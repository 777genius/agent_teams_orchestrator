/** Windows readonly opens require FILE_WRITE_ATTRIBUTES; macOS is pinned separately after async I/O stalls. */
export function openCodeBunVersion(platform: string = process.platform): '1.3.11' | '1.4.3' | '1.4.4' {
  return platform === 'win32' ? '1.4.3' : platform === 'darwin' ? '1.4.4' : '1.3.11'
}
