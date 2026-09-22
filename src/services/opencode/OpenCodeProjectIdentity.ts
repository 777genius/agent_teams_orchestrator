import path from 'node:path'

export function normalizeOpenCodeProjectIdentity(
  projectPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const resolved = path.resolve(projectPath)
  return platform === 'win32' ? resolved.toLowerCase() : resolved
}
