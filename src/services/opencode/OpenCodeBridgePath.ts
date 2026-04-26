import path from 'node:path'

export type OpenCodeBridgePathStyle = 'posix' | 'win32' | 'unc'

export type NormalizedOpenCodeFilePath = {
  originalPath: string
  absolutePath: string
  comparisonKey: string
  relativePath: string
  style: OpenCodeBridgePathStyle
}

export type OpenCodeBridgePathSkip = {
  skipped: true
  diagnostic: string
}

type NormalizedWorkspaceRoot = {
  absolutePath: string
  comparisonKey: string
  style: OpenCodeBridgePathStyle
}

const WINDOWS_DRIVE_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/
const WINDOWS_DEVICE_PATH_RE = /^(?:\\\\|\/\/)[?.][\\/]/
const WINDOWS_UNC_RE = /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/

function trimTrailingSeparators(value: string, style: OpenCodeBridgePathStyle): string {
  const rootPattern =
    style === 'posix'
      ? /^\/$/
      : style === 'unc'
        ? /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+[\\/]?$/
        : /^[A-Za-z]:[\\/]?$/
  if (rootPattern.test(value)) {
    return value
  }
  let end = value.length
  while (end > 0 && (value[end - 1] === '/' || value[end - 1] === '\\')) {
    end -= 1
  }
  return value.slice(0, end)
}

function isWindowsAbsolute(value: string): boolean {
  return WINDOWS_DRIVE_ABSOLUTE_RE.test(value) || WINDOWS_UNC_RE.test(value)
}

function isPosixAbsolute(value: string): boolean {
  return value.startsWith('/') && !value.startsWith('//') && !WINDOWS_DEVICE_PATH_RE.test(value)
}

function detectProjectStyle(projectPath: string): OpenCodeBridgePathStyle | null {
  if (WINDOWS_DEVICE_PATH_RE.test(projectPath)) {
    return null
  }
  if (WINDOWS_UNC_RE.test(projectPath)) {
    return 'unc'
  }
  if (WINDOWS_DRIVE_ABSOLUTE_RE.test(projectPath)) {
    return 'win32'
  }
  if (isPosixAbsolute(projectPath)) {
    return 'posix'
  }
  return null
}

function buildComparisonKey(value: string, style: OpenCodeBridgePathStyle): string {
  const slashNormalized = value.replace(/\\/g, '/')
  const trimmed = trimTrailingSeparators(slashNormalized, style)
  return style === 'posix' ? trimmed : trimmed.toLowerCase()
}

function getPathApi(style: OpenCodeBridgePathStyle): typeof path.posix {
  return style === 'posix' ? path.posix : path.win32
}

function isAbsoluteForStyle(value: string, style: OpenCodeBridgePathStyle): boolean {
  if (style === 'posix') {
    return isPosixAbsolute(value)
  }
  if (style === 'unc') {
    return WINDOWS_UNC_RE.test(value)
  }
  return WINDOWS_DRIVE_ABSOLUTE_RE.test(value)
}

function isMixedAbsolute(value: string, style: OpenCodeBridgePathStyle): boolean {
  if (style === 'posix') {
    return isWindowsAbsolute(value)
  }
  return isPosixAbsolute(value)
}

function isInsidePath(parent: string, child: string, style: OpenCodeBridgePathStyle): boolean {
  const pathApi = getPathApi(style)
  const relative = pathApi.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !pathApi.isAbsolute(relative))
}

export function normalizeOpenCodeFilePath(params: {
  projectPath: string
  filePath: string
}): NormalizedOpenCodeFilePath | OpenCodeBridgePathSkip {
  const projectPath = params.projectPath.trim()
  const filePath = params.filePath.trim()
  if (!projectPath || !filePath) {
    return { skipped: true, diagnostic: 'OpenCode path normalization received empty projectPath or filePath.' }
  }
  if (WINDOWS_DEVICE_PATH_RE.test(projectPath) || WINDOWS_DEVICE_PATH_RE.test(filePath)) {
    return { skipped: true, diagnostic: 'OpenCode device paths are not supported by ledger backfill.' }
  }

  const style = detectProjectStyle(projectPath)
  if (!style) {
    return { skipped: true, diagnostic: 'OpenCode projectPath is not an absolute supported path.' }
  }
  if (isMixedAbsolute(filePath, style)) {
    return { skipped: true, diagnostic: 'OpenCode filePath style does not match projectPath style.' }
  }
  if (style === 'unc' && isWindowsAbsolute(filePath) && !WINDOWS_UNC_RE.test(filePath)) {
    return { skipped: true, diagnostic: 'OpenCode UNC project received a non-UNC Windows filePath.' }
  }

  const pathApi = getPathApi(style)
  const normalizedProject = trimTrailingSeparators(pathApi.normalize(projectPath), style)
  const absolutePath = isAbsoluteForStyle(filePath, style)
    ? trimTrailingSeparators(pathApi.normalize(filePath), style)
    : trimTrailingSeparators(pathApi.resolve(normalizedProject, filePath), style)

  if (!isInsidePath(normalizedProject, absolutePath, style)) {
    return { skipped: true, diagnostic: 'OpenCode filePath is outside projectPath.' }
  }

  const relativePath = pathApi.relative(normalizedProject, absolutePath).replace(/\\/g, '/')
  if (!relativePath || relativePath.startsWith('..') || pathApi.isAbsolute(relativePath)) {
    return { skipped: true, diagnostic: 'OpenCode filePath could not be represented as a project-relative path.' }
  }

  return {
    originalPath: params.filePath,
    absolutePath,
    comparisonKey: buildComparisonKey(absolutePath, style),
    relativePath,
    style,
  }
}

function normalizeOpenCodeWorkspaceRoot(rootPath: string): NormalizedWorkspaceRoot | OpenCodeBridgePathSkip {
  const projectPath = rootPath.trim()
  if (!projectPath) {
    return { skipped: true, diagnostic: 'OpenCode workspace root is empty.' }
  }
  if (WINDOWS_DEVICE_PATH_RE.test(projectPath)) {
    return { skipped: true, diagnostic: 'OpenCode device paths are not supported by ledger backfill.' }
  }
  const style = detectProjectStyle(projectPath)
  if (!style) {
    return { skipped: true, diagnostic: 'OpenCode workspace root is not an absolute supported path.' }
  }
  const pathApi = getPathApi(style)
  const absolutePath = trimTrailingSeparators(pathApi.normalize(projectPath), style)
  return {
    absolutePath,
    comparisonKey: buildComparisonKey(absolutePath, style),
    style,
  }
}

export function areSameOpenCodeWorkspace(params: {
  expectedWorkspaceRoot: string
  recordProjectPath: string
}): boolean {
  const expected = normalizeOpenCodeWorkspaceRoot(params.expectedWorkspaceRoot)
  const actual = normalizeOpenCodeWorkspaceRoot(params.recordProjectPath)
  if ('skipped' in expected || 'skipped' in actual || expected.style !== actual.style) {
    return false
  }
  return expected.comparisonKey === actual.comparisonKey
}
