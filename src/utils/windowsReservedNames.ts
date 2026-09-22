const WINDOWS_RESERVED_BASENAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
])

export function isWindowsReservedBasename(name: string): boolean {
  if (typeof name !== 'string') {
    return false
  }

  const normalized = name.trim().replace(/[. ]+$/g, '').toLowerCase()
  if (!normalized) {
    return false
  }

  const stem = normalized.split('.')[0] ?? normalized
  return WINDOWS_RESERVED_BASENAMES.has(stem)
}

export function assertNotWindowsReservedBasename(
  name: string,
  label: string,
): void {
  if (isWindowsReservedBasename(name)) {
    throw new Error(`${label} "${name}" is reserved on Windows`)
  }
}

export function safeWindowsPathSegment(segment: string): string {
  if (!isWindowsReservedBasename(segment)) {
    return segment
  }
  return `_${segment}`
}
