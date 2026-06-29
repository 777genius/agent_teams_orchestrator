import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  buildNativeAppManagedBootstrapPrivatePrompt,
  buildNativeAppManagedBootstrapPrefixText,
  hashNativeBootstrapText,
  loadNativeAppManagedBootstrapContextInjection,
  NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_ENV,
  prepareNativeAppManagedBootstrapContextFile,
  readNativeAppManagedBootstrapContextFile,
  type NativeAppManagedBootstrapContextFile,
} from './nativeAppManagedBootstrapContext.js'

describe('native app-managed bootstrap context handoff', () => {
  let tempRoot: string
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'native-bootstrap-context-'))
    process.env.CLAUDE_CONFIG_DIR = tempRoot
  })

  afterEach(async () => {
    if (originalConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    }
    await rm(tempRoot, { recursive: true, force: true })
  })

  function makeContext(overrides: Partial<NativeAppManagedBootstrapContextFile> = {}): NativeAppManagedBootstrapContextFile {
    const contextText =
      overrides.contextText ??
      '<agent_teams_native_bootstrap_context>\nmember briefing\n</agent_teams_native_bootstrap_context>'
    return {
      schemaVersion: 1,
      kind: 'native_app_managed_bootstrap',
      mode: 'startup_context_file',
      teamName: 'atlas-hq',
      memberName: 'alice',
      agentId: 'alice@atlas-hq',
      runId: 'run-native-context',
      provider: 'codex',
      contextText,
      contextHash: hashNativeBootstrapText(contextText),
      briefingHash: hashNativeBootstrapText('member briefing'),
      generatedAt: '2026-05-06T00:00:00.000Z',
      bootstrapProofToken: 'hidden-proof-token',
      ...overrides,
    }
  }

  test('canonical hash normalizes line endings and trailing whitespace', () => {
    expect(hashNativeBootstrapText('line 1\r\nline 2  \n')).toBe(
      hashNativeBootstrapText('line 1\nline 2'),
    )
  })

  test('loads valid context and keeps proof token out of model-visible prefix text', async () => {
    const context = makeContext()
    const filePath = join(tempRoot, 'context.json')
    await writeFile(filePath, JSON.stringify(context), 'utf8')

    const loaded = await loadNativeAppManagedBootstrapContextInjection(filePath)

    expect(loaded.contextHash).toBe(context.contextHash)
    expect(loaded.briefingHash).toBe(context.briefingHash)
    expect(loaded.runId).toBe('run-native-context')
    expect(loaded.bootstrapProofToken).toBe('hidden-proof-token')
    expect(loaded.prefixMessagesText).toContain(context.contextText)
    expect(loaded.prefixMessagesText).not.toContain('hidden-proof-token')
  })

  test('bootstrap prompts allow startup task pickup instead of forcing idle', async () => {
    const context = makeContext({
      contextText: [
        '<agent_teams_native_bootstrap_context>',
        'Current task briefing:',
        'Actionable:',
        '- #seed1234 [status=pending] Pre-seeded work (owner=alice, actionOwner=@alice)',
        '</agent_teams_native_bootstrap_context>',
      ].join('\n'),
    })

    const privatePrompt = buildNativeAppManagedBootstrapPrivatePrompt()
    const prefixText = buildNativeAppManagedBootstrapPrefixText(context)

    expect(privatePrompt).toContain('if it shows Actionable assigned work for you')
    expect(privatePrompt).toContain('Startup context loaded.')
    expect(privatePrompt).toContain('Do not output "(no content)"')
    expect(privatePrompt).toContain('use the task tools and task protocol in this same turn')
    expect(privatePrompt).not.toContain('Then stop and wait for real work.')
    expect(prefixText).toContain('if it shows Actionable assigned work for you')
    expect(prefixText).toContain('Startup context loaded.')
    expect(prefixText).toContain('Do not output "(no content)"')
    expect(prefixText).toContain('use the task tools and task protocol in this same turn')
    expect(prefixText).not.toContain('Reply locally once, then stop.')
  })

  test('rejects symlink context files', async () => {
    const realPath = join(tempRoot, 'real-context.json')
    const linkPath = join(tempRoot, 'linked-context.json')
    await writeFile(realPath, JSON.stringify(makeContext()), 'utf8')
    await symlink(realPath, linkPath)

    await expect(readNativeAppManagedBootstrapContextFile(linkPath)).rejects.toThrow(
      /regular file/,
    )
  })

  test('rejects context hash mismatch', async () => {
    const filePath = join(tempRoot, 'bad-context.json')
    await writeFile(
      filePath,
      JSON.stringify(makeContext({ contextHash: '0'.repeat(64) })),
      'utf8',
    )

    await expect(readNativeAppManagedBootstrapContextFile(filePath)).rejects.toThrow(
      /hash mismatch/,
    )
  })

  test('writes context file with env handoff and unsupported providers are skipped', async () => {
    const contextText = 'native startup context'
    const env = await prepareNativeAppManagedBootstrapContextFile({
      teamName: 'atlas-hq',
      memberName: 'alice',
      agentId: 'alice@atlas-hq',
      runId: 'run-native-context',
      provider: 'anthropic',
      bootstrapProofToken: 'proof-token',
      spec: {
        schemaVersion: 1,
        mode: 'startup_context_file',
        contextText,
        contextHash: hashNativeBootstrapText(contextText),
        briefingHash: hashNativeBootstrapText('briefing'),
        generatedAt: '2026-05-06T00:00:00.000Z',
      },
    })

    const contextPath = env[NATIVE_APP_MANAGED_BOOTSTRAP_CONTEXT_ENV]
    expect(contextPath).toBeTruthy()
    const written = JSON.parse(await readFile(contextPath!, 'utf8')) as NativeAppManagedBootstrapContextFile
    expect(written.kind).toBe('native_app_managed_bootstrap')
    expect(written.runId).toBe('run-native-context')
    expect(written.bootstrapProofToken).toBe('proof-token')
    expect(buildNativeAppManagedBootstrapPrefixText(written)).not.toContain('proof-token')

    await expect(
      prepareNativeAppManagedBootstrapContextFile({
        teamName: 'atlas-hq',
        memberName: 'zoe',
        agentId: 'zoe@atlas-hq',
        runId: 'run-native-context',
        provider: 'gemini',
        bootstrapProofToken: 'proof-token',
        spec: {
          schemaVersion: 1,
          mode: 'startup_context_file',
          contextText,
          contextHash: hashNativeBootstrapText(contextText),
          briefingHash: hashNativeBootstrapText('briefing'),
          generatedAt: '2026-05-06T00:00:00.000Z',
        },
      }),
    ).resolves.toEqual({})
  })
})
