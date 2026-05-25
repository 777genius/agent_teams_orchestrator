import * as fs from 'fs/promises'

type BoundFileMessages = {
  notRegular: string
  oversized: string
  invalid: string
}

type ComparableFileStat = {
  dev?: number
  ino?: number
  size: number
  mode?: number
  mtimeMs?: number
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function sameFiniteNumber(a: unknown, b: unknown): boolean {
  return isFiniteNumber(a) && isFiniteNumber(b) && a === b
}

function didValidatedFileChange(
  expected: ComparableFileStat,
  actual: ComparableFileStat,
): boolean {
  const comparableIdentity =
    isFiniteNumber(expected.dev) &&
    isFiniteNumber(actual.dev) &&
    isFiniteNumber(expected.ino) &&
    isFiniteNumber(actual.ino)
  if (comparableIdentity) {
    return expected.dev !== actual.dev || expected.ino !== actual.ino
  }

  if (sameFiniteNumber(expected.dev, actual.dev) && sameFiniteNumber(expected.ino, actual.ino)) {
    return false
  }

  return (
    expected.size !== actual.size ||
    expected.mode !== actual.mode ||
    expected.mtimeMs !== actual.mtimeMs
  )
}

export async function readBoundRegularUtf8File(params: {
  filePath: string
  maxBytes: number
  messages: BoundFileMessages
}): Promise<string> {
  let validated: Awaited<ReturnType<typeof fs.lstat>>
  try {
    validated = await fs.lstat(params.filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
      throw new Error(params.messages.invalid)
    }
    throw error
  }
  if (validated.isSymbolicLink() || !validated.isFile()) {
    throw new Error(params.messages.notRegular)
  }
  if (validated.size > params.maxBytes) {
    throw new Error(params.messages.oversized)
  }

  let handle: Awaited<ReturnType<typeof fs.open>>
  try {
    handle = await fs.open(params.filePath, 'r')
  } catch {
    throw new Error(params.messages.invalid)
  }
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || didValidatedFileChange(validated, opened)) {
      throw new Error(params.messages.invalid)
    }
    if (opened.size > params.maxBytes) {
      throw new Error(params.messages.oversized)
    }
    return await handle.readFile({ encoding: 'utf8' })
  } catch (error) {
    if (error instanceof Error) {
      throw error
    }
    throw new Error(params.messages.invalid)
  } finally {
    await handle.close().catch(() => {})
  }
}
