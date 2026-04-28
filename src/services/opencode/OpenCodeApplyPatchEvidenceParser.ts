export type OpenCodeApplyPatchParsedFile = {
  filePath: string
  operation: 'create' | 'modify' | 'delete'
  afterContent?: string
  beforeContent?: string
  updateHunks?: OpenCodeApplyPatchHunk[]
}

export type OpenCodeApplyPatchHunk = {
  beforeSnippet: string
  afterSnippet: string
}

type MutableParsedFile = OpenCodeApplyPatchParsedFile & {
  ambiguous?: true
  addLines?: string[]
  deleteLines?: string[]
  currentHunk?: MutableHunk
  hunks?: MutableHunk[]
}

type MutableHunk = {
  beforeLines: string[]
  afterLines: string[]
  changed: boolean
}

const MAX_PATCH_BYTES = 1024 * 1024
const MAX_PATCH_LINES = 50_000
const MAX_PATCH_FILES = 200

function linesToSnippet(lines: string[]): string {
  return lines.length > 0 ? `${lines.join('\n')}\n` : ''
}

function finishCurrentHunk(file: MutableParsedFile): void {
  if (!file.currentHunk) {
    return
  }
  const hunk = file.currentHunk
  if (hunk.changed) {
    const beforeSnippet = linesToSnippet(hunk.beforeLines)
    const afterSnippet = linesToSnippet(hunk.afterLines)
    if (beforeSnippet.length > 0 && afterSnippet.length > 0 && beforeSnippet !== afterSnippet) {
      file.hunks ??= []
      file.hunks.push(hunk)
    } else {
      file.ambiguous = true
    }
  }
  file.currentHunk = undefined
}

function finishAddFile(file: MutableParsedFile): OpenCodeApplyPatchParsedFile {
  finishCurrentHunk(file)
  const { addLines, deleteLines, currentHunk, hunks, ambiguous, ...rest } = file
  if (rest.operation === 'create' && addLines) {
    return {
      ...rest,
      afterContent: linesToSnippet(addLines),
    }
  }
  if (rest.operation === 'delete' && deleteLines && deleteLines.length > 0) {
    return {
      ...rest,
      beforeContent: linesToSnippet(deleteLines),
    }
  }
  if (rest.operation === 'modify' && hunks?.length) {
    return {
      ...rest,
      updateHunks: hunks.map(hunk => ({
        beforeSnippet: linesToSnippet(hunk.beforeLines),
        afterSnippet: linesToSnippet(hunk.afterLines),
      })),
    }
  }
  return rest
}

export function parseOpenCodeApplyPatchEvidence(
  patch: string,
  partId: string,
  diagnostics: string[],
): OpenCodeApplyPatchParsedFile[] {
  if (Buffer.byteLength(patch, 'utf8') > MAX_PATCH_BYTES) {
    diagnostics.push(`OpenCode apply_patch toolpart ${partId} skipped because patch exceeded the evidence parser size cap.`)
    return []
  }
  const lines = patch.split(/\r?\n/)
  if (lines.length > MAX_PATCH_LINES) {
    diagnostics.push(`OpenCode apply_patch toolpart ${partId} skipped because patch exceeded the evidence parser line cap.`)
    return []
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }
  if (lines[0]?.trimEnd() !== '*** Begin Patch' || lines[lines.length - 1]?.trimEnd() !== '*** End Patch') {
    diagnostics.push(`OpenCode apply_patch toolpart ${partId} skipped because patch did not use the supported Begin/End markers.`)
    return []
  }

  const byPath = new Map<string, MutableParsedFile>()
  let currentFile: MutableParsedFile | null = null

  for (let index = 1; index < lines.length - 1; index += 1) {
    const line = lines[index]?.trimEnd() ?? ''
    const marker =
      line.startsWith('*** Add File: ')
        ? { operation: 'create' as const, filePath: line.slice('*** Add File: '.length).trim() }
        : line.startsWith('*** Delete File: ')
          ? { operation: 'delete' as const, filePath: line.slice('*** Delete File: '.length).trim() }
          : line.startsWith('*** Update File: ')
            ? { operation: 'modify' as const, filePath: line.slice('*** Update File: '.length).trim() }
            : null

    if (marker) {
      if (currentFile) {
        finishCurrentHunk(currentFile)
      }
      currentFile = null
      if (!marker.filePath || marker.filePath.includes('\0')) {
        diagnostics.push(`OpenCode apply_patch toolpart ${partId} skipped an empty or unsafe patch path.`)
        continue
      }
      const existing = byPath.get(marker.filePath)
      if (existing?.ambiguous) {
        continue
      }
      if (existing) {
        byPath.set(marker.filePath, { ...existing, ambiguous: true })
        diagnostics.push(`OpenCode apply_patch toolpart ${partId} skipped ambiguous lifecycle markers for ${marker.filePath}.`)
        continue
      }
      if (byPath.size >= MAX_PATCH_FILES) {
        diagnostics.push(`OpenCode apply_patch toolpart ${partId} skipped extra files after the evidence parser file cap.`)
        currentFile = null
        continue
      }
      const parsed: MutableParsedFile = {
        filePath: marker.filePath,
        operation: marker.operation,
        ...(marker.operation === 'create' ? { addLines: [] } : {}),
        ...(marker.operation === 'delete' ? { deleteLines: [] } : {}),
      }
      byPath.set(marker.filePath, parsed)
      currentFile = parsed
      continue
    }

    if (line.startsWith('*** Move to: ')) {
      if (currentFile) {
        finishCurrentHunk(currentFile)
      }
      currentFile = null
      diagnostics.push(`OpenCode apply_patch toolpart ${partId} skipped unsupported move marker.`)
      continue
    }

    if (!currentFile) {
      continue
    }

    if (currentFile.operation === 'create') {
      if (!line.startsWith('+')) {
        currentFile.ambiguous = true
        diagnostics.push(`OpenCode apply_patch toolpart ${partId} skipped Add File ${currentFile.filePath} because it contained unsupported body lines.`)
        currentFile = null
        continue
      }
      currentFile.addLines?.push(line.slice(1))
      continue
    }

    if (currentFile.operation === 'delete') {
      if (!line.startsWith('-')) {
        currentFile.ambiguous = true
        diagnostics.push(`OpenCode apply_patch toolpart ${partId} skipped Delete File ${currentFile.filePath} because it contained unsupported body lines.`)
        currentFile = null
        continue
      }
      currentFile.deleteLines?.push(line.slice(1))
      continue
    }

    if (currentFile.operation === 'modify') {
      if (line.startsWith('@@')) {
        finishCurrentHunk(currentFile)
        currentFile.currentHunk = { beforeLines: [], afterLines: [], changed: false }
        continue
      }
      currentFile.currentHunk ??= { beforeLines: [], afterLines: [], changed: false }
      if (line.startsWith(' ')) {
        const value = line.slice(1)
        currentFile.currentHunk.beforeLines.push(value)
        currentFile.currentHunk.afterLines.push(value)
        continue
      }
      if (line.startsWith('-')) {
        currentFile.currentHunk.beforeLines.push(line.slice(1))
        currentFile.currentHunk.changed = true
        continue
      }
      if (line.startsWith('+')) {
        currentFile.currentHunk.afterLines.push(line.slice(1))
        currentFile.currentHunk.changed = true
        continue
      }
      currentFile.ambiguous = true
      diagnostics.push(`OpenCode apply_patch toolpart ${partId} skipped Update File ${currentFile.filePath} because it contained unsupported hunk lines.`)
      currentFile = null
    }
  }
  if (currentFile) {
    finishCurrentHunk(currentFile)
  }

  const changes = [...byPath.values()]
    .filter((change): change is MutableParsedFile => change.ambiguous !== true)
    .map(finishAddFile)

  if (changes.length === 0) {
    diagnostics.push(`OpenCode apply_patch toolpart ${partId} skipped because no supported Add/Update/Delete File markers were found.`)
  }
  return changes
}
