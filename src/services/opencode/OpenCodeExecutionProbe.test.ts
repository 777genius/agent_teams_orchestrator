import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'

import { OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID } from './OpenCodeHostManager.js'
import {
  classifyProbeFailure,
  OpenCodeExecutionProbe,
  probeOutputMatchesExpected,
  OPEN_CODE_PROBE_PERMISSION_REJECT_MESSAGE,
  rejectProbeSessionPermissions,
  resolveOpenCodeExecutionProbeContextTokens,
} from './OpenCodeExecutionProbe.js'
import { OPEN_CODE_FREE_TIER_RESTRICTED_REASON } from './OpenCodeFreeTierFailure.js'
import { OPEN_CODE_MODEL_PROBE_AGENT_NAME } from './OpenCodeProfileManager.js'
import {
  fanOutOpenCodeOAuthCredential,
  readOpenCodeAuthCredential,
  upsertOpenCodeAuthCredential,
} from './OpenCodeAuthStore.js'
import {
  OpenCodeRuntimeDeadline,
  OpenCodeRuntimeDeadlineError,
} from './OpenCodeRuntimeDeadline.js'
import { createWindowsOwnerFilesystem, type WindowsOwnerNativeRequest } from './host/windows/OpenCodeV2WindowsOwnerFilesystem.js'
import * as profileManager from './OpenCodeProfileManager.js'
import * as launchPlan from './bridge/OpenCodeV2LaunchPlan.js'
import * as runOwner from './bridge/OpenCodeV2RunOwner.js'
import * as runControl from './bridge/OpenCodeV2RunControl.js'
import * as windowsBroker from './host/windows/OpenCodeV2WindowsNativeBroker.js'
import { resolveOpenCodeV2ExecutionProbe } from './bridge/OpenCodeV2ExecutionProbe.js'

import type {
  OpenCodeHostHandle,
  OpenCodeMessage,
  OpenCodePrepareProfileOptions,
  OpenCodePreparedProfile,
  OpenCodeSessionStatusInput,
} from './types.js'

const profile: OpenCodePreparedProfile = {
  projectPath: '/tmp/project',
  canonicalProjectPath: '/tmp/project',
  workingDirectoryPath: '/tmp/project',
  scopeToken: null,
  profileRootKey: 'profile-root',
  profileRootPath: '/tmp/profile-root',
  projectBehaviorFingerprint: 'behavior-v1',
  behaviorSources: ['AGENTS.md', 'opencode.json'],
  managedConfig: {
    default_agent: 'teammate',
    share: 'disabled',
    autoupdate: false,
    snapshot: true,
  },
  managedConfigFingerprint: 'managed-config-v1',
  homePath: '/tmp/profile-root/home',
  tmpPath: '/tmp/profile-root/tmp',
  xdgConfigHome: '/tmp/profile-root/config',
  xdgDataHome: '/tmp/profile-root/data',
  xdgCacheHome: '/tmp/profile-root/cache',
  managedAuthPath: '/tmp/profile-root/data/opencode/auth.json',
  sourceAuthPath: '/Users/test/.local/share/opencode/auth.json',
  sourceAuthFingerprint: 'source-auth',
  managedAuthFingerprint: 'managed-auth',
  authState: 'ok',
  env: {},
}

const host: OpenCodeHostHandle = {
  hostKey: 'host-key',
  profileRootKey: 'profile-root',
  projectPath: '/tmp/project',
  projectBehaviorFingerprint: 'behavior-v1',
  baseUrl: 'http://127.0.0.1:4096',
  port: 4096,
  pid: 123,
  version: '1.4.0',
  state: 'healthy',
  profile,
  resolvedConfigFingerprint: 'resolved-fingerprint',
  diagnostics: [],
}

test('keeps native subscription CLI probes above their hidden bootstrap context', () => {
  expect(resolveOpenCodeExecutionProbeContextTokens('cursor-acp/auto')).toBe(262_144)
  expect(resolveOpenCodeExecutionProbeContextTokens('kiro/auto')).toBe(262_144)
  expect(resolveOpenCodeExecutionProbeContextTokens('opencode/big-pickle')).toBe(32_000)
})

describe('OpenCodeV2 Windows probe owner adapter', () => {
  const identityA = { volumeSerial: '3', fileId: 'a'.repeat(32), ownerSid: 'S-1-5-21-3' }
  const identityB = { volumeSerial: '3', fileId: 'b'.repeat(32), ownerSid: 'S-1-5-21-3' }

  test('refuses EEXIST adoption and an ancestry identity swap', async () => {
    const originalPlatform = process.platform
    let currentIdentity = identityA, openCalls = 0
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      const native = async (request: WindowsOwnerNativeRequest): Promise<unknown> => {
        if (request.op === 'ownerOpenDirectory') {
          openCalls++
          if (request.createExclusive) throw new Error('execution_native_owned')
          return { schema: 1, ok: true, path: request.path, directory: true, reparse: false,
            privateAcl: true, identity: currentIdentity, handleId: 'TEST-held' }
        }
        if (request.op === 'ownerAssertDirectory') return { schema: 1, ok: true, path: request.path,
          directory: true, reparse: false, privateAcl: true, identity: currentIdentity }
        if (request.op === 'ownerCloseDirectory') return { schema: 1, ok: true, closed: true }
        throw new Error('TEST-unexpected-native-request')
      }
      const filesystem = createWindowsOwnerFilesystem(native)
      await expect(filesystem.createDirectory('C:\\TEST\\missing')).rejects.toThrow('execution_native_owned')
      expect(openCalls).toBe(1)
      const held = await filesystem.openDirectory('C:\\TEST\\held')
      await held.assertOwned()
      currentIdentity = identityB
      await expect(held.assertOwned()).rejects.toThrow('execution_owner_unknown')
      await held.close()
    } finally {
      await Promise.resolve()
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })

  test('rejects an expired deadline or abort before native mutation', async () => {
    const originalPlatform = process.platform
    let nativeCalls = 0
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      const native = async (request: WindowsOwnerNativeRequest): Promise<unknown> => {
        nativeCalls++
        if (request.op === 'ownerOpenDirectory') return { schema: 1, ok: true, path: request.path, directory: true,
          reparse: false, privateAcl: true, identity: identityA, handleId: 'TEST-held' }
        throw new Error('TEST-unexpected-native-request')
      }
      const filesystem = createWindowsOwnerFilesystem(native)
      await expect(filesystem.createDirectory('C:\\TEST\\expired', Date.now() - 1)).rejects.toThrow('execution_timeout')
      const controller = new AbortController(); controller.abort()
      await expect(filesystem.createDirectory('C:\\TEST\\aborted', Date.now() + 1000, controller.signal)).rejects.toThrow()
      expect(nativeCalls).toBe(0)
    } finally {
      await Promise.resolve()
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })

  test('positively rechecks a missing ProbeRecord and then reads a fresh replacement', async () => {
    const originalPlatform = process.platform
    let metadataCalls = 0
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    try {
      const native = async (request: WindowsOwnerNativeRequest): Promise<unknown> => {
        if (request.op === 'ownerOpenDirectory') return { schema: 1, ok: true, path: request.path, directory: true,
          reparse: false, privateAcl: true, identity: identityA, handleId: 'TEST-held' }
        if (request.op === 'ownerAssertDirectory') return { schema: 1, ok: true, path: request.path,
          directory: true, reparse: false, privateAcl: true, identity: identityA }
        if (request.op === 'ownerReadMetadata') {
          metadataCalls++
          return metadataCalls === 1
            ? { schema: 1, ok: true, purpose: 'ProbeRecord', path: 'C:\\TEST\\held\\probe.json',
              directoryIdentity: identityA, fileIdentity: null, bytes: 0, privateAcl: true,
              reparse: false, links: 1, absent: true }
            : { schema: 1, ok: true, purpose: 'ProbeRecord', path: 'C:\\TEST\\held\\probe.json',
              directoryIdentity: identityA, fileIdentity: { ...identityA, fileId: 'c'.repeat(32) },
              bytes: 2, privateAcl: true, reparse: false, links: 1,
              bytesBase64: Buffer.from('{}').toString('base64') }
        }
        if (request.op === 'ownerCloseDirectory') return { schema: 1, ok: true, closed: true }
        throw new Error('TEST-unexpected-native-request')
      }
      const filesystem = createWindowsOwnerFilesystem(native)
      const held = await filesystem.openDirectory('C:\\TEST\\held')
      await expect(held.readMetadata('ProbeRecord', Date.now() + 1000)).resolves.toMatchObject({ absent: true })
      const replacement = await held.readMetadata('ProbeRecord', Date.now() + 1000)
      expect(replacement.absent).toBeUndefined()
      expect(replacement.value).toEqual({})
      expect(metadataCalls).toBe(2)
      await held.close()
    } finally {
      await Promise.resolve()
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })

  test('native probe metadata writers preserve empty guards and exact JSON with retained ownership', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const writes: WindowsOwnerNativeRequest[] = []
    const refusal = new Error('execution_owner_not_private:private_acl_owner:0')
    let refuse = false, forged = false
    try {
      const native = async (request: WindowsOwnerNativeRequest): Promise<unknown> => {
        if (request.op === 'ownerOpenDirectory') return { schema: 1, ok: true, path: request.path,
          directory: true, reparse: false, privateAcl: true, identity: identityA, handleId: 'TEST-probe' }
        if (request.op === 'ownerAssertDirectory') return { schema: 1, ok: true, path: request.path,
          directory: true, reparse: false, privateAcl: true, identity: identityA }
        if (request.op === 'ownerCloseDirectory') return { schema: 1, ok: true, closed: true }
        if (request.op !== 'ownerWriteMetadata') throw new Error('TEST-unexpected-native-request')
        writes.push(request)
        if (refuse) throw refusal
        const bytes = Buffer.from(request.bytesBase64, 'base64')
        return { schema: 1, ok: true, purpose: request.purpose,
          path: 'C:\\TEST\\held\\' + (request.purpose === 'ProbeGuard' ? 'owner.lock' : 'probe.json'),
          directoryIdentity: identityA, fileIdentity: { ...identityA, fileId: 'c'.repeat(32) },
          bytes: bytes.length, privateAcl: !forged, reparse: false, links: 1,
          ...(request.purpose === 'ProbeRecord' ? { bytesBase64: request.bytesBase64 } : {}) }
      }
      const filesystem = createWindowsOwnerFilesystem(native)
      const held = await filesystem.openDirectory('C:\\TEST\\held')
      await held.writeMetadata('ProbeGuard', null, Date.now() + 1000)
      await held.writeMetadata('ProbeRecord', { sourceKey: 'TEST-original', submitted: false }, Date.now() + 1000)
      expect(writes).toEqual([
        { op: 'ownerWriteMetadata', handleId: 'TEST-probe', purpose: 'ProbeGuard', bytesBase64: '' },
        { op: 'ownerWriteMetadata', handleId: 'TEST-probe', purpose: 'ProbeRecord',
          bytesBase64: Buffer.from('{"sourceKey":"TEST-original","submitted":false}\n').toString('base64') },
      ])
      await expect(held.writeMetadata('ProbeGuard', {}, Date.now() + 1000)).rejects.toThrow('execution_owner_unknown')
      await expect(held.writeMetadata('ProbeRecord', { text: 'x'.repeat(131072) }, Date.now() + 1000))
        .rejects.toThrow('execution_owner_metadata_budget')
      await expect(held.writeMetadata('ProbeGuard', null, Date.now() - 1)).rejects.toThrow('execution_timeout')
      expect(writes.length).toBe(2)
      refuse = true
      await expect(held.writeMetadata('ProbeRecord', {}, Date.now() + 1000)).rejects.toBe(refusal)
      await expect(held.writeMetadata('ProbeRecord', {}, Date.now() + 1000)).rejects.toThrow('execution_owner_unknown')
      expect(writes.length).toBe(3)
      await held.close()
      refuse = false; forged = true
      const invalid = await filesystem.openDirectory('C:\\TEST\\held')
      await expect(invalid.writeMetadata('ProbeGuard', null, Date.now() + 1000)).rejects.toThrow('execution_owner_unknown')
      await expect(invalid.writeMetadata('ProbeGuard', null, Date.now() + 1000)).rejects.toThrow('execution_owner_unknown')
      expect(writes.length).toBe(4)
      await invalid.close()
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })

  test('fresh Windows ProbeRecord path creates its private chain and keeps one original submission', async () => {
    if (process.platform !== 'win32') return
    const temp = await mkdtemp(path.join(os.tmpdir(), 'TEST-v2-probe-chain-'))
    const localAppData = path.join(temp, 'Local')
    await mkdir(localAppData, { mode: 0o700 })
    const savedEnv = {
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      CLAUDE_MULTIMODEL_DATA_HOME: process.env.CLAUDE_MULTIMODEL_DATA_HOME,
    }
    process.env.LOCALAPPDATA = localAppData
    delete process.env.CLAUDE_MULTIMODEL_DATA_HOME
    const events: string[] = []
    const handles = new Map<string, string>()
    let handle = 0, readinessCalls = 0, launchCalls = 0, sendCalls = 0, failExclusive = false
    let recordSavedOriginal = false, recordSavedSubmitted = false, persistedIntent: unknown
    const identity = { volumeSerial: '4', fileId: 'a'.repeat(32), ownerSid: 'S-1-5-21-4' }
    const fileIdentity = { volumeSerial: '4', fileId: 'b'.repeat(32), ownerSid: 'S-1-5-21-4' }
    const native = async (request: WindowsOwnerNativeRequest): Promise<unknown> => {
      if (request.op === 'ownerPreparePrivateDirectory') {
        if (request.createExclusive) {
          if (failExclusive) throw new Error('execution_native_owned')
          await mkdir(request.path)
          events.push(`create:${request.path}`)
        } else {
          await stat(request.path)
          events.push(`open:${request.path}`)
        }
        const handleId = `TEST-${++handle}`
        handles.set(handleId, request.path)
        return { schema: 1, ok: true, path: request.path, directory: true, reparse: false,
          privateAcl: true, identity, handleId }
      }
      if (request.op === 'ownerAssertDirectory') return { schema: 1, ok: true, path: request.path,
        directory: true, reparse: false, privateAcl: true, identity }
      if (request.op === 'ownerReadMetadata' || request.op === 'ownerWriteMetadata') {
        const handleId = 'handleId' in request ? request.handleId : undefined
        const directory = handleId === undefined ? undefined : handles.get(handleId)
        expect(directory).toBeDefined()
        const file = path.join(directory!, request.purpose === 'ProbeGuard' ? 'owner.lock' : 'probe.json')
        if (request.op === 'ownerWriteMetadata')
          await writeFile(file, Buffer.from(request.bytesBase64, 'base64'), { mode: 0o600 })
        if (request.purpose === 'ProbeGuard') return { schema: 1, ok: true, purpose: 'ProbeGuard', path: file,
          directoryIdentity: identity, fileIdentity, bytes: 0, privateAcl: true, reparse: false, links: 1 }
        try {
          const bytes = await readFile(file)
          const row = JSON.parse(bytes.toString('utf8')) as { submitted: boolean; proof: unknown; intent: unknown }
          persistedIntent = row.intent
          events.push(row.proof ? 'record-proof' : row.submitted ? 'record-submitted' : 'record-original')
          if (row.submitted) recordSavedSubmitted = true
          else recordSavedOriginal = true
          return { schema: 1, ok: true, purpose: 'ProbeRecord', path: file,
            directoryIdentity: identity, fileIdentity, bytes: bytes.length, privateAcl: true,
            reparse: false, links: 1, bytesBase64: bytes.toString('base64') }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          events.push('record-absent')
          return { schema: 1, ok: true, purpose: 'ProbeRecord', path: file,
            directoryIdentity: identity, fileIdentity: null, bytes: 0, privateAcl: true,
            reparse: false, links: 1, absent: true }
        }
      }
      if (request.op === 'ownerCloseDirectory') return { schema: 1, ok: true, closed: true }
      throw new Error('TEST-unexpected-native-request')
    }
    const broker = {
      events: new EventEmitter(),
      request: async (_op: string, request: WindowsOwnerNativeRequest) => native(request),
      close: async () => undefined,
    }
    const restores: Array<{ mockRestore(): void }> = []
    const selection = {
      project: path.join(temp, 'project'),
      scope: { scopeToken: 'TEST-scope', selectedAuthIdentity: 'absent' },
      behaviorFingerprint: 'b'.repeat(64),
      installedGraphSHA256: 'c'.repeat(64),
      capabilitySnapshotId: 'TEST-capability',
      model: { providerID: 'provider', id: 'model' },
      native: { version: '2.0.21', executablePath: '/TEST/opencode' },
      controller: { type: 'local', environment: {} },
    } as Parameters<typeof resolveOpenCodeV2ExecutionProbe>[1]
    const binding = { teamId: 'TEST-probe', runId: 'TEST-run', controllerInstanceId: 'TEST-controller', ownerId: 'TEST-owner' }
    const proof = {
      projectPath: selection.project, modelId: 'provider/model', capabilitySnapshotId: 'TEST-capability',
      opencodeVersion: '2.0.21', binaryPath: '/TEST/opencode', projectBehaviorFingerprint: 'b'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    try {
      restores.push(
        spyOn(profileManager, 'collectProjectBehaviorMetadata').mockImplementation(async () =>
          ({ projectBehaviorFingerprint: 'b'.repeat(64), behaviorSources: [] })),
        spyOn(launchPlan, 'buildOpenCodeV2InternalRunPlan').mockImplementation(async () =>
          ({ binding, members: [{ originalSessionId: 'ses_TEST' }] }) as never),
        spyOn(runOwner, 'launchExplicitOpenCodeV2Run').mockImplementation(async () => {
          expect(recordSavedOriginal).toBe(true)
          launchCalls++
          events.push('launch')
          return undefined as never
        }),
        spyOn(runControl, 'discoverOpenCodeV2Run').mockImplementation(async () => ({ binding }) as never),
        spyOn(runControl, 'awaitOpenCodeV2RunMemberReadiness').mockImplementation(async () => (++readinessCalls > 1) as never),
        spyOn(runControl, 'requestOpenCodeV2Run').mockImplementation(async (_owner, request) => {
          if (request.operation === 'send') {
            expect(recordSavedSubmitted).toBe(true)
            expect(persistedIntent).toEqual(request.intent)
            sendCalls++
            events.push('send')
            return { kind: 'send' } as never
          }
          if (request.operation === 'probeEvidence') return { kind: 'probeEvidence', proof, failure: null } as never
          if (request.operation === 'stop') return { kind: 'stop', state: 'stopped', ownerRetired: true,
            members: [{ memberId: 'probe', cleanup: {}, errors: [] }] } as never
          throw new Error('TEST-unexpected-run-operation')
        }),
        spyOn(windowsBroker, 'resolveWindowsNativeArtifact').mockImplementation(async () =>
          ({ path: 'C:\\TEST\\native.exe', sha256: 'a'.repeat(64), arch: 'x64' }) as never),
        spyOn(windowsBroker, 'createWindowsNativeBroker').mockImplementation(() => broker as never),
      )
      const envelope = { timeoutMs: 26_000, body: { effort: 'default' } } as never
      const first = await resolveOpenCodeV2ExecutionProbe(envelope, selection, true)
      expect(first.state).toBe('pending')
      expect(launchCalls).toBe(1)
      expect(sendCalls).toBe(0)
      const second = await resolveOpenCodeV2ExecutionProbe(envelope, selection, true)
      expect(second.state).toBe('available')
      expect(launchCalls).toBe(1)
      expect(sendCalls).toBe(1)
      expect(events.some(event => event.startsWith('create:'))).toBe(true)
      expect(events.some(event => event.startsWith('open:'))).toBe(true)
      expect(events.indexOf('record-absent')).toBeLessThan(events.indexOf('record-original'))
      expect(events.indexOf('record-original')).toBeLessThan(events.indexOf('launch'))
      expect(events.indexOf('record-submitted')).toBeLessThan(events.indexOf('send'))

      failExclusive = true
      const changed = { ...selection, behaviorFingerprint: 'd'.repeat(64) } as Parameters<typeof resolveOpenCodeV2ExecutionProbe>[1]
      await expect(resolveOpenCodeV2ExecutionProbe(envelope, changed, true)).rejects.toThrow('execution_native_owned')
      expect(launchCalls).toBe(1)
      expect(sendCalls).toBe(1)
    } finally {
      for (const restore of restores) restore.mockRestore()
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(temp, { recursive: true, force: true })
    }
  })

  test('accepts an existing ambient application parent with ordinary Administrators ACL ancestry', async () => {
    if (process.platform !== 'win32') return
    const temp = await mkdtemp(path.join(os.tmpdir(), 'TEST-v2-probe-ambient-'))
    const localAppData = path.join(temp, 'Local')
    const ambientParent = path.join(localAppData, 'claude-multimodel-nodejs')
    const dataRoot = path.join(ambientParent, 'Data')
    const opencodeRoot = path.join(dataRoot, 'opencode')
    const v2Root = path.join(opencodeRoot, 'v2')
    const probesRoot = path.join(v2Root, 'execution-probes')
    await mkdir(ambientParent, { recursive: true })
    const savedEnv = {
      LOCALAPPDATA: process.env.LOCALAPPDATA,
      CLAUDE_MULTIMODEL_DATA_HOME: process.env.CLAUDE_MULTIMODEL_DATA_HOME,
    }
    process.env.LOCALAPPDATA = localAppData
    delete process.env.CLAUDE_MULTIMODEL_DATA_HOME

    const identity = { volumeSerial: '5', fileId: 'a'.repeat(32), ownerSid: 'S-1-5-21-5' }
    const fileIdentity = { volumeSerial: '5', fileId: 'b'.repeat(32), ownerSid: 'S-1-5-21-5' }
    const ambientAdministratorsAcl = { administrators: true, inherited: true }
    const handles = new Map<string, string>()
    const ancestryByHandle = new Map<string, string[]>()
    const heldPaths = new Set<string>()
    const assertedPaths = new Set<string>()
    const createdPaths: string[] = []
    const openedPaths: string[] = []
    const closedPaths: string[] = []
    let handle = 0, ambientPrivateOpenRefusals = 0, ambientBrokerRequests = 0, brokerCloseCalls = 0
    let readinessCalls = 0, launchCalls = 0, sendCalls = 0
    let recordSavedOriginal = false, recordSavedSubmitted = false, persistedIntent: unknown

    const producerPath = (candidate: string) => candidate === dataRoot || candidate === opencodeRoot ||
      candidate === v2Root || candidate === probesRoot ||
      (path.dirname(candidate) === probesRoot && /^[a-f0-9]{64}$/.test(path.basename(candidate)))
    const producerAncestry = (candidate: string) => {
      const ancestry = [ambientParent, dataRoot]
      const relative = path.relative(dataRoot, candidate)
      if (relative && relative !== '.' && !relative.startsWith('..')) {
        for (const part of relative.split(path.sep)) ancestry.push(path.join(ancestry.at(-1)!, part))
      }
      return ancestry
    }
    const native = async (request: WindowsOwnerNativeRequest): Promise<unknown> => {
      if (request.op === 'ownerPreparePrivateDirectory') {
        if (request.path === ambientParent && ambientAdministratorsAcl.administrators &&
          ambientAdministratorsAcl.inherited) {
          ambientPrivateOpenRefusals++
          throw new Error('execution_owner_private_acl_refused')
        }
        expect(producerPath(request.path)).toBe(true)
        if (request.createExclusive) {
          await mkdir(request.path)
          createdPaths.push(request.path)
        } else {
          await stat(request.path)
          openedPaths.push(request.path)
        }
        const handleId = `TEST-ambient-${++handle}`
        handles.set(handleId, request.path)
        ancestryByHandle.set(handleId, producerAncestry(request.path))
        heldPaths.add(request.path)
        return { schema: 1, ok: true, path: request.path, directory: true, reparse: false,
          privateAcl: true, identity, handleId }
      }
      if (request.op === 'ownerAssertDirectory') {
        expect(handles.get(request.handleId)).toBe(request.path)
        expect(producerPath(request.path)).toBe(true)
        expect(ancestryByHandle.get(request.handleId)).toEqual(producerAncestry(request.path))
        assertedPaths.add(request.path)
        return { schema: 1, ok: true, path: request.path, directory: true, reparse: false,
          privateAcl: true, identity }
      }
      if (request.op === 'ownerReadMetadata' || request.op === 'ownerWriteMetadata') {
        const handleId = 'handleId' in request ? request.handleId : undefined
        const directory = handleId === undefined ? undefined : handles.get(handleId)
        expect(directory).toBeDefined()
        const file = path.join(directory!, request.purpose === 'ProbeGuard' ? 'owner.lock' : 'probe.json')
        if (request.op === 'ownerWriteMetadata')
          await writeFile(file, Buffer.from(request.bytesBase64, 'base64'), { mode: 0o600 })
        if (request.purpose === 'ProbeGuard') return { schema: 1, ok: true, purpose: 'ProbeGuard', path: file,
          directoryIdentity: identity, fileIdentity, bytes: 0, privateAcl: true, reparse: false, links: 1 }
        try {
          const bytes = await readFile(file)
          const row = JSON.parse(bytes.toString('utf8')) as { submitted: boolean; proof: unknown; intent: unknown }
          persistedIntent = row.intent
          if (row.submitted) recordSavedSubmitted = true
          else if (!row.proof) recordSavedOriginal = true
          return { schema: 1, ok: true, purpose: 'ProbeRecord', path: file,
            directoryIdentity: identity, fileIdentity, bytes: bytes.length, privateAcl: true,
            reparse: false, links: 1, bytesBase64: bytes.toString('base64') }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          return { schema: 1, ok: true, purpose: 'ProbeRecord', path: file,
            directoryIdentity: identity, fileIdentity: null, bytes: 0, privateAcl: true,
            reparse: false, links: 1, absent: true }
        }
      }
      if (request.op === 'ownerCloseDirectory') {
        const directory = handles.get(request.handleId)
        expect(directory).toBeDefined()
        expect(heldPaths.delete(directory!)).toBe(true)
        closedPaths.push(directory!)
        return { schema: 1, ok: true, closed: true }
      }
      throw new Error('TEST-unexpected-native-request')
    }
    await expect(native({ op: 'ownerOpenDirectory', path: ambientParent, createExclusive: false }))
      .rejects.toThrow('execution_owner_private_acl_refused')
    expect(ambientPrivateOpenRefusals).toBe(1)

    const broker = {
      events: new EventEmitter(),
      request: async (_op: string, request: WindowsOwnerNativeRequest) => {
        if (request.op === 'ownerOpenDirectory' && request.path === ambientParent) ambientBrokerRequests++
        return native(request)
      },
      close: async () => { brokerCloseCalls++ },
    }
    const restores: Array<{ mockRestore(): void }> = []
    const selection = {
      project: path.join(temp, 'project'),
      scope: { scopeToken: 'TEST-ambient-scope', selectedAuthIdentity: 'absent' },
      behaviorFingerprint: 'b'.repeat(64),
      installedGraphSHA256: 'c'.repeat(64),
      capabilitySnapshotId: 'TEST-ambient-capability',
      model: { providerID: 'provider', id: 'model' },
      native: { version: '2.0.21', executablePath: '/TEST/opencode' },
      controller: { type: 'local', environment: {} },
    } as Parameters<typeof resolveOpenCodeV2ExecutionProbe>[1]
    const binding = { teamId: 'TEST-ambient-probe', runId: 'TEST-ambient-run',
      controllerInstanceId: 'TEST-ambient-controller', ownerId: 'TEST-ambient-owner' }
    const proof = {
      projectPath: selection.project, modelId: 'provider/model', capabilitySnapshotId: 'TEST-ambient-capability',
      opencodeVersion: '2.0.21', binaryPath: '/TEST/opencode', projectBehaviorFingerprint: 'b'.repeat(64),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    try {
      restores.push(
        spyOn(profileManager, 'collectProjectBehaviorMetadata').mockImplementation(async () =>
          ({ projectBehaviorFingerprint: 'b'.repeat(64), behaviorSources: [] })),
        spyOn(launchPlan, 'buildOpenCodeV2InternalRunPlan').mockImplementation(async () =>
          ({ binding, members: [{ originalSessionId: 'ses_ambientTEST' }] }) as never),
        spyOn(runOwner, 'launchExplicitOpenCodeV2Run').mockImplementation(async () => {
          expect(recordSavedOriginal).toBe(true)
          launchCalls++
          return undefined as never
        }),
        spyOn(runControl, 'discoverOpenCodeV2Run').mockImplementation(async () => ({ binding }) as never),
        spyOn(runControl, 'awaitOpenCodeV2RunMemberReadiness').mockImplementation(async () => (++readinessCalls > 1) as never),
        spyOn(runControl, 'requestOpenCodeV2Run').mockImplementation(async (_owner, request) => {
          if (request.operation === 'send') {
            expect(recordSavedSubmitted).toBe(true)
            expect(persistedIntent).toEqual(request.intent)
            expect(heldPaths.size).toBe(5)
            for (const root of heldPaths) {
              expect(producerPath(root)).toBe(true)
              expect(assertedPaths.has(root)).toBe(true)
            }
            sendCalls++
            return { kind: 'send' } as never
          }
          if (request.operation === 'probeEvidence') return { kind: 'probeEvidence', proof, failure: null } as never
          if (request.operation === 'stop') return { kind: 'stop', state: 'stopped', ownerRetired: true,
            members: [{ memberId: 'probe', cleanup: {}, errors: [] }] } as never
          throw new Error('TEST-unexpected-run-operation')
        }),
        spyOn(windowsBroker, 'resolveWindowsNativeArtifact').mockImplementation(async () =>
          ({ path: 'C:\\TEST\\native.exe', sha256: 'a'.repeat(64), arch: 'x64' }) as never),
        spyOn(windowsBroker, 'createWindowsNativeBroker').mockImplementation(() => broker as never),
      )
      const envelope = { timeoutMs: 26_000, body: { effort: 'default' } } as never
      const first = await resolveOpenCodeV2ExecutionProbe(envelope, selection, true)
      expect(first.state).toBe('pending')
      expect(launchCalls).toBe(1)
      expect(sendCalls).toBe(0)
      const second = await resolveOpenCodeV2ExecutionProbe(envelope, selection, true)
      expect(second.state).toBe('available')
      expect(launchCalls).toBe(1)
      expect(sendCalls).toBe(1)
      expect(ambientBrokerRequests).toBe(0)
      expect(ambientPrivateOpenRefusals).toBe(1)
      expect(createdPaths.slice(0, 4)).toEqual([dataRoot, opencodeRoot, v2Root, probesRoot])
      expect(openedPaths.slice(0, 4)).toEqual([dataRoot, opencodeRoot, v2Root, probesRoot])
      for (const sourceDirectory of [createdPaths.at(-1), openedPaths.at(-1)]) {
        expect(createdPaths).toHaveLength(5)
        expect(openedPaths).toHaveLength(5)
        expect(path.dirname(sourceDirectory!)).toBe(probesRoot)
        expect(path.basename(sourceDirectory!)).toMatch(/^[a-f0-9]{64}$/)
      }
      expect(assertedPaths.size).toBe(5)
      expect(closedPaths).toHaveLength(10)
      expect(heldPaths.size).toBe(0)
      expect(brokerCloseCalls).toBe(2)
    } finally {
      for (const restore of restores) restore.mockRestore()
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(temp, { recursive: true, force: true })
    }
  })
})

test('treats punctuation-only exact-token variants as the same launch proof', () => {
  const expected = 'STRICT_LAUNCH_c4c929b2-7cf2-43e6-b440-c82d0470ff67'
  expect(probeOutputMatchesExpected(
    'STRICT.LAUNCH_c4c929b2-7cf2-43e6-b440-c82d0470ff67',
    expected,
    true,
  )).toBe(true)
  expect(probeOutputMatchesExpected('STRICT_LAUNCH_wrong-nonce', expected, true)).toBe(false)
  expect(probeOutputMatchesExpected('PONG', expected, true)).toBe(false)
  expect(probeOutputMatchesExpected('PONG', 'PONG', false)).toBe(true)
  expect(probeOutputMatchesExpected('ok', 'PONG', false)).toBe(false)
  expect(probeOutputMatchesExpected('PING', 'PONG', false)).toBe(false)
})

describe('OpenCodeExecutionProbe', () => {
  let isolatedAuthorityRoot: string
  const originalAuthorityEnv = {
    HOME: process.env.HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
    CLAUDE_MULTIMODEL_DATA_HOME: process.env.CLAUDE_MULTIMODEL_DATA_HOME,
    CLAUDE_MULTIMODEL_CACHE_HOME: process.env.CLAUDE_MULTIMODEL_CACHE_HOME,
    CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY:
      process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY,
  }

  beforeEach(async () => {
    isolatedAuthorityRoot = await mkdtemp(path.join(os.tmpdir(), 'opencode-execution-probe-authority-'))
    process.env.HOME = path.join(isolatedAuthorityRoot, 'home')
    process.env.XDG_DATA_HOME = path.join(isolatedAuthorityRoot, 'xdg-data')
    process.env.CLAUDE_MULTIMODEL_DATA_HOME = path.join(isolatedAuthorityRoot, 'data')
    process.env.CLAUDE_MULTIMODEL_CACHE_HOME = path.join(isolatedAuthorityRoot, 'cache')
    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY = path.join(
      isolatedAuthorityRoot,
      'agent-teams-mcp.js',
    )
    await writeFile(process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY, '')
    const authDirectory = path.join(process.env.XDG_DATA_HOME, 'opencode')
    await mkdir(authDirectory, { recursive: true })
    await writeFile(
      path.join(authDirectory, 'auth.json'),
      JSON.stringify({
        opencode: { type: 'api', key: 'test-opencode-key' },
        openai: { type: 'api', key: 'test-openai-key' },
        anthropic: { type: 'api', key: 'test-anthropic-key' },
        google: { type: 'api', key: 'test-google-key' },
        'kimi-for-coding': { type: 'api', key: 'test-kimi-key' },
        ollama: { type: 'api', key: 'test-ollama-key' },
        xai: {
          type: 'oauth',
          access: 'test-xai-access-token',
          refresh: 'test-xai-refresh-token',
          expires: 4_102_444_800_000,
        },
      }),
    )
  })

  afterEach(async () => {
    await rm(isolatedAuthorityRoot, { recursive: true, force: true })
    for (const [name, value] of Object.entries(originalAuthorityEnv)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  test('classifies retired Google models as unavailable for the current account', () => {
    const message =
      'This model models/gemini-2.5-flash-lite is no longer available to new users.'

    expect(classifyProbeFailure({ message })).toEqual({
      outcome: 'unavailable',
      reason: message,
    })
  })

  test('classifies Cursor resource exhaustion as model unavailable', () => {
    for (const message of [
      'grpc_code=resource_exhausted error_code=upgrade',
      'grpc_code=resource-exhausted error_code=upgrade',
      'usage-limit reached',
      'quota_exceeded',
      'FreeUsageLimit',
      'ResourceExhaustedError',
      'RateLimitError',
      'grpc_code=8 error_code=upgrade',
      '{"grpcCode":8}',
      '{"statusCode":429}',
      'HTTP 429 Too Many Requests',
      'HTTP 403 Forbidden: grpc_code=RESOURCE_EXHAUSTED',
    ]) {
      expect(classifyProbeFailure({ message })).toEqual({
        outcome: 'unavailable',
        reason: message,
      })
    }
    expect(classifyProbeFailure({ message: 'error_code=upgrade' }).outcome).toBe('unknown')
    expect(classifyProbeFailure({ message: '{"usage":{"input_tokens":429}}' }).outcome).toBe(
      'unknown',
    )
    expect(classifyProbeFailure({ message: 'HTTP 403 Forbidden' }).outcome).toBe(
      'not_authenticated',
    )
  })

  test('marks model available when the durable assistant reply matches the expected probe output', async () => {
    let promptAsyncCount = 0
    let sendMessageCount = 0
    const retainedLeaseTeamIds: string[] = []
    const releasedLeaseTeamIds: string[] = []
    let releaseHostCount = 0
    let promptAgent: string | null = null
    let observedProviderId: string | undefined = 'opencode'
    let observedModelId: string | undefined = 'big-pickle'
    let ensureHostInput: {
      projectPath?: string | null
      profileOptions?: OpenCodePrepareProfileOptions
      hostLifetime?: string
    } | null = null
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async input => {
          ensureHostInput = input
          return host
        },
        retainHostLease: async (_hostKey, input) => {
          retainedLeaseTeamIds.push(input.teamId)
        },
        releaseHostLease: async (_hostKey, input) => {
          releasedLeaseTeamIds.push(input.teamId)
        },
        releaseHost: async () => {
          releaseHostCount += 1
        },
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => ({ id: 'session-1' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({ 'session-1': 'idle' }),
          getSessionMessages: async () => [
            {
              info: {
                id: 'msg-user-1',
                role: 'user',
                sessionID: 'session-1',
                time: { created: 100 },
              },
              parts: [{ type: 'text', text: 'Output only the single word PONG.' }],
            },
            {
              info: {
                id: 'msg-assistant-1',
                role: 'assistant',
                providerID: observedProviderId,
                modelID: observedModelId,
                parentID: 'msg-user-1',
                sessionID: 'session-1',
                time: { created: 101, completed: 110 },
              },
              parts: [{ type: 'text', text: 'PONG' }],
            },
          ],
          getPermissions: async () => [],
          sendSessionMessage: async () => {
            sendMessageCount += 1
            return { info: { id: 'msg-assistant-1' }, parts: [] }
          },
          promptSessionAsync: async (_sessionId, message) => {
            promptAsyncCount += 1
            promptAgent = message.agent ?? null
          },
          abortSession: async () => true,
        }),
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'opencode/big-pickle',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('available')
    expect(result.reason).toBeNull()
    expect(result.durableState).toBe('idle')
    expect(result.latestAssistantText).toBe('PONG')
    expect(result).toMatchObject({
      observedProviderId: 'opencode',
      observedModelId: 'big-pickle',
    })
    expect(promptAsyncCount).toBe(1)
    expect(promptAgent).toBe(OPEN_CODE_MODEL_PROBE_AGENT_NAME)
    expect(sendMessageCount).toBe(0)
    expect(retainedLeaseTeamIds).toEqual([OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID])
    expect(releasedLeaseTeamIds).toEqual([OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID])
    expect(releaseHostCount).toBe(1)
    expect(ensureHostInput).toMatchObject({
      projectPath: '/tmp/project',
      profileOptions: {
        includeAppMcp: false,
        modelOutputLimitOverrides: [
          {
            modelId: 'opencode/big-pickle',
            outputTokens: 512,
            contextTokens: 32_000,
          },
        ],
      },
      hostLifetime: 'process',
    })

    observedProviderId = 'other'
    expect(await probe.probeModel({
      selectedModel: 'opencode/big-pickle', projectPath: '/tmp/project',
    })).toMatchObject({ outcome: 'unavailable', observedProviderId: 'other' })
    observedProviderId = undefined
    observedModelId = undefined
    expect(await probe.probeModel({
      selectedModel: 'opencode/big-pickle', projectPath: '/tmp/project',
    })).toMatchObject({ outcome: 'unavailable' })
  })

  async function expectCompletedAssistantResponseWithoutTextFailsFast(
    assistantParts: OpenCodeMessage['parts'],
  ): Promise<void> {
    let sleepCount = 0
    let abortCount = 0
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      probeTimeoutMs: 120_000,
      pollIntervalMs: 500,
      sleep: async () => {
        sleepCount += 1
        if (sleepCount > 1) {
          throw new Error('completed empty response should not be polled again')
        }
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          getServerDoc: async () => { throw new Error('not used') },
          authorizeProviderOAuth: async () => { throw new Error('not used') },
          completeProviderOAuth: async () => { throw new Error('not used') },
          setProviderAuth: async () => { throw new Error('not used') },
          deleteProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => ({ id: 'session-empty-assistant' }),
          getSession: async () => ({ id: 'session-empty-assistant' }),
          getSessionStatus: async () => ({ 'session-empty-assistant': 'idle' }),
          getSessionMessages: async () => [
            {
              info: {
                id: 'msg-user-empty-assistant',
                role: 'user',
                sessionID: 'session-empty-assistant',
                time: { created: 100 },
              },
              parts: [{ type: 'text', text: 'Output only the single word PONG.' }],
            },
            {
              info: {
                id: 'msg-assistant-empty',
                role: 'assistant',
                parentID: 'msg-user-empty-assistant',
                sessionID: 'session-empty-assistant',
                time: { created: 101, completed: 110 },
              },
              parts: assistantParts,
            },
          ],
          getPermissions: async () => [],
          listExperimentalToolIds: async () => [],
          listExperimentalTools: async () => [],
          answerPermission: async () => ({}),
          sendSessionMessage: async () => ({
            info: { id: 'msg-user-empty-assistant' },
            parts: [],
          }),
          promptSessionAsync: async () => {},
          abortSession: async () => {
            abortCount += 1
            return true
          },
        }),
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'opencode/big-pickle',
      projectPath: '/tmp/project',
      bypassCache: true,
    })

    expect(result).toMatchObject({
      outcome: 'unknown',
      reason: 'OpenCode model verification completed without assistant output',
      durableState: 'idle',
      latestAssistantText: null,
    })
    expect(result.diagnostics).toContain(
      'OpenCode model verification completed without assistant output',
    )
    expect(sleepCount).toBe(1)
    expect(abortCount).toBe(0)
  }

  test('fails fast when OpenCode completes an empty assistant response', async () => {
    await expectCompletedAssistantResponseWithoutTextFailsFast([])
  })

  test('fails fast when OpenCode completes a reasoning-only assistant response', async () => {
    await expectCompletedAssistantResponseWithoutTextFailsFast([
      { type: 'reasoning', text: 'Internal reasoning without a final answer' },
    ])
  })

  test('fails fast after OpenCode stays idle without creating an assistant response', async () => {
    let statusCallCount = 0
    let messageCallCount = 0
    let abortCount = 0
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      probeTimeoutMs: 120_000,
      pollIntervalMs: 0,
      sleep: async () => {},
      clientFactory: {
        create: () => ({
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          getServerDoc: async () => { throw new Error('not used') },
          authorizeProviderOAuth: async () => { throw new Error('not used') },
          completeProviderOAuth: async () => { throw new Error('not used') },
          setProviderAuth: async () => { throw new Error('not used') },
          deleteProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => ({ id: 'session-no-assistant' }),
          getSession: async () => ({ id: 'session-no-assistant' }),
          getSessionStatus: async () => {
            statusCallCount += 1
            return { 'session-no-assistant': 'idle' as const }
          },
          getSessionMessages: async () => {
            messageCallCount += 1
            return [
              {
                info: {
                  id: 'msg-user-no-assistant',
                  role: 'user',
                  sessionID: 'session-no-assistant',
                  time: { created: 100 },
                },
                parts: [{ type: 'text', text: 'Output only the single word PONG.' }],
              },
            ]
          },
          getPermissions: async () => [],
          listExperimentalToolIds: async () => [],
          listExperimentalTools: async () => [],
          answerPermission: async () => ({}),
          sendSessionMessage: async () => ({
            info: { id: 'msg-user-no-assistant' },
            parts: [],
          }),
          promptSessionAsync: async () => {},
          abortSession: async () => {
            abortCount += 1
            return true
          },
        }),
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'opencode/big-pickle',
      projectPath: '/tmp/project',
      bypassCache: true,
    })

    expect(result).toMatchObject({
      outcome: 'unknown',
      reason: 'OpenCode model verification became idle without producing an assistant response',
      rawStatus: 'idle',
      durableState: 'reply_pending',
      latestAssistantText: null,
    })
    expect(result.diagnostics).toContain(
      'OpenCode model verification became idle without producing an assistant response after 3 consecutive observations',
    )
    expect(statusCallCount).toBeGreaterThanOrEqual(4)
    expect(messageCallCount).toBeGreaterThanOrEqual(4)
    expect(abortCount).toBe(0)
  })

  test('keeps polling when OpenCode omits status without creating an assistant response', async () => {
    let statusCallCount = 0
    let messageCallCount = 0
    let abortCount = 0
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      probeTimeoutMs: 20,
      promptStartTimeoutMs: 5,
      pollIntervalMs: 0,
      sleep: async () => {},
      clientFactory: {
        create: () => ({
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          getServerDoc: async () => { throw new Error('not used') },
          authorizeProviderOAuth: async () => { throw new Error('not used') },
          completeProviderOAuth: async () => { throw new Error('not used') },
          setProviderAuth: async () => { throw new Error('not used') },
          deleteProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => ({ id: 'session-omitted-idle' }),
          getSession: async () => ({ id: 'session-omitted-idle' }),
          getSessionStatus: async () => {
            statusCallCount += 1
            return {}
          },
          getSessionMessages: async () => {
            messageCallCount += 1
            return [
              {
                info: {
                  id: 'msg-user-omitted-idle',
                  role: 'user',
                  sessionID: 'session-omitted-idle',
                  time: { created: 100 },
                },
                parts: [{ type: 'text', text: 'Output only the single word PONG.' }],
              },
            ]
          },
          getPermissions: async () => [],
          listExperimentalToolIds: async () => [],
          listExperimentalTools: async () => [],
          answerPermission: async () => ({}),
          sendSessionMessage: async () => ({
            info: { id: 'msg-user-omitted-idle' },
            parts: [],
          }),
          promptSessionAsync: async () => {},
          abortSession: async () => {
            abortCount += 1
            return true
          },
        }),
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'opencode/big-pickle',
      projectPath: '/tmp/project',
      bypassCache: true,
    })

    expect(result).toMatchObject({
      outcome: 'unknown',
      reason: 'Model verification timed out',
      rawStatus: null,
      durableState: 'reply_pending',
      latestAssistantText: null,
    })
    expect(result.diagnostics).toContain('Model verification timed out')
    expect(result.diagnostics.join('\n')).not.toContain(
      'became idle without producing an assistant response',
    )
    expect(statusCallCount).toBeGreaterThanOrEqual(2)
    expect(messageCallCount).toBeGreaterThanOrEqual(2)
    expect(abortCount).toBe(1)
  })

  test('keeps polling when leftover PONG text is from an earlier turn while reply is still pending', async () => {
    let statusCallCount = 0
    let abortCount = 0
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      probeTimeoutMs: 20,
      promptStartTimeoutMs: 5,
      pollIntervalMs: 0,
      sleep: async () => {},
      clientFactory: {
        create: () => ({
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          getServerDoc: async () => { throw new Error('not used') },
          authorizeProviderOAuth: async () => { throw new Error('not used') },
          completeProviderOAuth: async () => { throw new Error('not used') },
          setProviderAuth: async () => { throw new Error('not used') },
          deleteProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => ({ id: 'session-stale-pong' }),
          getSession: async () => ({ id: 'session-stale-pong' }),
          getSessionStatus: async () => {
            statusCallCount += 1
            return {}
          },
          getSessionMessages: async () => [
            {
              info: {
                id: 'msg-user-old',
                role: 'user',
                sessionID: 'session-stale-pong',
                time: { created: 90 },
              },
              parts: [{ type: 'text', text: 'Output only the single word PONG.' }],
            },
            {
              info: {
                id: 'msg-assistant-old',
                role: 'assistant',
                parentID: 'msg-user-old',
                sessionID: 'session-stale-pong',
                time: { created: 91, completed: 95 },
              },
              parts: [{ type: 'text', text: 'PONG' }],
            },
            {
              info: {
                id: 'msg-user-new',
                role: 'user',
                sessionID: 'session-stale-pong',
                time: { created: 100 },
              },
              parts: [{ type: 'text', text: 'Output only the single word PONG.' }],
            },
          ],
          getPermissions: async () => [],
          listExperimentalToolIds: async () => [],
          listExperimentalTools: async () => [],
          answerPermission: async () => ({}),
          sendSessionMessage: async () => ({
            info: { id: 'msg-user-new' },
            parts: [],
          }),
          promptSessionAsync: async () => {},
          abortSession: async () => {
            abortCount += 1
            return true
          },
        }),
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'opencode/big-pickle',
      projectPath: '/tmp/project',
      bypassCache: true,
    })

    expect(result.outcome).not.toBe('available')
    expect(result.durableState).toBe('reply_pending')
    expect(result.latestAssistantText).toBe('PONG')
    expect(statusCallCount).toBeGreaterThanOrEqual(2)
    expect(abortCount).toBe(1)
  })

  test.each([
    {
      name: 'PONG',
      sessionId: 'session-stream-pong',
      selectedModel: 'ollama/qwen2.5-coder:1.5b',
      text: 'PONG',
      requireExactOutput: false,
      expectedOutput: 'PONG',
    },
    {
      name: 'STRICT token',
      sessionId: 'session-stream-strict',
      selectedModel: 'opencode/big-pickle',
      text: 'STRICT.LAUNCH_c4c929b2-7cf2-43e6-b440-c82d0470ff67',
      requireExactOutput: true,
      expectedOutput: 'STRICT_LAUNCH_c4c929b2-7cf2-43e6-b440-c82d0470ff67',
    },
  ])('keeps polling omitted status while streaming $name on a live generate', async ({
    sessionId,
    selectedModel,
    text,
    requireExactOutput,
    expectedOutput,
  }) => {
    let statusCallCount = 0
    let abortCount = 0
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      probeTimeoutMs: 20,
      promptStartTimeoutMs: 5,
      pollIntervalMs: 0,
      sleep: async () => {},
      clientFactory: {
        create: () => ({
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          getServerDoc: async () => { throw new Error('not used') },
          authorizeProviderOAuth: async () => { throw new Error('not used') },
          completeProviderOAuth: async () => { throw new Error('not used') },
          setProviderAuth: async () => { throw new Error('not used') },
          deleteProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => ({ id: sessionId }),
          getSession: async () => ({ id: sessionId }),
          getSessionStatus: async () => {
            statusCallCount += 1
            return {}
          },
          getSessionMessages: async () => [
            {
              info: {
                id: 'msg-user-stream',
                role: 'user',
                sessionID: sessionId,
                time: { created: 100 },
              },
              parts: [{ type: 'text', text: `Output only this exact token: ${expectedOutput}` }],
            },
            {
              info: {
                id: 'msg-assistant-stream',
                role: 'assistant',
                parentID: 'msg-user-stream',
                sessionID: sessionId,
                time: { created: 101 },
              },
              parts: [{ type: 'text', text }],
            },
          ],
          getPermissions: async () => [],
          listExperimentalToolIds: async () => [],
          listExperimentalTools: async () => [],
          answerPermission: async () => ({}),
          sendSessionMessage: async () => ({
            info: { id: 'msg-user-stream' },
            parts: [],
          }),
          promptSessionAsync: async () => {},
          abortSession: async () => {
            abortCount += 1
            return true
          },
        }),
      },
    })

    const result = await probe.probeModelOnHost({
      host,
      selectedModel,
      prompt: `Output only this exact token: ${expectedOutput}`,
      expectedOutput,
      requireExactOutput,
      cleanupSuccessfulSession: true,
      bypassCache: true,
    })

    expect(result.outcome).not.toBe('available')
    expect(result.reason).toBe('Model verification timed out')
    expect(result.latestAssistantText).toBe(text)
    expect(statusCallCount).toBeGreaterThanOrEqual(2)
    expect(abortCount).toBe(1)
  })

  test('accepts punctuation-only exact-token output after the session is idle', async () => {
    const expected = 'STRICT_LAUNCH_c4c929b2-7cf2-43e6-b440-c82d0470ff67'
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          getServerDoc: async () => { throw new Error('not used') },
          authorizeProviderOAuth: async () => { throw new Error('not used') },
          completeProviderOAuth: async () => { throw new Error('not used') },
          setProviderAuth: async () => { throw new Error('not used') },
          deleteProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => ({ id: 'session-strict-punct' }),
          getSession: async () => ({ id: 'session-strict-punct' }),
          getSessionStatus: async () => ({ 'session-strict-punct': 'idle' }),
          getSessionMessages: async () => [
            {
              info: {
                id: 'msg-user-strict',
                role: 'user',
                sessionID: 'session-strict-punct',
                time: { created: 100 },
              },
              parts: [{ type: 'text', text: `Output only this exact token: ${expected}` }],
            },
            {
              info: {
                id: 'msg-assistant-strict',
                role: 'assistant',
                providerID: 'opencode',
                modelID: 'big-pickle',
                parentID: 'msg-user-strict',
                sessionID: 'session-strict-punct',
                time: { created: 101, completed: 110 },
              },
              parts: [{ type: 'text', text: 'STRICT.LAUNCH_c4c929b2-7cf2-43e6-b440-c82d0470ff67' }],
            },
          ],
          getPermissions: async () => [],
          listExperimentalToolIds: async () => [],
          listExperimentalTools: async () => [],
          answerPermission: async () => ({}),
          sendSessionMessage: async () => ({
            info: { id: 'msg-user-strict' },
            parts: [],
          }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'opencode/big-pickle',
      projectPath: '/tmp/project',
      bypassCache: true,
      requireExactOutput: true,
      expectedOutput: expected,
      prompt: `Output only this exact token: ${expected}`,
    })

    expect(result.outcome).toBe('available')
    expect(result.durableState).toBe('idle')
    expect(result.latestAssistantText).toBe('STRICT.LAUNCH_c4c929b2-7cf2-43e6-b440-c82d0470ff67')
  })

  test('fails fast and aborts when prompt_async never materializes a prompt', async () => {
    let abortCount = 0
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          getServerDoc: async () => { throw new Error('not used') },
          authorizeProviderOAuth: async () => { throw new Error('not used') },
          completeProviderOAuth: async () => { throw new Error('not used') },
          setProviderAuth: async () => { throw new Error('not used') },
          deleteProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => ({ id: 'session-empty' }),
          getSession: async () => ({ id: 'session-empty' }),
          getSessionStatus: async () => ({}),
          getSessionMessages: async () => [],
          getSessionMessage: async () => null,
          getPermissions: async () => [],
          listExperimentalToolIds: async () => [],
          listExperimentalTools: async () => [],
          answerPermission: async () => ({}),
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => {
            abortCount += 1
            return true
          },
        }),
      },
      promptStartTimeoutMs: 1,
    })

    const result = await probe.probeModel({
      selectedModel: 'ollama/gemma4:12b',
      projectPath: '/tmp/project',
      bypassCache: true,
    })

    expect(result).toMatchObject({
      outcome: 'unknown',
      failureCode: 'prompt_start_failed',
    })
    expect(result.reason).toContain('did not create a user message or enter a running state')
    expect(abortCount).toBeGreaterThanOrEqual(1)
  })

  for (const source of ['status', 'messages'] as const) {
    test(`classifies resource exhaustion thrown by ${source} while confirming prompt start`, async () => {
      const terminalError = () => {
        const error = new Error('OpenCode transport failed') as Error & { cause?: unknown }
        error.cause = {
          data: {
            error: {
              type: 'ResourceExhaustedError',
              message: 'grpc_code=RESOURCE_EXHAUSTED',
            },
          },
        }
        return error
      }
      const probe = new OpenCodeExecutionProbe({
        hostManager: {
          ensureHost: async () => host,
          releaseHost: async () => {},
        },
        clientFactory: {
          create: () => ({
            getConfig: async () => { throw new Error('not used') },
            getConfigProviders: async () => { throw new Error('not used') },
            getProviders: async () => { throw new Error('not used') },
            getProviderAuth: async () => { throw new Error('not used') },
            getServerDoc: async () => { throw new Error('not used') },
            authorizeProviderOAuth: async () => { throw new Error('not used') },
            completeProviderOAuth: async () => { throw new Error('not used') },
            setProviderAuth: async () => { throw new Error('not used') },
            deleteProviderAuth: async () => { throw new Error('not used') },
            listAgents: async () => { throw new Error('not used') },
            getMcp: async () => { throw new Error('not used') },
            createSession: async () => ({ id: 'session-1' }),
            getSession: async () => ({ id: 'session-1' }),
            getSessionStatus: async () => {
              if (source === 'status') {
                throw terminalError()
              }
              return { 'session-1': 'idle' }
            },
            getSessionMessages: async () => {
              throw terminalError()
            },
            getPermissions: async () => [],
            listExperimentalToolIds: async () => [],
            listExperimentalTools: async () => [],
            answerPermission: async () => ({}),
            sendSessionMessage: async () => ({ info: {}, parts: [] }),
            promptSessionAsync: async () => {},
            abortSession: async () => true,
          }),
        },
        sessionCleanupTimeoutMs: 5,
      })

      const result = await probe.probeModelOnHost({
        host,
        selectedModel: 'cursor-acp/auto',
        projectPath: '/tmp/project',
        bypassCache: true,
      })

      expect(result.outcome).toBe('unavailable')
      expect(result.reason).toContain('RESOURCE_EXHAUSTED')
      expect(result.failureCode).toBeUndefined()
      expect(result.errorCount).toBe(1)
    })
  }

  test('bounds session cleanup when the abort request ignores cancellation', async () => {
    let abortCount = 0
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          getServerDoc: async () => { throw new Error('not used') },
          authorizeProviderOAuth: async () => { throw new Error('not used') },
          completeProviderOAuth: async () => { throw new Error('not used') },
          setProviderAuth: async () => { throw new Error('not used') },
          deleteProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => ({ id: 'session-cleanup-timeout' }),
          getSession: async () => ({ id: 'session-cleanup-timeout' }),
          getSessionStatus: async () => ({}),
          getSessionMessages: async () => [],
          getSessionMessage: async () => null,
          getPermissions: async () => [],
          listExperimentalToolIds: async () => [],
          listExperimentalTools: async () => [],
          answerPermission: async () => ({}),
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => {
            abortCount += 1
            return new Promise<boolean>(() => {})
          },
        }),
      },
      promptStartTimeoutMs: 1,
      sessionCleanupTimeoutMs: 10,
    })

    const result = probe.probeModel({
      selectedModel: 'ollama/gemma4:12b',
      projectPath: '/tmp/project',
      bypassCache: true,
    })
    const testGuard = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error('session cleanup did not settle')),
        500,
      )
      timer.unref?.()
    })

    await expect(Promise.race([result, testGuard])).resolves.toMatchObject({
      outcome: 'unknown',
      failureCode: 'prompt_start_failed',
    })
    expect(abortCount).toBe(1)
  })

  test('fans out a potentially rotated xAI OAuth credential after a real model probe', async () => {
    const fanOutInputs: Array<{ providerId: string; sourceAuthPath: string }> = []
    const refreshLockInputs: Array<{ authPath: string; providerId: string }> = []
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => ({ id: 'session-1' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({ 'session-1': 'idle' }),
          getSessionMessages: async () => [
            {
              info: {
                id: 'msg-assistant-1',
                role: 'assistant',
                providerID: 'xai',
                modelID: 'grok-4.3',
                sessionID: 'session-1',
                time: { created: 101, completed: 110 },
              },
              parts: [{ type: 'text', text: 'PONG' }],
            },
          ],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'msg-assistant-1' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
      fanOutOAuthCredential: async input => {
        fanOutInputs.push(input)
      },
      withOAuthRefreshLock: async input => {
        refreshLockInputs.push({
          authPath: input.authPath,
          providerId: input.providerId,
        })
        return input.operation()
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'xai/grok-4.3',
      projectPath: '/tmp/project',
      bypassCache: true,
    })

    expect(result.outcome).toBe('available')
    expect(fanOutInputs).toEqual([{
      providerId: 'xai',
      sourceAuthPath: profile.managedAuthPath,
    }])
    expect(refreshLockInputs).toEqual([{
      authPath: profile.managedAuthPath,
      providerId: 'xai',
    }])
  })

  test('simulates an expired xAI access token refresh and persists the rotated credential', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-xai-refresh-success-'))
    const globalAuthPath = path.join(tempDir, 'global', 'opencode', 'auth.json')
    const activeAuthPath = path.join(tempDir, 'profiles', 'active', 'opencode', 'auth.json')
    const peerAuthPath = path.join(tempDir, 'profiles', 'peer', 'opencode', 'auth.json')
    const expiredCredential = {
      type: 'oauth',
      access: 'expired-access',
      refresh: 'refresh-before-rotation',
      expires: Date.now() - 60_000,
      accountId: 'supergrok-account',
    }
    const rotatedCredential = {
      type: 'oauth',
      access: 'refreshed-access',
      refresh: 'refresh-after-rotation',
      expires: Date.now() + 3_600_000,
      accountId: 'supergrok-account',
    }
    const refreshProfile = {
      ...profile,
      managedAuthPath: activeAuthPath,
    }
    const refreshHost = {
      ...host,
      profile: refreshProfile,
    }

    try {
      await Promise.all(
        [globalAuthPath, activeAuthPath, peerAuthPath].map(authPath =>
          upsertOpenCodeAuthCredential({
            authPath,
            providerId: 'xai',
            credential: expiredCredential,
          }),
        ),
      )

      const probe = new OpenCodeExecutionProbe({
        hostManager: {
          ensureHost: async () => refreshHost,
          releaseHost: async () => {},
        },
        clientFactory: {
          create: () => ({
            getConfig: async () => { throw new Error('not used') },
            getConfigProviders: async () => { throw new Error('not used') },
            getProviders: async () => { throw new Error('not used') },
            getProviderAuth: async () => { throw new Error('not used') },
            listAgents: async () => { throw new Error('not used') },
            getMcp: async () => { throw new Error('not used') },
            createSession: async () => ({ id: 'session-1' }),
            getSession: async () => ({ id: 'session-1' }),
            getSessionStatus: async () => ({ 'session-1': 'idle' }),
            getSessionMessages: async () => [{
              info: {
                id: 'msg-assistant-1',
                role: 'assistant',
                providerID: 'xai',
                modelID: 'grok-4.3',
                sessionID: 'session-1',
                time: { created: 101, completed: 110 },
              },
              parts: [{ type: 'text', text: 'PONG' }],
            }],
            getPermissions: async () => [],
            sendSessionMessage: async () => ({ info: { id: 'msg-assistant-1' }, parts: [] }),
            promptSessionAsync: async () => {
              await upsertOpenCodeAuthCredential({
                authPath: activeAuthPath,
                providerId: 'xai',
                credential: rotatedCredential,
              })
            },
            abortSession: async () => true,
          }),
        },
        fanOutOAuthCredential: async input => {
          await fanOutOpenCodeOAuthCredential({
            ...input,
            targetAuthPaths: [globalAuthPath, activeAuthPath, peerAuthPath],
          })
        },
      })

      const result = await probe.probeModel({
        selectedModel: 'xai/grok-4.3',
        projectPath: '/tmp/project',
        bypassCache: true,
      })

      expect(result.outcome).toBe('available')
      await expect(Promise.all(
        [globalAuthPath, activeAuthPath, peerAuthPath].map(authPath =>
          readOpenCodeAuthCredential({ authPath, providerId: 'xai' }),
        ),
      )).resolves.toEqual([rotatedCredential, rotatedCredential, rotatedCredential])
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('preserves the previous xAI credential when an expired-token refresh fails', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-xai-refresh-failure-'))
    const globalAuthPath = path.join(tempDir, 'global', 'opencode', 'auth.json')
    const activeAuthPath = path.join(tempDir, 'profiles', 'active', 'opencode', 'auth.json')
    const peerAuthPath = path.join(tempDir, 'profiles', 'peer', 'opencode', 'auth.json')
    const expiredCredential = {
      type: 'oauth',
      access: 'expired-access',
      refresh: 'still-valid-refresh-token',
      expires: Date.now() - 60_000,
      accountId: 'supergrok-account',
    }
    const refreshProfile = {
      ...profile,
      managedAuthPath: activeAuthPath,
    }
    const refreshHost = {
      ...host,
      profile: refreshProfile,
    }

    try {
      await Promise.all(
        [globalAuthPath, activeAuthPath, peerAuthPath].map(authPath =>
          upsertOpenCodeAuthCredential({
            authPath,
            providerId: 'xai',
            credential: expiredCredential,
          }),
        ),
      )

      const probe = new OpenCodeExecutionProbe({
        hostManager: {
          ensureHost: async () => refreshHost,
          releaseHost: async () => {},
        },
        clientFactory: {
          create: () => ({
            getConfig: async () => { throw new Error('not used') },
            getConfigProviders: async () => { throw new Error('not used') },
            getProviders: async () => { throw new Error('not used') },
            getProviderAuth: async () => { throw new Error('not used') },
            listAgents: async () => { throw new Error('not used') },
            getMcp: async () => { throw new Error('not used') },
            createSession: async () => ({ id: 'session-1' }),
            getSession: async () => ({ id: 'session-1' }),
            getSessionStatus: async () => ({}),
            getSessionMessages: async () => [],
            getPermissions: async () => [],
            sendSessionMessage: async () => ({ info: { id: 'msg-assistant-1' }, parts: [] }),
            promptSessionAsync: async () => {
              throw new Error('xAI token refresh failed: invalid_grant')
            },
            abortSession: async () => true,
          }),
        },
        fanOutOAuthCredential: async input => {
          await fanOutOpenCodeOAuthCredential({
            ...input,
            targetAuthPaths: [globalAuthPath, activeAuthPath, peerAuthPath],
          })
        },
      })

      const result = await probe.probeModel({
        selectedModel: 'xai/grok-4.3',
        projectPath: '/tmp/project',
        bypassCache: true,
      })

      expect(result.outcome).toBe('not_authenticated')
      expect(result.reason).toContain('token refresh failed')
      await expect(Promise.all(
        [globalAuthPath, activeAuthPath, peerAuthPath].map(authPath =>
          readOpenCodeAuthCredential({ authPath, providerId: 'xai' }),
        ),
      )).resolves.toEqual([expiredCredential, expiredCredential, expiredCredential])
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('does not treat a completed non-PONG assistant response as inexact execution proof', async () => {
    let strictHostOnly = false
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => {
          if (strictHostOnly) throw new Error('strict proof must not acquire another host')
          return host
        },
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => ({ id: 'session-1' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({ 'session-1': 'idle' }),
          getSessionMessages: async () => [
            {
              info: {
                id: 'msg-user-1',
                role: 'user',
                sessionID: 'session-1',
                time: { created: 100 },
              },
              parts: [{ type: 'text', text: 'Output only the single word PONG.' }],
            },
            {
              info: {
                id: 'msg-assistant-1',
                role: 'assistant',
                providerID: 'ollama',
                modelID: 'qwen2.5-coder:0.5b',
                parentID: 'msg-user-1',
                sessionID: 'session-1',
                time: { created: 101, completed: 110 },
              },
              parts: [{ type: 'text', text: 'PING' }],
            },
          ],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'msg-assistant-1' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'ollama/qwen2.5-coder:0.5b',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('unknown')
    expect(result.reason).toBe('OpenCode local-model execution proof was mismatched')
    expect(result.latestAssistantText).toBe('PING')
    expect(result.diagnostics.join('\n')).not.toContain(
      'treating non-empty response as execution proof',
    )

    strictHostOnly = true
    const strictResult = await probe.probeModelOnHost({
      host,
      selectedModel: 'ollama/qwen2.5-coder:0.5b',
      prompt: 'Output only this exact token: PONG',
      expectedOutput: 'PONG',
      requireExactOutput: true,
      cleanupSuccessfulSession: true,
    })
    expect(strictResult.outcome).toBe('unknown')
    expect(strictResult.latestAssistantText).toBe('PING')
  })

  test('does not treat a plain-text Cursor authentication error as execution proof', async () => {
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => ({ id: 'session-1' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({ 'session-1': 'idle' }),
          getSessionMessages: async () => [
            {
              info: {
                id: 'msg-assistant-1',
                role: 'assistant',
                sessionID: 'session-1',
                time: { created: 101, completed: 110 },
              },
              parts: [{
                type: 'text',
                text: "cursor-acp error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY.",
              }],
            },
          ],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'msg-assistant-1' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const result = await probe.probeModelOnHost({
      host,
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('not_authenticated')
    expect(result.reason).toContain('Authentication required')
  })

  test('does not treat a plain-text Cursor usage-limit error as execution proof', async () => {
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => ({ id: 'session-1' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({ 'session-1': 'idle' }),
          getSessionMessages: async () => [
            {
              info: {
                id: 'msg-assistant-1',
                role: 'assistant',
                sessionID: 'session-1',
                time: { created: 101, completed: 110 },
              },
              parts: [{
                type: 'text',
                text: "cursor-acp error: You've hit your Cursor usage limit",
              }],
            },
          ],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'msg-assistant-1' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const result = await probe.probeModelOnHost({
      host,
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('unavailable')
    expect(result.reason).toContain('Cursor usage limit')
    expect(result.diagnostics.join('\n')).toContain(
      'assistant payload exposed a terminal provider failure',
    )
  })

  test('uses the native Cursor probe to stop a stuck OpenCode retry on resource exhaustion', async () => {
    let nativeProbeCalls = 0
    let abortCalls = 0
    let messageCalls = 0
    let statusCalls = 0
    let nativeProbeEnv: NodeJS.ProcessEnv | undefined
    let nativeProbeProjectPath: string | undefined
    let nativeProbeDelayMs: number | undefined
    let hungStatusSignal: AbortSignal | undefined
    let resolveNativeFailure!: (failure: {
      outcome: 'failure'
      message: string
      durationMs: number
      exitCode: number
    }) => void
    const nativeFailure = new Promise<{
      outcome: 'failure'
      message: string
      durationMs: number
      exitCode: number
    }>(resolve => {
      resolveNativeFailure = resolve
    })
    const profileEnv = {
      CURSOR_AGENT_EXECUTABLE: '/managed/profile/cursor-agent',
      PATH: '/managed/profile/bin',
    }
    const managedHost: OpenCodeHostHandle = {
      ...host,
      profile: {
        ...host.profile,
        env: profileEnv,
      },
    }
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => managedHost,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: (_baseUrl, requestContext) => ({
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => ({ id: 'session-1' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => {
            statusCalls += 1
            if (statusCalls === 2) {
              hungStatusSignal = requestContext?.signal
              resolveNativeFailure({
                outcome: 'failure',
                message: 'grpc_code=resource_exhausted error_code=upgrade',
                durationMs: 12,
                exitCode: 1,
              })
              return await new Promise<Record<string, OpenCodeSessionStatusInput>>(() => {})
            }
            return { 'session-1': 'retry' }
          },
          getSessionMessages: async () => {
            messageCalls += 1
            return await new Promise<OpenCodeMessage[]>(() => {})
          },
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'unused' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => {
            abortCalls += 1
            return true
          },
        }),
      },
      cursorNativeFailureProbe: {
        probe: async input => {
          nativeProbeCalls += 1
          nativeProbeEnv = input.env
          nativeProbeProjectPath = input.projectPath
          if (nativeProbeCalls === 1) nativeProbeDelayMs = input.delayMs
          return nativeProbeCalls === 1 ? null : nativeFailure
        },
      },
      sleep: async () => {},
      probeTimeoutMs: 1_000,
    })

    const runtimeDeadline = new OpenCodeRuntimeDeadline(250)
    const result = await (async () => {
      try {
        return await probe.probeModelOnHost({
          host: managedHost,
          selectedModel: 'cursor-acp/auto',
          projectPath: '/tmp/project',
          runtimeDeadline,
        })
      } finally {
        runtimeDeadline.dispose()
      }
    })()

    expect(result.outcome).toBe('unavailable')
    expect(result.reason).toContain('resource_exhausted')
    expect(result.durableState).toBe('retrying')
    expect(result.diagnostics.join('\n')).toContain('native failure probe confirmed')
    expect(nativeProbeCalls).toBe(2)
    expect(nativeProbeEnv).toBe(profileEnv)
    expect(nativeProbeProjectPath).toBe(managedHost.profile.tmpPath)
    expect(nativeProbeDelayMs).toBe(0)
    expect(messageCalls).toBe(0)
    expect(statusCalls).toBeGreaterThanOrEqual(2)
    expect(hungStatusSignal?.aborted).toBe(true)
    expect(abortCalls).toBeGreaterThan(0)

    const freshResult = await probe.probeModelOnHost({
      host: managedHost,
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
    })
    expect(freshResult.outcome).toBe('unavailable')
    expect(nativeProbeCalls).toBe(3)
  })

  test('uses a nested terminal OpenCode retry error without a second Cursor request', async () => {
    let nativeProbeCalls = 0
    let messageCalls = 0
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => ({ id: 'session-1' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({
            'session-1': {
              type: 'retry',
              attempt: 1,
              message: 'HTTP 403 Forbidden',
              data: {
                metadata: {
                  code: 'RESOURCE_EXHAUSTED',
                },
              },
            } as OpenCodeSessionStatusInput & { data: Record<string, unknown> },
          }),
          getSessionMessages: async () => {
            messageCalls += 1
            return await new Promise<OpenCodeMessage[]>(() => {})
          },
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'unused' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
      cursorNativeFailureProbe: {
        probe: async () => {
          nativeProbeCalls += 1
          return null
        },
      },
      sleep: async () => {},
    })

    const result = await probe.probeModelOnHost({
      host,
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('unavailable')
    expect(result.reason).toContain('RESOURCE_EXHAUSTED')
    expect(result.diagnostics.join('\n')).toContain('retry status exposed')
    expect(nativeProbeCalls).toBe(1)
    expect(messageCalls).toBe(0)
  })

  test('rechecks retry status while the session messages request is pending', async () => {
    let statusCalls = 0
    let messageCalls = 0
    let pendingMessagesSignal: AbortSignal | undefined
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: (_baseUrl, requestContext) => ({
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => ({ id: 'session-1' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => {
            statusCalls += 1
            return {
              'session-1': statusCalls < 3
                ? 'busy'
                : {
                    type: 'retry',
                    attempt: 1,
                    message: 'grpc_code=resource_exhausted error_code=upgrade',
                  },
            }
          },
          getSessionMessages: async () => {
            messageCalls += 1
            pendingMessagesSignal = requestContext?.signal
            return await new Promise<OpenCodeMessage[]>((_resolve, reject) => {
              requestContext?.signal?.addEventListener(
                'abort',
                () => reject(requestContext.signal?.reason),
                { once: true },
              )
            })
          },
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'unused' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
      sleep: async () => {},
    })

    const result = await probe.probeModelOnHost({
      host,
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
      bypassCache: true,
    })

    expect(result.outcome).toBe('unavailable')
    expect(result.reason).toContain('resource_exhausted')
    expect(result.durableState).toBe('retrying')
    expect(statusCalls).toBeGreaterThanOrEqual(3)
    expect(messageCalls).toBe(1)
    expect(pendingMessagesSignal?.aborted).toBe(true)
  })

  for (const source of ['status', 'messages'] as const) {
    test(`classifies resource exhaustion thrown by the session ${source} request`, async () => {
      let statusCalls = 0
      const probe = new OpenCodeExecutionProbe({
        hostManager: {
          ensureHost: async () => host,
          releaseHost: async () => {},
        },
        clientFactory: {
          create: () => ({
            getConfig: async () => { throw new Error('not used') },
            getConfigProviders: async () => { throw new Error('not used') },
            getProviders: async () => { throw new Error('not used') },
            getProviderAuth: async () => { throw new Error('not used') },
            listAgents: async () => { throw new Error('not used') },
            getMcp: async () => { throw new Error('not used') },
            createSession: async () => ({ id: 'session-1' }),
            getSession: async () => ({ id: 'session-1' }),
            getSessionStatus: async () => {
              statusCalls += 1
              if (source === 'status' && statusCalls > 1) {
                throw new Error('HTTP 403: grpc_code=RESOURCE_EXHAUSTED')
              }
              return { 'session-1': 'busy' }
            },
            getSessionMessages: async () => {
              if (source === 'messages') {
                throw new Error('HTTP 403: grpc_code=RESOURCE_EXHAUSTED')
              }
              return []
            },
            getPermissions: async () => [],
            sendSessionMessage: async () => ({ info: { id: 'unused' }, parts: [] }),
            promptSessionAsync: async () => {},
            abortSession: async () => true,
          }),
        },
      })

      const result = await probe.probeModelOnHost({
        host,
        selectedModel: 'cursor-acp/auto',
        projectPath: '/tmp/project',
        bypassCache: true,
      })

      expect(result.outcome).toBe('unavailable')
      expect(result.reason).toContain('RESOURCE_EXHAUSTED')
      expect(result.diagnostics.join('\n')).toContain(`session ${source} request`)
    })
  }

  test('continues the OpenCode probe after bounded native fallback rejections', async () => {
    let statusCalls = 0
    let nativeProbeCalls = 0
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => ({ id: 'session-1' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => {
            statusCalls += 1
            return {
              'session-1': statusCalls === 1
                ? 'busy'
                : statusCalls === 2
                  ? 'retry'
                  : 'idle',
            }
          },
          getSessionMessages: async () => statusCalls < 3
            ? []
            : [{
                info: {
                  id: 'msg-assistant-1',
                  role: 'assistant',
                  providerID: 'cursor-acp',
                  modelID: 'auto',
                  sessionID: 'session-1',
                  time: { created: 101, completed: 110 },
                },
                parts: [{ type: 'text', text: 'PONG' }],
              }],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'unused' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
      cursorNativeFailureProbe: {
        probe: async () => {
          nativeProbeCalls += 1
          throw new Error('native probe crashed')
        },
      },
      sleep: async () => {},
    })

    const result = await probe.probeModelOnHost({
      host,
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('available')
    expect(nativeProbeCalls).toBe(3)
  })

  test('retries one inconclusive native fallback and uses a terminal second result', async () => {
    let nativeProbeCalls = 0
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => ({ id: 'session-1' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({ 'session-1': 'retry' }),
          getSessionMessages: async () => await new Promise<OpenCodeMessage[]>(() => {}),
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'unused' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
      cursorNativeFailureProbe: {
        probe: async () => {
          nativeProbeCalls += 1
          return nativeProbeCalls === 1
            ? {
                outcome: 'failure',
                message: 'Connection reset by server',
                durationMs: 10,
                exitCode: 1,
              }
            : {
                outcome: 'failure',
                message: 'grpc_code=resource_exhausted error_code=upgrade',
                durationMs: 12,
                exitCode: 1,
              }
        },
      },
      sleep: async () => {},
      probeTimeoutMs: 1_000,
    })

    const result = await probe.probeModelOnHost({
      host,
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('unavailable')
    expect(result.reason).toContain('resource_exhausted')
    expect(nativeProbeCalls).toBe(2)
  })

  test('does not repeat the native fallback after a successful PONG result', async () => {
    let statusCalls = 0
    let nativeProbeCalls = 0
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => ({ id: 'session-1' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => {
            statusCalls += 1
            return { 'session-1': statusCalls < 3 ? 'retry' : 'idle' }
          },
          getSessionMessages: async () => statusCalls < 3
            ? []
            : [{
                info: {
                  id: 'msg-assistant-1',
                  role: 'assistant',
                  providerID: 'cursor-acp',
                  modelID: 'auto',
                  sessionID: 'session-1',
                  time: { created: 101, completed: 110 },
                },
                parts: [{ type: 'text', text: 'PONG' }],
              }],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'unused' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
      cursorNativeFailureProbe: {
        probe: async () => {
          nativeProbeCalls += 1
          if (nativeProbeCalls === 1) return null
          return {
            outcome: 'available',
            message: null,
            durationMs: 8,
            exitCode: 0,
          }
        },
      },
      sleep: async () => {},
    })

    const result = await probe.probeModelOnHost({
      host,
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('available')
    expect(nativeProbeCalls).toBe(2)
  })

  test('prefers a recovered original OpenCode PONG over an auxiliary native failure', async () => {
    let statusCalls = 0
    let nativeProbeCalls = 0
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => ({ id: 'session-1' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => {
            statusCalls += 1
            return { 'session-1': statusCalls === 1 ? 'retry' : 'idle' }
          },
          getSessionMessages: async () => [{
            info: {
              id: 'msg-assistant-1',
              role: 'assistant',
              providerID: 'cursor-acp',
              modelID: 'auto',
              sessionID: 'session-1',
              time: { created: 101, completed: 110 },
            },
            parts: [{ type: 'text', text: 'PONG' }],
          }],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'unused' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
      cursorNativeFailureProbe: {
        probe: async () => {
          nativeProbeCalls += 1
          if (nativeProbeCalls === 1) return null
          return {
            outcome: 'failure',
            message: 'grpc_code=resource_exhausted error_code=upgrade',
            durationMs: 8,
            exitCode: 1,
          }
        },
      },
      sleep: async () => {},
    })

    const result = await probe.probeModelOnHost({
      host,
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('available')
    expect(result.latestAssistantText).toBe('PONG')
    expect(result.diagnostics.join('\n')).toContain('original probe recovered')
    expect(nativeProbeCalls).toBe(2)
  })

  test('does not repeat an inconclusive native preflight while OpenCode is busy', async () => {
    let statusCalls = 0
    let nativeFallbackCalls = 0
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => ({ id: 'session-1' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => {
            statusCalls += 1
            return { 'session-1': statusCalls < 3 ? 'busy' : 'idle' }
          },
          getSessionMessages: async () => statusCalls < 3
            ? []
            : [{
                info: {
                  id: 'msg-assistant-1',
                  role: 'assistant',
                  providerID: 'cursor-acp',
                  modelID: 'auto',
                  sessionID: 'session-1',
                  time: { created: 101, completed: 110 },
                },
                parts: [{ type: 'text', text: 'PONG' }],
              }],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'unused' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
      cursorNativeFailureProbe: {
        probe: async () => {
          nativeFallbackCalls += 1
          return null
        },
      },
      sleep: async () => {},
    })

    const result = await probe.probeModelOnHost({
      host,
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('available')
    expect(statusCalls).toBe(3)
    expect(nativeFallbackCalls).toBe(1)
  })

  test('surfaces terminal native Cursor preflight before creating an OpenCode session', async () => {
    let nativeFallbackCalls = 0
    let createSessionCalls = 0
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => {
            createSessionCalls += 1
            return { id: 'session-1' }
          },
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({ 'session-1': 'busy' }),
          getSessionMessages: async () => [],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'unused' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
      cursorNativeFailureProbe: {
        probe: async () => {
          nativeFallbackCalls += 1
          return {
            outcome: 'failure',
            message: "cursor-acp error: You've hit your Cursor usage limit",
            durationMs: 12,
            exitCode: 1,
          }
        },
      },
      sleep: async () => {},
      probeTimeoutMs: 1_000,
    })

    const result = await probe.probeModelOnHost({
      host,
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('unavailable')
    expect(result.reason).toContain('Cursor usage limit')
    expect(result.diagnostics.join('\n')).toContain('native failure probe confirmed')
    expect(nativeFallbackCalls).toBe(1)
    expect(createSessionCalls).toBe(0)
  })

  test('surfaces terminal native Cursor preflight before starting an OpenCode host', async () => {
    let prepareProfileCalls = 0
    let ensureHostCalls = 0
    const probe = new OpenCodeExecutionProbe({
      prepareProfile: async (_projectPath, options) => {
        prepareProfileCalls += 1
        expect(options?.includeAppMcp).toBe(false)
        expect(options?.profileScope).toMatchObject({
          purpose: 'execution_probe',
          providerId: 'cursor-acp',
        })
        expect(options?.profileScope?.configFingerprint).not.toContain('placeholder')
        return profile
      },
      hostManager: {
        ensureHost: async () => {
          ensureHostCalls += 1
          return host
        },
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => {
          throw new Error('OpenCode client must not be created after terminal native preflight')
        },
      },
      cursorNativeFailureProbe: {
        probe: async input => {
          expect(input.projectPath).toBe(profile.tmpPath)
          expect(input.delayMs).toBe(0)
          return {
            outcome: 'failure',
            message: 'RESOURCE_EXHAUSTED: Cursor usage limit reached',
            durationMs: 9,
            exitCode: 1,
          }
        },
      },
    })

    await expect(probe.probeModel({
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
      cursorNativePreflightBeforeHost: true,
    })).rejects.toThrow(
      'OpenCode execution_probe does not support extension-bound provider cursor-acp',
    )
    expect(prepareProfileCalls).toBe(0)
    expect(ensureHostCalls).toBe(0)
  })

  test('uses and cleans a lightweight sandbox profile for production native preflight', async () => {
    let nativeProjectPath: string | null = null
    let ensureHostCalls = 0
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => {
          ensureHostCalls += 1
          return host
        },
        releaseHost: async () => {},
      },
      cursorNativeFailureProbe: {
        probe: async input => {
          nativeProjectPath = input.projectPath
          expect((await stat(input.projectPath)).isDirectory()).toBe(true)
          expect(input.env?.CURSOR_AGENT_EXECUTABLE).toContain(
            'native-subscription-cli-bin',
          )
          return {
            outcome: 'failure',
            message: 'RESOURCE_EXHAUSTED: Cursor usage limit reached',
            durationMs: 8,
            exitCode: 1,
          }
        },
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
      bypassCache: true,
      cursorNativePreflightBeforeHost: true,
      cursorNativePreflightOnly: true,
    })

    expect(result.outcome).toBe('unavailable')
    expect(ensureHostCalls).toBe(0)
    expect(nativeProjectPath).not.toBeNull()
    await expect(stat(nativeProjectPath!)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  test('keeps an inconclusive native-only Cursor preflight from starting an OpenCode host', async () => {
    let ensureHostCalls = 0
    const probe = new OpenCodeExecutionProbe({
      prepareProfile: async () => profile,
      hostManager: {
        ensureHost: async () => {
          ensureHostCalls += 1
          return host
        },
        releaseHost: async () => {},
      },
      cursorNativeFailureProbe: {
        probe: async () => null,
      },
    })

    await expect(probe.probeModel({
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
      bypassCache: true,
      cursorNativePreflightBeforeHost: true,
      cursorNativePreflightOnly: true,
    })).rejects.toThrow(
      'OpenCode execution_probe does not support extension-bound provider cursor-acp',
    )
    expect(ensureHostCalls).toBe(0)
  })

  test('returns a bounded failure code when native-only Cursor preflight times out', async () => {
    let ensureHostCalls = 0
    const probe = new OpenCodeExecutionProbe({
      prepareProfile: async () => profile,
      hostManager: {
        ensureHost: async () => {
          ensureHostCalls += 1
          return host
        },
        releaseHost: async () => {},
      },
      cursorNativeFailureProbe: {
        probe: async () => ({
          outcome: 'timeout',
          message: 'Cursor native execution preflight timed out after 65000ms',
          durationMs: 65_000,
          exitCode: null,
        }),
      },
    })

    await expect(probe.probeModel({
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
      bypassCache: true,
      cursorNativePreflightBeforeHost: true,
      cursorNativePreflightOnly: true,
    })).rejects.toThrow(
      'OpenCode execution_probe does not support extension-bound provider cursor-acp',
    )
    expect(ensureHostCalls).toBe(0)
  })

  test('does not accept native Cursor success without canonical assistant model evidence', async () => {
    let createSessionCalls = 0
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => {
            createSessionCalls += 1
            return { id: 'session-1' }
          },
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({ 'session-1': 'busy' }),
          getSessionMessages: async () => [],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'unused' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
      cursorNativeFailureProbe: {
        probe: async () => ({
          outcome: 'available',
          message: null,
          durationMs: 14,
          exitCode: 0,
        }),
      },
      sleep: async () => {},
      probeTimeoutMs: 1_000,
    })

    const result = await probe.probeModel({
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
      cursorNativePreflightBeforeHost: true,
      cursorNativePreflightOnly: true,
    })

    expect(result.outcome).toBe('unknown')
    expect(result.verifiedAt).toBeUndefined()
    expect(result.diagnostics.join('\n')).toContain(
      'without canonical assistant provider/model evidence',
    )
    expect(createSessionCalls).toBe(0)
  })

  test('uses one inconclusive native preflight before a successful OpenCode response', async () => {
    let nativeFallbackCalls = 0
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => ({ id: 'session-1' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({ 'session-1': 'idle' }),
          getSessionMessages: async () => [
            {
              info: {
                id: 'msg-assistant-1',
                role: 'assistant',
                providerID: 'cursor-acp',
                modelID: 'auto',
                sessionID: 'session-1',
                time: { created: 101, completed: 110 },
              },
              parts: [{ type: 'text', text: 'PONG' }],
            },
          ],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'unused' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
      cursorNativeFailureProbe: {
        probe: async () => {
          nativeFallbackCalls += 1
          return null
        },
      },
    })

    const result = await probe.probeModelOnHost({
      host,
      selectedModel: 'cursor-acp/auto',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('available')
    expect(nativeFallbackCalls).toBe(1)
  })

  test('can release execution probe lease without disposing the live host', async () => {
    const retainedLeaseTeamIds: string[] = []
    const releasedLeaseTeamIds: string[] = []
    let releaseHostCount = 0
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        retainHostLease: async (_hostKey, input) => {
          retainedLeaseTeamIds.push(input.teamId)
        },
        releaseHostLease: async (_hostKey, input) => {
          releasedLeaseTeamIds.push(input.teamId)
        },
        releaseHost: async () => {
          releaseHostCount += 1
        },
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => ({ id: 'session-1' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({ 'session-1': 'idle' }),
          getSessionMessages: async () => [
            {
              info: {
                id: 'msg-user-1',
                role: 'user',
                sessionID: 'session-1',
                time: { created: 100 },
              },
              parts: [{ type: 'text', text: 'Output only the single word PONG.' }],
            },
            {
              info: {
                id: 'msg-assistant-1',
                role: 'assistant',
                providerID: 'opencode',
                modelID: 'big-pickle',
                parentID: 'msg-user-1',
                sessionID: 'session-1',
                time: { created: 101, completed: 110 },
              },
              parts: [{ type: 'text', text: 'PONG' }],
            },
          ],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'msg-assistant-1' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'opencode/big-pickle',
      projectPath: '/tmp/project',
      disposeHostOnRelease: false,
    })

    expect(result.outcome).toBe('available')
    expect(retainedLeaseTeamIds).toEqual([OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID])
    expect(releasedLeaseTeamIds).toEqual([OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID])
    expect(releaseHostCount).toBe(0)
  })

  test('starts the polling timeout after the host has accepted the probe prompt', async () => {
    let messageReadCount = 0
    const probe = new OpenCodeExecutionProbe({
      probeTimeoutMs: 5,
      pollIntervalMs: 1,
      sleep: async () => {},
      hostManager: {
        ensureHost: async () => {
          await new Promise(resolve => setTimeout(resolve, 20))
          return host
        },
        retainHostLease: async () => {},
        releaseHostLease: async () => {},
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => ({ id: 'session-1' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({
            'session-1': messageReadCount < 1 ? 'busy' : 'idle',
          }),
          getSessionMessages: async () => {
            messageReadCount += 1
            const messages = [
              {
                info: {
                  id: 'msg-user-1',
                  role: 'user',
                  sessionID: 'session-1',
                  time: { created: 100 },
                },
                parts: [{ type: 'text', text: 'Output only the single word PONG.' }],
              },
            ]
            if (messageReadCount > 1) {
              messages.push({
                info: {
                  id: 'msg-assistant-1',
                  role: 'assistant',
                  providerID: 'opencode',
                  modelID: 'big-pickle',
                  parentID: 'msg-user-1',
                  sessionID: 'session-1',
                  time: { created: 101, completed: 110 },
                },
                parts: [{ type: 'text', text: 'PONG' }],
              })
            }
            return messages
          },
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'msg-assistant-1' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'opencode/big-pickle',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('available')
    expect(messageReadCount).toBe(2)
  })

  test('still releases execution probe lease without disposing the live host when setup fails', async () => {
    const retainedLeaseTeamIds: string[] = []
    const releasedLeaseTeamIds: string[] = []
    let releaseHostCount = 0
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        retainHostLease: async (_hostKey, input) => {
          retainedLeaseTeamIds.push(input.teamId)
        },
        releaseHostLease: async (_hostKey, input) => {
          releasedLeaseTeamIds.push(input.teamId)
        },
        releaseHost: async () => {
          releaseHostCount += 1
        },
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => {
            throw new Error('create session failed')
          },
          getSession: async () => {
            throw new Error('not used')
          },
          getSessionStatus: async () => {
            throw new Error('not used')
          },
          getSessionMessages: async () => {
            throw new Error('not used')
          },
          getPermissions: async () => [],
          sendSessionMessage: async () => {
            throw new Error('not used')
          },
          promptSessionAsync: async () => {
            throw new Error('not used')
          },
          abortSession: async () => true,
        }),
      },
    })

    await expect(probe.probeModel({
      selectedModel: 'opencode/big-pickle',
      projectPath: '/tmp/project',
      disposeHostOnRelease: false,
    })).rejects.toThrow('create session failed')

    expect(retainedLeaseTeamIds).toEqual([OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID])
    expect(releasedLeaseTeamIds).toEqual([OPEN_CODE_PREFLIGHT_HOST_LEASE_TEAM_ID])
    expect(releaseHostCount).toBe(0)
  })

  test.each([
    'Token refresh failed: 401',
    'Invalid API key.',
    'API key not valid. Please pass a valid API key.',
    'API key is revoked',
  ])('marks model auth as invalid when OpenCode returns %s', async authFailure => {
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => ({ id: 'session-1' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({ 'session-1': 'idle' }),
          getSessionMessages: async () => [
            {
              info: {
                id: 'msg-assistant-error',
                role: 'assistant',
                sessionID: 'session-1',
                time: { created: 101, completed: 110 },
                error: {
                  name: 'UnknownError',
                  message: 'Model unavailable',
                  data: {
                    message: authFailure,
                  },
                },
              },
              parts: [],
            },
          ],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'msg-assistant-error' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'openai/gpt-5.4-mini',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('not_authenticated')
    expect(result.reason).toContain(authFailure)
    expect(result.durableState).toBe('error')
  })

  test('surfaces stringified nested provider rate-limit errors while the session is retrying', async () => {
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => ({ id: 'session-1' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({
            'session-1': {
              type: 'retry',
              attempt: 1,
            },
          }),
          getSessionMessages: async () => [
            {
              info: {
                id: 'msg-assistant-error',
                role: 'assistant',
                sessionID: 'session-1',
                time: { created: 101, completed: 110 },
                error: JSON.stringify({
                  name: 'AI_APICallError',
                  message: 'Provider request failed',
                  errors: [
                    {
                      data: {
                        error: {
                          type: 'FreeUsageLimitError',
                          message: 'Rate limit exceeded. Please try again later.',
                        },
                      },
                    },
                  ],
                  statusCode: 429,
                }),
              },
              parts: [],
            },
          ],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'msg-assistant-error' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'opencode/ling-2.6-flash-free',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('unavailable')
    expect(result.reason).toBe('Rate limit exceeded. Please try again later.')
    expect(result.durableState).toBe('retrying')
    expect(result.diagnostics.join('\n')).toContain(
      'retry/error payload exposed a terminal provider failure',
    )
  })

  test.each([
    [401, 'Доступ відхилено', 'not_authenticated'],
    [403, 'Доступ відхилено', 'not_authenticated'],
    ['401', 'Доступ відхилено', 'not_authenticated'],
    ['403', 'Доступ відхилено', 'not_authenticated'],
    [401, 'RESOURCE_EXHAUSTED', 'unavailable'],
    [200, 'Доступ відхилено', 'unknown'],
  ] as const)('classifies structural HTTP %s with message %s as %s', async (statusCode, message, outcome) => {
    const probe = new OpenCodeExecutionProbe({
      probeTimeoutMs: 10, pollIntervalMs: 1,
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getServerDoc: async () => { throw new Error('not used') },
          authorizeProviderOAuth: async () => { throw new Error('not used') },
          completeProviderOAuth: async () => { throw new Error('not used') },
          setProviderAuth: async () => { throw new Error('not used') },
          deleteProviderAuth: async () => { throw new Error('not used') },
          listExperimentalToolIds: async () => { throw new Error('not used') },
          listExperimentalTools: async () => { throw new Error('not used') },
          answerPermission: async () => { throw new Error('not used') },
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => ({ id: 'session-1' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({
            'session-1': {
              type: 'retry',
              attempt: 1,
            },
          }),
          getSessionMessages: async () => [
            {
              info: {
                id: 'msg-assistant-error',
                role: 'assistant',
                sessionID: 'session-1',
                time: { created: 101, completed: 110 },
                error: { name: 'APIError', data: { statusCode, message, usage: { tokens: 401 } } },
              },
              parts: [],
            },
          ],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'msg-assistant-error' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'opencode/ling-2.6-flash-free',
      projectPath: '/tmp/project',
    })

    expect(result.verifiedAt).toBeUndefined()
    expect(result.outcome).toBe(outcome)
    expect(result.reason).toBe(outcome === 'not_authenticated' ? `HTTP ${statusCode}: ${message}` : message)
    expect(result.durableState).toBe('retrying')
  })

  // Payload shape captured from a real Zen free-tier refusal (opencode 1.18.4).
  const freeTierApiError = {
    name: 'APIError',
    data: {
      message: "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode",
      statusCode: 403,
      isRetryable: false,
      responseBody: JSON.stringify({
        type: 'error',
        error: {
          type: 'FreeTierError',
          message: "Error from provider (Console): OpenCode's free tier can only be used from within OpenCode",
        },
      }),
      metadata: { url: 'https://opencode.ai/zen/v1/chat/completions' },
    },
  }

  test.each([
    ['a free-tier refusal', freeTierApiError, 'unavailable', 'free_tier_restricted'],
    [
      'a plain 403',
      { name: 'APIError', data: { statusCode: 403, message: 'Forbidden', responseBody: '{"error":{"type":"AuthError"}}' } },
      'not_authenticated',
      undefined,
    ],
    ['a 401', { name: 'APIError', data: { statusCode: 401, message: 'Invalid API key' } }, 'not_authenticated', undefined],
  ] as const)('classifies %s structurally, not by its HTTP status alone', async (_label, error, outcome, failureCode) => {
    const probe = new OpenCodeExecutionProbe({
      probeTimeoutMs: 10, pollIntervalMs: 1,
      hostManager: { ensureHost: async () => host, releaseHost: async () => {} },
      clientFactory: {
        create: () => ({
          getServerDoc: async () => { throw new Error('not used') },
          authorizeProviderOAuth: async () => { throw new Error('not used') },
          completeProviderOAuth: async () => { throw new Error('not used') },
          setProviderAuth: async () => { throw new Error('not used') },
          deleteProviderAuth: async () => { throw new Error('not used') },
          listExperimentalToolIds: async () => { throw new Error('not used') },
          listExperimentalTools: async () => { throw new Error('not used') },
          answerPermission: async () => { throw new Error('not used') },
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => ({ id: 'session-1' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({ 'session-1': { type: 'idle' } }),
          getSessionMessages: async () => [
            {
              info: {
                id: 'msg-assistant-error',
                role: 'assistant',
                sessionID: 'session-1',
                time: { created: 101, completed: 110 },
                error,
              },
              parts: [],
            },
          ],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'msg-assistant-error' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'opencode/big-pickle',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe(outcome)
    expect(result.failureCode).toBe(failureCode)
    if (failureCode) {
      expect(result.reason).toBe(OPEN_CODE_FREE_TIER_RESTRICTED_REASON)
    }
  })

  const rejectedToolTurnCases: Array<[string, { created: number; completed?: number }, 'error' | 'pending']> = [
    ['a completed tool-only turn', { created: 101, completed: 110 }, 'error'],
    // Safety net: a tool part left pending with the session idle never completes by itself.
    ['a stuck tool call on an idle session', { created: 101 }, 'pending'],
  ]
  test.each(rejectedToolTurnCases)('ends a probe right away when a rejected tool call leaves %s without text', async (_label, messageTime, toolStatus) => {
    let statusCalls = 0
    let permissionCalls = 0
    const answers: Array<{ requestId: string; sessionId?: string | null; decision: string; message?: string }> = []
    const probe = new OpenCodeExecutionProbe({
      probeTimeoutMs: 60_000, pollIntervalMs: 1,
      hostManager: { ensureHost: async () => host, releaseHost: async () => {} },
      clientFactory: {
        create: () => ({
          getServerDoc: async () => { throw new Error('not used') },
          authorizeProviderOAuth: async () => { throw new Error('not used') },
          completeProviderOAuth: async () => { throw new Error('not used') },
          setProviderAuth: async () => { throw new Error('not used') },
          deleteProviderAuth: async () => { throw new Error('not used') },
          listExperimentalToolIds: async () => { throw new Error('not used') },
          listExperimentalTools: async () => { throw new Error('not used') },
          answerPermission: async body => { answers.push(body) },
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => ({ id: 'session-1' }),
          getSession: async () => ({ id: 'session-1' }),
          // Busy while the tool call waits for permission, then idle once the turn stops.
          getSessionStatus: async () => ({ 'session-1': { type: (statusCalls += 1) <= 6 ? 'busy' : 'idle' } }),
          getSessionMessages: async () => [
            {
              info: {
                id: 'msg-assistant-tool',
                role: 'assistant',
                sessionID: 'session-1',
                time: messageTime,
              },
              parts: [
                { type: 'tool', tool: 'bash', callID: 'call-1', state: { status: toolStatus, ...(toolStatus === 'error' ? { error: 'rejected' } : {}) } },
              ],
            },
          ],
          getPermissions: async () => (permissionCalls += 1) === 1
            ? [{ id: 'perm-1', sessionID: 'session-1', permission: 'bash', patterns: ['ls'], tool: { messageID: 'msg-assistant-tool', callID: 'call-1' } }]
            : [],
          sendSessionMessage: async () => ({ info: { id: 'msg-assistant-tool' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const startedAt = Date.now()
    const result = await probe.probeModel({
      selectedModel: 'opencode/big-pickle',
      projectPath: '/tmp/project',
    })

    expect(answers).toEqual([{
      requestId: 'perm-1', sessionId: 'session-1', decision: 'reject', message: OPEN_CODE_PROBE_PERMISSION_REJECT_MESSAGE,
    }])
    expect(result.outcome).toBe('unknown')
    expect(result.reason).toBe('OpenCode model verification ended after the model tried to use a tool instead of answering')
    expect(result.failureCode).toBeUndefined()
    // Well before the 60 s probe deadline: it does not wait for a reply that cannot come.
    expect(Date.now() - startedAt).toBeLessThan(10_000)
  })

  test('rejects only the probe session permission requests and never approves one', async () => {
    const answers: Array<{ requestId: string; sessionId?: string | null; decision: string; message?: string }> = []
    const diagnostics = new Set<string>()
    // OpenCode 1.18 request shape: the tool name is in `permission`, `tool` is the call reference.
    const rejected = await rejectProbeSessionPermissions({
      getPermissions: async () => [
        { id: 'perm-probe', sessionID: 'session-1', permission: 'bash', patterns: ['ls'], tool: { messageID: 'msg-1', callID: 'call-1' } },
        { id: 'perm-other', sessionID: 'other-session', permission: 'edit', patterns: ['*'], tool: { messageID: 'msg-2', callID: 'call-2' } },
      ],
      answerPermission: async body => { answers.push(body) },
    }, 'session-1', diagnostics)

    expect(rejected).toBe(1)
    // A reject with a message becomes feedback for the model instead of blocking the turn.
    expect(answers).toEqual([{
      requestId: 'perm-probe',
      sessionId: 'session-1',
      decision: 'reject',
      message: OPEN_CODE_PROBE_PERMISSION_REJECT_MESSAGE,
    }])
    expect(Array.from(diagnostics)).toEqual(['OpenCode probe rejected a bash permission request'])
  })

  test('runs every generic execution proof fresh, including concurrent requests', async () => {
    let createSessionCount = 0
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => {
            createSessionCount += 1
            return { id: 'session-1' }
          },
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({ 'session-1': 'idle' }),
          getSessionMessages: async () => [
            {
              info: {
                id: 'msg-assistant-1',
                role: 'assistant',
                providerID: 'opencode',
                modelID: 'minimax-m2.5-free',
                parentID: 'msg-user-1',
                sessionID: 'session-1',
                time: { created: 101, completed: 110 },
              },
              parts: [{ type: 'text', text: 'PONG' }],
            },
          ],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'msg-assistant-1' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const input = {
      selectedModel: 'opencode/minimax-m2.5-free',
      projectPath: '/tmp/project',
    }
    const [first, second] = await Promise.all([
      probe.probeModel(input),
      probe.probeModel(input),
    ])
    const third = await probe.probeModel(input)

    expect(first.outcome).toBe('available')
    expect(second.outcome).toBe('available')
    expect(third.outcome).toBe('available')
    expect(createSessionCount).toBe(3)
  })

  test('bounds independent concurrent callers by their own runtime deadlines', async () => {
    let createSessionCount = 0
    let releaseCreateSession!: () => void
    let markCreateSessionStarted!: () => void
    const createSessionStarted = new Promise<void>(resolve => {
      markCreateSessionStarted = resolve
    })
    const createSessionGate = new Promise<void>(resolve => {
      releaseCreateSession = resolve
    })
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => {
            createSessionCount += 1
            markCreateSessionStarted()
            await createSessionGate
            return { id: 'session-1' }
          },
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({ 'session-1': 'idle' }),
          getSessionMessages: async () => [
            {
              info: {
                id: 'msg-assistant-1',
                role: 'assistant',
                providerID: 'opencode',
                modelID: 'minimax-m2.5-free',
                parentID: 'msg-user-1',
                sessionID: 'session-1',
                time: { created: 101, completed: 110 },
              },
              parts: [{ type: 'text', text: 'PONG' }],
            },
          ],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'unused' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })
    const input = {
      selectedModel: 'opencode/minimax-m2.5-free',
      projectPath: '/tmp/project',
    }
    const sharedProbe = probe.probeModel(input)
    await createSessionStarted
    const deadline = new OpenCodeRuntimeDeadline(20)
    try {
      await expect(probe.probeModel({
        ...input,
        runtimeDeadline: deadline,
      })).rejects.toMatchObject({
        name: 'OpenCodeRuntimeDeadlineError',
        phase: expect.any(String),
      })
    } finally {
      deadline.dispose()
      releaseCreateSession()
    }

    await expect(sharedProbe).resolves.toMatchObject({ outcome: 'available' })
    expect(createSessionCount).toBeGreaterThanOrEqual(1)
    expect(createSessionCount).toBeLessThanOrEqual(2)
  })

  test('does not let a short in-flight owner deadline abort a longer caller', async () => {
    let createSessionCount = 0
    let markFirstCreateStarted!: () => void
    const firstCreateStarted = new Promise<void>(resolve => {
      markFirstCreateStarted = resolve
    })
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => {
            createSessionCount += 1
            if (createSessionCount === 1) {
              markFirstCreateStarted()
              return await new Promise<{ id: string }>(() => {})
            }
            return { id: `session-${createSessionCount}` }
          },
          getSession: async id => ({ id }),
          getSessionStatus: async () => ({ [`session-${createSessionCount}`]: 'idle' }),
          getSessionMessages: async () => [{
            info: {
              id: 'msg-assistant-1',
              role: 'assistant',
              providerID: 'opencode',
              modelID: 'minimax-m2.5-free',
              sessionID: `session-${createSessionCount}`,
              time: { created: 101, completed: 110 },
            },
            parts: [{ type: 'text', text: 'PONG' }],
          }],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'unused' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })
    const input = {
      selectedModel: 'opencode/minimax-m2.5-free',
      projectPath: '/tmp/project',
    }
    const shortDeadline = new OpenCodeRuntimeDeadline(30)
    try {
      const shortOwner = probe.probeModel({
        ...input,
        runtimeDeadline: shortDeadline,
      })
      await firstCreateStarted
      const longerCaller = probe.probeModel(input)

      await expect(shortOwner).rejects.toMatchObject({
        name: 'OpenCodeRuntimeDeadlineError',
      })
      await expect(longerCaller).resolves.toMatchObject({ outcome: 'available' })
    } finally {
      shortDeadline.dispose()
    }
    expect(createSessionCount).toBe(2)
  })

  test('treats bypassCache as equivalent because generic caching is disabled', async () => {
    let createSessionCount = 0
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => {
            createSessionCount += 1
            return { id: `session-${createSessionCount}` }
          },
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({ [`session-${createSessionCount}`]: 'idle' }),
          getSessionMessages: async () => [
            {
              info: {
                id: `msg-assistant-${createSessionCount}`,
                role: 'assistant',
                providerID: 'opencode',
                modelID: 'minimax-m2.5-free',
                parentID: `msg-user-${createSessionCount}`,
                sessionID: `session-${createSessionCount}`,
                time: { created: 101, completed: 110 },
              },
              parts: [{ type: 'text', text: 'PONG' }],
            },
          ],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'msg-assistant-1' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const input = {
      selectedModel: 'opencode/minimax-m2.5-free',
      projectPath: '/tmp/project',
    }
    const first = await probe.probeModel(input)
    const second = await probe.probeModel({ ...input, bypassCache: true })
    const third = await probe.probeModel(input)

    expect(first.outcome).toBe('available')
    expect(second.outcome).toBe('available')
    expect(third.outcome).toBe('available')
    expect(createSessionCount).toBe(3)
  })

  test('does not read or store persistent generic probe proofs', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-probe-cache-'))
    try {
      let createSessionCount = 0
      const cachedProfile: OpenCodePreparedProfile = {
        ...profile,
        profileRootPath: tempDir,
        homePath: path.join(tempDir, 'home'),
        tmpPath: path.join(tempDir, 'tmp'),
        xdgConfigHome: path.join(tempDir, 'config'),
        xdgDataHome: path.join(tempDir, 'data'),
        xdgCacheHome: path.join(tempDir, 'cache'),
        managedAuthPath: path.join(tempDir, 'data/opencode/auth.json'),
      }
      const cachedHost: OpenCodeHostHandle = {
        ...host,
        profile: cachedProfile,
      }
      const makeProbe = (
        resolvedConfigFingerprint = cachedHost.resolvedConfigFingerprint,
      ) => new OpenCodeExecutionProbe({
        persistentCache: true,
        persistentCacheRoot: tempDir,
        sleep: async () => new Promise(resolve => setTimeout(resolve, 1)),
        hostManager: {
          ensureHost: async () => ({
            ...cachedHost,
            resolvedConfigFingerprint,
          }),
          releaseHost: async () => {},
        },
        clientFactory: {
          create: () => ({
            getConfig: async () => {
              throw new Error('not used')
            },
            getConfigProviders: async () => {
              throw new Error('not used')
            },
            getProviders: async () => {
              throw new Error('not used')
            },
            getProviderAuth: async () => {
              throw new Error('not used')
            },
            listAgents: async () => {
              throw new Error('not used')
            },
            getMcp: async () => {
              throw new Error('not used')
            },
            createSession: async () => {
              createSessionCount += 1
              await new Promise(resolve => setTimeout(resolve, 20))
              return { id: 'session-1' }
            },
            getSession: async () => ({ id: 'session-1' }),
            getSessionStatus: async () => ({ 'session-1': 'idle' }),
            getSessionMessages: async () => [
              {
                info: {
                  id: 'msg-assistant-1',
                  role: 'assistant',
                  providerID: 'opencode',
                  modelID: 'minimax-m2.5-free',
                  parentID: 'msg-user-1',
                  sessionID: 'session-1',
                  time: { created: 101, completed: 110 },
                },
                parts: [{ type: 'text', text: 'PONG' }],
              },
            ],
            getPermissions: async () => [],
            sendSessionMessage: async () => ({ info: { id: 'msg-assistant-1' }, parts: [] }),
            promptSessionAsync: async () => {},
            abortSession: async () => true,
          }),
        },
      })

      const input = {
        selectedModel: 'opencode/minimax-m2.5-free',
        projectPath: '/tmp/project',
      }
      const [first, second] = await Promise.all([
        makeProbe().probeModel(input),
        makeProbe().probeModel(input),
      ])
      const third = await makeProbe('resolved-after-app-mcp-refresh').probeModel(input)

      expect(first.outcome).toBe('available')
      expect(second.outcome).toBe('available')
      expect(third.outcome).toBe('available')
      expect(createSessionCount).toBe(3)
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('waits for a delayed assistant reply before deciding the probe outcome', async () => {
    let statusCallCount = 0
    let messageCallCount = 0
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      pollIntervalMs: 0,
      probeTimeoutMs: 50,
      sleep: async () => {},
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => ({ id: 'session-1' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => {
            statusCallCount += 1
            return {
              'session-1':
                statusCallCount === 4
                  ? 'busy'
                  : 'idle',
            }
          },
          getSessionMessages: async () => {
            messageCallCount += 1
            if (messageCallCount < 7) {
              return [
                {
                  info: {
                    id: 'msg-user-1',
                    role: 'user',
                    sessionID: 'session-1',
                    time: { created: 100 },
                  },
                  parts: [{ type: 'text', text: 'Output only the single word PONG.' }],
                },
              ]
            }
            return [
              {
                info: {
                  id: 'msg-user-1',
                  role: 'user',
                  sessionID: 'session-1',
                  time: { created: 100 },
                },
                parts: [{ type: 'text', text: 'Output only the single word PONG.' }],
              },
              {
                info: {
                  id: 'msg-assistant-1',
                  role: 'assistant',
                  providerID: 'opencode',
                  modelID: 'minimax-m2.5-free',
                  parentID: 'msg-user-1',
                  sessionID: 'session-1',
                  time: { created: 101, completed: 110 },
                },
                parts: [{ type: 'text', text: 'PONG' }],
              },
            ]
          },
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'msg-user-1' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'opencode/minimax-m2.5-free',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('available')
    expect(statusCallCount).toBeGreaterThanOrEqual(7)
    expect(messageCallCount).toBeGreaterThanOrEqual(7)
  })

  test('returns a timeout when OpenCode never produces an assistant reply before the probe deadline', async () => {
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      pollIntervalMs: 0,
      probeTimeoutMs: 1,
      sleep: async () => {},
      clientFactory: {
        create: () => ({
          getConfig: async () => {
            throw new Error('not used')
          },
          getConfigProviders: async () => {
            throw new Error('not used')
          },
          getProviders: async () => {
            throw new Error('not used')
          },
          getProviderAuth: async () => {
            throw new Error('not used')
          },
          listAgents: async () => {
            throw new Error('not used')
          },
          getMcp: async () => {
            throw new Error('not used')
          },
          createSession: async () => ({ id: 'session-1' }),
          getSession: async () => ({ id: 'session-1' }),
          getSessionStatus: async () => ({ 'session-1': 'busy' }),
          getSessionMessages: async () => [
            {
              info: {
                id: 'msg-user-1',
                role: 'user',
                sessionID: 'session-1',
                time: { created: 100 },
              },
              parts: [{ type: 'text', text: 'Output only the single word PONG.' }],
            },
          ],
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: { id: 'msg-user-1' }, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    const result = await probe.probeModel({
      selectedModel: 'opencode/minimax-m2.5-free',
      projectPath: '/tmp/project',
    })

    expect(result.outcome).toBe('unknown')
    expect(result.reason).toBe('Model verification timed out')
  })

  test('uses the shared runtime deadline instead of the legacy local poll cap', async () => {
    let statusCallCount = 0
    let messageCallCount = 0
    const runtimeDeadline = new OpenCodeRuntimeDeadline(200)
    const probe = new OpenCodeExecutionProbe({
      probeTimeoutMs: 1,
      pollIntervalMs: 2,
      hostManager: {
        ensureHost: async () => host,
        releaseHost: async () => {},
      },
      clientFactory: {
        create: () => ({
          getConfig: async () => { throw new Error('not used') },
          getConfigProviders: async () => { throw new Error('not used') },
          getProviders: async () => { throw new Error('not used') },
          getProviderAuth: async () => { throw new Error('not used') },
          listAgents: async () => { throw new Error('not used') },
          getMcp: async () => { throw new Error('not used') },
          createSession: async () => ({ id: 'session-runtime-deadline' }),
          getSession: async () => ({ id: 'session-runtime-deadline' }),
          getSessionStatus: async () => {
            statusCallCount += 1
            return {
              'session-runtime-deadline': statusCallCount < 3 ? 'busy' : 'idle',
            }
          },
          getSessionMessages: async () => {
            messageCallCount += 1
            const messages: OpenCodeMessage[] = [{
              info: {
                id: 'msg-user-runtime-deadline',
                role: 'user',
                sessionID: 'session-runtime-deadline',
                time: { created: 100 },
              },
              parts: [{ type: 'text', text: 'Output only the single word PONG.' }],
            }]
            if (messageCallCount >= 3) {
              messages.push({
                info: {
                  id: 'msg-assistant-runtime-deadline',
                  role: 'assistant',
                  providerID: 'ollama',
                  modelID: 'gemma4:12b',
                  parentID: 'msg-user-runtime-deadline',
                  sessionID: 'session-runtime-deadline',
                  time: { created: 101, completed: 110 },
                },
                parts: [{ type: 'text', text: 'PONG' }],
              })
            }
            return messages
          },
          getPermissions: async () => [],
          sendSessionMessage: async () => ({ info: {}, parts: [] }),
          promptSessionAsync: async () => {},
          abortSession: async () => true,
        }),
      },
    })

    try {
      const result = await probe.probeModel({
        selectedModel: 'ollama/gemma4:12b',
        projectPath: '/tmp/project',
        bypassCache: true,
        runtimeDeadline,
      })

      expect(result.outcome).toBe('available')
      expect(messageCallCount).toBeGreaterThanOrEqual(3)
    } finally {
      runtimeDeadline.dispose()
    }
  })

  test('returns the runtime deadline when host startup ignores cancellation', async () => {
    const runtimeDeadline = new OpenCodeRuntimeDeadline(10)
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => new Promise<OpenCodeHostHandle>(() => {}),
        releaseHost: async () => {},
      },
      hostStartupCleanupTimeoutMs: 10,
    })

    try {
      const result = probe.probeModel({
        selectedModel: 'ollama/gemma4:12b',
        projectPath: '/tmp/project',
        bypassCache: true,
        runtimeDeadline,
      })
      const testGuard = new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error('host startup deadline did not settle')),
          500,
        )
        timer.unref?.()
      })

      await expect(Promise.race([result, testGuard])).rejects.toBeInstanceOf(
        OpenCodeRuntimeDeadlineError,
      )
    } finally {
      runtimeDeadline.dispose()
    }
  })

  test('releases a host that finishes startup after the runtime deadline', async () => {
    let now = 0
    let expireDeadline = () => {
      throw new Error('runtime deadline timer was not installed')
    }
    let resolveHost = (_value: OpenCodeHostHandle) => {
      throw new Error('host startup did not begin')
    }
    let markHostStartupStarted!: () => void
    const hostStartupStarted = new Promise<void>(resolve => {
      markHostStartupStarted = resolve
    })
    let releaseHostCount = 0
    const runtimeDeadline = new OpenCodeRuntimeDeadline(10, {
      monotonicNow: () => now,
      setTimer: callback => {
        expireDeadline = callback
        return { unref() {} } as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {},
    })
    const probe = new OpenCodeExecutionProbe({
      hostManager: {
        ensureHost: async () => new Promise<OpenCodeHostHandle>(resolve => {
          resolveHost = resolve
          markHostStartupStarted()
        }),
        releaseHost: async () => {
          releaseHostCount += 1
        },
      },
      hostStartupCleanupTimeoutMs: 250,
    })

    try {
      const result = probe.probeModel({
        selectedModel: 'ollama/gemma4:12b',
        projectPath: '/tmp/project',
        bypassCache: true,
        runtimeDeadline,
      })
      await hostStartupStarted
      now = 10
      expireDeadline()
      resolveHost(host)

      await expect(result).rejects.toBeInstanceOf(OpenCodeRuntimeDeadlineError)
      expect(releaseHostCount).toBe(1)
    } finally {
      runtimeDeadline.dispose()
    }
  })
})
