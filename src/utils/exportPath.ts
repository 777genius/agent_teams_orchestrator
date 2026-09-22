import * as path from 'path'
import * as pathWin32 from 'path/win32'

import { isWindowsReservedBasename } from './windowsReservedNames.js'

const WINDOWS_INVALID_FILENAME_CHARS = /[<>:"/\\|?*\x00-\x1F]/

export function resolveExportFilePath(
  cwd: string,
  filename: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const pathImpl = platform === 'win32' ? pathWin32 : path
  const rawFilename = filename.trim()
  if (!rawFilename) {
    throw new Error('Export filename is required')
  }

  const finalFilename = rawFilename.endsWith('.txt')
    ? rawFilename
    : rawFilename.replace(/\.[^.]+$/, '') + '.txt'

  if (
    pathImpl.isAbsolute(finalFilename) ||
    pathImpl.basename(finalFilename) !== finalFilename
  ) {
    throw new Error('Export filename must be a file name, not a path')
  }

  if (platform === 'win32') {
    if (WINDOWS_INVALID_FILENAME_CHARS.test(finalFilename)) {
      throw new Error('Export filename contains invalid Windows characters')
    }
    if (/[. ]$/.test(finalFilename)) {
      throw new Error('Export filename cannot end with a space or period')
    }
    if (isWindowsReservedBasename(finalFilename)) {
      throw new Error(`Export filename "${finalFilename}" is reserved on Windows`)
    }
  }

  const resolvedCwd = pathImpl.resolve(cwd)
  const resolvedPath = pathImpl.resolve(resolvedCwd, finalFilename)
  const relativePath = pathImpl.relative(resolvedCwd, resolvedPath)
  if (
    relativePath === '' ||
    relativePath.startsWith('..') ||
    pathImpl.isAbsolute(relativePath)
  ) {
    throw new Error('Export filename must stay within the current directory')
  }

  return resolvedPath
}
