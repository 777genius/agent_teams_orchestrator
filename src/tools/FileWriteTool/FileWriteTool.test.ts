import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import type { ToolUseContext } from '../../Tool.js'
import { setCwdState, setOriginalCwd } from '../../bootstrap/state.js'
import { FileWriteTool } from './FileWriteTool.js'

let tmpDir = ''
const previousDisableFileCheckpointing =
  process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING

afterEach(async () => {
  if (tmpDir) {
    await rm(tmpDir, { recursive: true, force: true })
    tmpDir = ''
  }
  if (previousDisableFileCheckpointing === undefined) {
    delete process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING
  } else {
    process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING =
      previousDisableFileCheckpointing
  }
})

describe('FileWriteTool', () => {
  test('reports overwriting an existing empty file as an update', async () => {
    process.env.CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING = '1'
    tmpDir = await mkdtemp(join(tmpdir(), 'file-write-tool-'))
    setOriginalCwd(tmpDir)
    setCwdState(tmpDir)

    const filePath = join(tmpDir, 'empty.txt')
    await writeFile(filePath, '')

    const readFileState = new Map([
      [
        filePath,
        {
          content: '',
          timestamp: Number.MAX_SAFE_INTEGER,
          offset: undefined,
          limit: undefined,
        },
      ],
    ])

    const result = await FileWriteTool.call(
      { file_path: filePath, content: 'filled\n' },
      {
        readFileState,
        dynamicSkillDirTriggers: new Set<string>(),
      } as unknown as ToolUseContext,
      undefined as never,
      { uuid: 'parent-message' } as never,
    )

    expect(result.data).toMatchObject({
      type: 'update',
      filePath,
      content: 'filled\n',
      originalFile: '',
    })
    expect(await readFile(filePath, 'utf8')).toBe('filled\n')
  })
})
