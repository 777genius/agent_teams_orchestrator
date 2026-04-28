import { describe, expect, test } from 'bun:test'

import { parseOpenCodeApplyPatchEvidence } from './OpenCodeApplyPatchEvidenceParser.js'

describe('OpenCodeApplyPatchEvidenceParser', () => {
  test('parses Add/Update/Delete markers and full Add File content', () => {
    const diagnostics: string[] = []
    const result = parseOpenCodeApplyPatchEvidence([
      '*** Begin Patch',
      '*** Add File: src/new.ts',
      '+export const value = 1;',
      '+',
      '+export const done = true;',
      '*** Update File: src/existing.ts',
      '@@',
      '-old',
      '+new',
      '*** Delete File: src/old.ts',
      '*** End Patch',
    ].join('\n'), 'part-1', diagnostics)

    expect(diagnostics).toEqual([])
    expect(result).toEqual([
      {
        filePath: 'src/new.ts',
        operation: 'create',
        afterContent: 'export const value = 1;\n\nexport const done = true;\n',
      },
      {
        filePath: 'src/existing.ts',
        operation: 'modify',
        updateHunks: [
          {
            beforeSnippet: 'old\n',
            afterSnippet: 'new\n',
          },
        ],
      },
      {
        filePath: 'src/old.ts',
        operation: 'delete',
      },
    ])
  })

  test('fails closed when Begin/End markers are missing', () => {
    const diagnostics: string[] = []
    const result = parseOpenCodeApplyPatchEvidence('diff --git a/file b/file\n', 'part-2', diagnostics)

    expect(result).toEqual([])
    expect(diagnostics).toContain(
      'OpenCode apply_patch toolpart part-2 skipped because patch did not use the supported Begin/End markers.',
    )
  })

  test('skips ambiguous duplicate lifecycle markers', () => {
    const diagnostics: string[] = []
    const result = parseOpenCodeApplyPatchEvidence([
      '*** Begin Patch',
      '*** Add File: src/same.ts',
      '+export const value = 1;',
      '*** Delete File: src/same.ts',
      '*** End Patch',
    ].join('\n'), 'part-3', diagnostics)

    expect(result).toEqual([])
    expect(diagnostics).toContain(
      'OpenCode apply_patch toolpart part-3 skipped ambiguous lifecycle markers for src/same.ts.',
    )
  })

  test('does not treat unsupported Add File body as exact content', () => {
    const diagnostics: string[] = []
    const result = parseOpenCodeApplyPatchEvidence([
      '*** Begin Patch',
      '*** Add File: src/bad.ts',
      'not an add line',
      '*** End Patch',
    ].join('\n'), 'part-4', diagnostics)

    expect(result).toEqual([])
    expect(diagnostics).toContain(
      'OpenCode apply_patch toolpart part-4 skipped Add File src/bad.ts because it contained unsupported body lines.',
    )
  })

  test('parses Delete File body as full before content when present', () => {
    const diagnostics: string[] = []
    const result = parseOpenCodeApplyPatchEvidence([
      '*** Begin Patch',
      '*** Delete File: src/old.ts',
      '-export const value = 1;',
      '-export const done = true;',
      '*** End Patch',
    ].join('\n'), 'part-5', diagnostics)

    expect(diagnostics).toEqual([])
    expect(result).toEqual([
      {
        filePath: 'src/old.ts',
        operation: 'delete',
        beforeContent: 'export const value = 1;\nexport const done = true;\n',
      },
    ])
  })

  test('parses multiple update hunks without merging independent snippets', () => {
    const diagnostics: string[] = []
    const result = parseOpenCodeApplyPatchEvidence([
      '*** Begin Patch',
      '*** Update File: src/file.ts',
      '@@',
      ' export const a = 1;',
      '-export const b = 1;',
      '+export const b = 2;',
      '@@',
      ' export const c = 1;',
      '-export const d = 1;',
      '+export const d = 2;',
      '*** End Patch',
    ].join('\n'), 'part-6', diagnostics)

    expect(diagnostics).toEqual([])
    expect(result).toEqual([
      {
        filePath: 'src/file.ts',
        operation: 'modify',
        updateHunks: [
          {
            beforeSnippet: 'export const a = 1;\nexport const b = 1;\n',
            afterSnippet: 'export const a = 1;\nexport const b = 2;\n',
          },
          {
            beforeSnippet: 'export const c = 1;\nexport const d = 1;\n',
            afterSnippet: 'export const c = 1;\nexport const d = 2;\n',
          },
        ],
      },
    ])
  })
})
