import path from 'node:path'
import { createHash } from 'node:crypto'
import { canonicalExecutionJSON, executionAssert, executionRecord } from '../../execution/OpenCodeV2ExecutionContracts.js'

const MAX_BYTES = 16 * 1024
const RECORD_NAMES = new Set(['owner.json', 'release.json', 'containment.json', 'child.json'])

export type WindowsOwnerFileIdentity = Readonly<{
  volumeSerial: string; fileId: string; ownerSid: string
}>
export type WindowsOwnerNativeRequest =
  | Readonly<{ op: 'ownerValidateSelectedProfile'; root: string; databasePath: string; directories: readonly string[] }>
  | Readonly<{ op: 'ownerOpenDirectory' | 'ownerPreparePrivateDirectory'; path: string; createExclusive: boolean }>
  | Readonly<{ op: 'ownerAssertDirectory'; handleId: string; path: string }>
  | Readonly<{ op: 'ownerWritePreparedConfig' | 'ownerWritePreparedAuth'; handleId: string; bytesBase64: string; sha256: string }>
  | Readonly<{ op: 'ownerWriteExclusive'; handleId: string; name: string; bytesBase64: string }>
  | Readonly<{ op: 'ownerReadRecord'; handleId: string; name: string; maxBytes: number }>
  | Readonly<{ op: 'ownerReadMetadata'; purpose: 'ProbeGuard' | 'ProbeRecord'; handleId: string }>
  | Readonly<{ op: 'ownerReadMetadata'; purpose: 'SelectedAuth'; selectionId: string }>
  | Readonly<{ op: 'ownerWriteMetadata'; purpose: 'ProbeGuard' | 'ProbeRecord'; handleId: string; bytesBase64: string }>
  | Readonly<{ op: 'ownerArchive'; handleId: string; source: string; destination: string }>
  | Readonly<{ op: 'ownerCloseDirectory'; handleId: string }>

/** The selected persistent native helper owns the handles. This port is not a
 * qualification receipt: production must bind it to the authenticated helper. */
export type WindowsOwnerNativePort = (request: WindowsOwnerNativeRequest, deadline?: number, signal?: AbortSignal) => Promise<unknown>

function canonicalPath(value: string): string {
  executionAssert(/^[a-z]:\\/i.test(value) && !/[\x00-\x1f]/.test(value), 'execution_owner_path_invalid')
  const parts = value.slice(3).split('\\')
  executionAssert(parts.length > 0 && parts.every(part => part.length > 0 &&
    !/[<>:"|?*]/.test(part) && !/[. ]$/.test(part) &&
    !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)), 'execution_owner_path_invalid')
  executionAssert(path.win32.normalize(value) === value, 'execution_owner_path_invalid')
  return value
}

function response(value: unknown): Record<string, unknown> {
  const row = executionRecord(value)
  executionAssert(row.schema === 1 && row.ok === true, 'execution_owner_unknown')
  return row
}
function identity(value: unknown): WindowsOwnerFileIdentity {
  const row = executionRecord(value)
  executionAssert(Object.keys(row).sort().join(',') === 'fileId,ownerSid,volumeSerial' &&
    typeof row.volumeSerial === 'string' && /^\d{1,20}$/.test(row.volumeSerial) &&
    typeof row.fileId === 'string' && /^[a-f0-9]{32}$/i.test(row.fileId) &&
    typeof row.ownerSid === 'string' && /^S-1-\d+(?:-\d+)+$/.test(row.ownerSid), 'execution_owner_unknown')
  return Object.freeze({ volumeSerial: row.volumeSerial, fileId: row.fileId.toLowerCase(), ownerSid: row.ownerSid })
}
function sameIdentity(left: WindowsOwnerFileIdentity, right: WindowsOwnerFileIdentity): boolean {
  return left.volumeSerial === right.volumeSerial && left.fileId === right.fileId && left.ownerSid === right.ownerSid
}
function directory(row: Record<string, unknown>, expectedPath: string): WindowsOwnerFileIdentity {
  executionAssert(row.path === expectedPath && row.directory === true && row.reparse === false &&
    row.privateAcl === true, 'execution_owner_unknown')
  return identity(row.identity)
}
function name(value: string): void { executionAssert(RECORD_NAMES.has(value), 'execution_owner_record_invalid') }

function metadataResponse(value: unknown, purpose: 'ProbeGuard' | 'ProbeRecord' | 'SelectedAuth',
  expectedPath: string | null): Record<string, unknown> {
  const row = response(value)
  const common = ['schema', 'ok', 'purpose', 'path', 'directoryIdentity', 'fileIdentity', 'bytes', 'privateAcl', 'reparse', 'links']
  const expected = purpose === 'SelectedAuth' ? [...common, 'rootIdentity', 'sha256'] :
    purpose === 'ProbeGuard' ? common : undefined
  executionAssert(row.purpose === purpose && typeof row.path === 'string' && canonicalPath(row.path) &&
    (expectedPath === null || row.path === expectedPath) &&
    row.privateAcl === true && row.reparse === false && row.links === 1 &&
    Number.isSafeInteger(row.bytes) && Number(row.bytes) >= 0, 'execution_owner_unknown')
  identity(row.directoryIdentity)
  const fileIdentity = row.fileIdentity === null ? null : identity(row.fileIdentity)
  if (purpose === 'ProbeGuard') {
    executionAssert(expected && Object.keys(row).sort().join(',') === [...expected].sort().join(',') &&
      row.bytes === 0 && fileIdentity !== null, 'execution_owner_unknown')
  } else if (purpose === 'ProbeRecord') {
    if (row.absent === true) {
      executionAssert(Object.keys(row).sort().join(',') === [...common, 'absent'].sort().join(',') &&
        row.bytes === 0 && fileIdentity === null && !Object.hasOwn(row, 'bytesBase64') &&
        !Object.hasOwn(row, 'sha256'), 'execution_owner_unknown')
    } else {
      executionAssert(Object.keys(row).sort().join(',') === [...common, 'bytesBase64'].sort().join(',') &&
        fileIdentity !== null && Number(row.bytes) > 0 && Number(row.bytes) < 131072 &&
        typeof row.bytesBase64 === 'string', 'execution_owner_unknown')
      const bytes = Buffer.from(row.bytesBase64, 'base64')
      executionAssert(bytes.length === Number(row.bytes) && bytes.toString('base64') === row.bytesBase64, 'execution_owner_unknown')
      try { executionRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))) }
      catch { throw new Error('execution_owner_unknown') }
    }
  } else {
    executionAssert(expected && Object.keys(row).sort().join(',') === [...expected].sort().join(',') &&
      fileIdentity !== null && Number(row.bytes) > 0 && Number(row.bytes) <= 131072 &&
      typeof row.sha256 === 'string' && /^[a-f0-9]{64}$/.test(row.sha256), 'execution_owner_unknown')
    identity(row.rootIdentity)
  }
  return row
}

function metadataBytes(row: Record<string, unknown>): Buffer {
  executionAssert(typeof row.bytesBase64 === 'string', 'execution_owner_unknown')
  return Buffer.from(row.bytesBase64, 'base64')
}

function requestLive(deadline?: number, signal?: AbortSignal): void {
  signal?.throwIfAborted()
  executionAssert(deadline === undefined || (Number.isFinite(deadline) && deadline > Date.now()), 'execution_timeout')
}

export type WindowsOwnerDirectory = Readonly<{
  identity: WindowsOwnerFileIdentity
  assertOwned(deadline?: number, signal?: AbortSignal): Promise<void>
  writeExclusive(name: string, value: unknown, deadline?: number, signal?: AbortSignal): Promise<void>
  writePreparedConfig(content: string, sha256: string, deadline?: number, signal?: AbortSignal): Promise<void>
  writePreparedAuth(content: string, sha256: string, deadline?: number, signal?: AbortSignal): Promise<void>
  readRecord(name: string, deadline?: number, signal?: AbortSignal): Promise<unknown>
  readMetadata(purpose: 'ProbeGuard' | 'ProbeRecord', deadline?: number, signal?: AbortSignal): Promise<Readonly<{
    purpose: 'ProbeGuard' | 'ProbeRecord'; path: string; directoryIdentity: WindowsOwnerFileIdentity
    fileIdentity: WindowsOwnerFileIdentity | null; bytes: number; absent?: true; value?: Record<string, unknown>
  }>>
  writeMetadata(purpose: 'ProbeGuard' | 'ProbeRecord', value: unknown, deadline?: number, signal?: AbortSignal): Promise<void>
  archive(destination: string): Promise<void>
  close(): Promise<void>
}>

/** CreateDirectoryW is exclusive; an existing or partial fence is never adopted
 * by createDirectory. No rollback removes it after an uncertain native failure.
 * Open is read-only authority acquisition, not ownership/adoption of a fence. */
export function createWindowsOwnerFilesystem(native: WindowsOwnerNativePort, selectedDirectories: readonly string[] = []) {
  const directoryPaths = Object.freeze([...new Set(selectedDirectories.map(canonicalPath))])
  const acquire = async (requestedPath: string, createExclusive: boolean, deadline?: number, signal?: AbortSignal, prepareOnly = false): Promise<WindowsOwnerDirectory> => {
    executionAssert(process.platform === 'win32', 'execution_owner_platform_pending')
    requestLive(deadline, signal)
    let currentPath = canonicalPath(requestedPath)
    const opened = response(await native({ op: prepareOnly ? 'ownerPreparePrivateDirectory' : 'ownerOpenDirectory', path: currentPath, createExclusive }, deadline, signal))
    const originalIdentity = directory(opened, currentPath)
    executionAssert(typeof opened.handleId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(opened.handleId), 'execution_owner_unknown')
    const handleId = opened.handleId
    let closed = false, uncertain = false, archived = false
    let pending: Promise<void> = Promise.resolve()
    const serialize = <T>(action: () => Promise<T>): Promise<T> => {
      const result = pending.then(action)
      pending = result.then(() => undefined, () => undefined)
      return result
    }
    const assertOwned = async (assertDeadline?: number, assertSignal?: AbortSignal): Promise<void> => {
      executionAssert(!closed && !uncertain, 'execution_owner_unknown')
      requestLive(assertDeadline, assertSignal)
      const row = response(await native({ op: 'ownerAssertDirectory', handleId, path: currentPath }, assertDeadline, assertSignal))
      executionAssert(sameIdentity(directory(row, currentPath), originalIdentity), 'execution_owner_unknown')
    }
    const mutate = async (action: () => Promise<void>, deadline?: number, signal?: AbortSignal): Promise<void> => {
      await assertOwned(deadline, signal)
      executionAssert(createExclusive && !prepareOnly && !archived, 'execution_owner_read_only')
      try { await action() } catch (error) { uncertain = true; throw error }
    }
    const writePrepared = (kind: 'Config' | 'Auth', content: string, sha256: string,
      deadline?: number, signal?: AbortSignal): Promise<void> => serialize(async () => {
      const bytes = Buffer.from(content, 'utf8'), limit = kind === 'Config' ? 4 * 1024 * 1024 : 128 * 1024
      executionAssert(bytes.length > 0 && bytes.length <= limit && bytes.toString('utf8') === content &&
        /^[a-f0-9]{64}$/.test(sha256) && createHash('sha256').update(bytes).digest('hex') === sha256,
      'execution_owner_prepared_invalid')
      executionRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
      const scope = kind === 'Config' ? 'config' : 'data'
      executionAssert(new RegExp('\\\\opencode\\\\v2\\\\profiles\\\\[^\\\\]+\\\\' + scope + '\\\\opencode$', 'i').test(currentPath),
        'execution_owner_prepared_purpose_invalid')
      await mutate(async () => {
        const row = response(await native({ op: kind === 'Config' ? 'ownerWritePreparedConfig' : 'ownerWritePreparedAuth',
          handleId, bytesBase64: bytes.toString('base64'), sha256 }, deadline, signal))
        const expectedPath = path.win32.join(currentPath, kind === 'Config' ? 'opencode.json' : 'auth.json')
        executionAssert(Object.keys(row).sort().join(',') ===
          'bytes,directoryIdentity,fileIdentity,flushed,links,ok,path,privateAcl,reparse,schema,sha256' &&
          row.path === expectedPath && row.bytes === bytes.length && row.sha256 === sha256 && row.flushed === true &&
          row.privateAcl === true && row.reparse === false && row.links === 1, 'execution_owner_unknown')
        const dir = identity(row.directoryIdentity), file = identity(row.fileIdentity)
        executionAssert(sameIdentity(dir, originalIdentity) && file.ownerSid === dir.ownerSid &&
          file.volumeSerial === dir.volumeSerial, 'execution_owner_unknown')
        await assertOwned(deadline, signal)
      }, deadline, signal)
    })
    return Object.freeze({ identity: originalIdentity,
      assertOwned: (deadline?: number, signal?: AbortSignal) => serialize(() => assertOwned(deadline, signal)),
      writeExclusive: (recordName: string, value: unknown, deadline?: number, signal?: AbortSignal) => serialize(async () => {
        name(recordName)
        const bytes = Buffer.from(canonicalExecutionJSON(value) + '\n', 'utf8')
        executionAssert(bytes.length <= MAX_BYTES, 'execution_owner_record_invalid')
        await mutate(async () => {
          const row = response(await native({ op: 'ownerWriteExclusive', handleId, name: recordName, bytesBase64: bytes.toString('base64') }, deadline, signal))
          executionAssert(row.writtenBytes === bytes.length && row.flushed === true && row.links === 1 &&
            row.reparse === false && row.privateAcl === true, 'execution_owner_unknown')
          await assertOwned(deadline, signal)
        }, deadline, signal)
      }),
      writePreparedConfig: (content: string, sha256: string, deadline?: number, signal?: AbortSignal) => writePrepared('Config', content, sha256, deadline, signal),
      writePreparedAuth: (content: string, sha256: string, deadline?: number, signal?: AbortSignal) => writePrepared('Auth', content, sha256, deadline, signal),
      readRecord: (recordName: string, deadline?: number, signal?: AbortSignal) => serialize(async () => {
        name(recordName); await assertOwned(deadline, signal)
        const row = response(await native({ op: 'ownerReadRecord', handleId, name: recordName, maxBytes: MAX_BYTES }, deadline, signal))
        executionAssert(typeof row.bytesBase64 === 'string' && row.bytesBase64.length <= Math.ceil(MAX_BYTES / 3) * 4 &&
          row.links === 1 && row.reparse === false && row.privateAcl === true, 'execution_owner_unknown')
        const bytes = Buffer.from(row.bytesBase64, 'base64')
        executionAssert(bytes.length > 0 && bytes.length <= MAX_BYTES && bytes.toString('base64') === row.bytesBase64, 'execution_owner_unknown')
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        executionAssert(Buffer.from(canonicalExecutionJSON(value) + '\n').equals(bytes), 'execution_owner_unknown')
        await assertOwned(deadline, signal); return value
      }),
      readMetadata: (purpose: 'ProbeGuard' | 'ProbeRecord', deadline?: number, signal?: AbortSignal) => serialize(async () => {
        executionAssert(purpose === 'ProbeGuard' || purpose === 'ProbeRecord', 'execution_owner_unknown')
        await assertOwned(deadline, signal)
        const expectedPath = path.win32.join(currentPath, purpose === 'ProbeGuard' ? 'owner.lock' : 'probe.json')
        const request: WindowsOwnerNativeRequest = { op: 'ownerReadMetadata', purpose, handleId }
        const row = metadataResponse(await native(request, deadline, signal), purpose, expectedPath)
        const directoryIdentity = identity(row.directoryIdentity)
        executionAssert(sameIdentity(directoryIdentity, originalIdentity), 'execution_owner_unknown')
        const fileIdentity = row.fileIdentity === null ? null : identity(row.fileIdentity)
        if (fileIdentity) executionAssert(fileIdentity.volumeSerial === directoryIdentity.volumeSerial &&
          fileIdentity.ownerSid === directoryIdentity.ownerSid, 'execution_owner_unknown')
        await assertOwned(deadline, signal)
        return Object.freeze({
          purpose, path: expectedPath, directoryIdentity, fileIdentity,
          bytes: Number(row.bytes),
          ...(row.absent === true ? { absent: true as const } : {}),
          ...(purpose === 'ProbeRecord' && row.absent !== true ? { value: executionRecord(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadataBytes(row)))) } : {}),
        })
      }),
      // Only the two fixed probe metadata files can be written through a retained
      // directory. The native producer supplies explicit owner SID/private DACL.
      writeMetadata: (purpose: 'ProbeGuard' | 'ProbeRecord', value: unknown, deadline?: number, signal?: AbortSignal) => serialize(async () => {
        executionAssert(purpose === 'ProbeGuard' || purpose === 'ProbeRecord', 'execution_owner_unknown')
        executionAssert(purpose !== 'ProbeGuard' || value === null, 'execution_owner_unknown')
        const bytes = purpose === 'ProbeGuard' ? Buffer.alloc(0) :
          Buffer.from(canonicalExecutionJSON(executionRecord(value)) + '\n', 'utf8')
        executionAssert(bytes.length < 131072, 'execution_owner_metadata_budget')
        await assertOwned(deadline, signal)
        const expectedPath = path.win32.join(currentPath, purpose === 'ProbeGuard' ? 'owner.lock' : 'probe.json')
        try {
          const row = metadataResponse(await native({ op: 'ownerWriteMetadata', purpose, handleId,
            bytesBase64: bytes.toString('base64') }, deadline, signal), purpose, expectedPath)
          const directoryIdentity = identity(row.directoryIdentity), fileIdentity = identity(row.fileIdentity)
          executionAssert(sameIdentity(directoryIdentity, originalIdentity) &&
            fileIdentity.volumeSerial === directoryIdentity.volumeSerial &&
            fileIdentity.ownerSid === directoryIdentity.ownerSid && row.absent !== true &&
            Number(row.bytes) === bytes.length &&
            (purpose !== 'ProbeRecord' || metadataBytes(row).equals(bytes)), 'execution_owner_unknown')
          await assertOwned(deadline, signal)
        } catch (error) { uncertain = true; throw error }
      }),
      archive: (requestedDestination: string) => serialize(async () => {
        const destination = canonicalPath(requestedDestination)
        executionAssert(path.win32.dirname(destination) === path.win32.dirname(currentPath) &&
          destination.startsWith(currentPath + '.released.') && /^[a-f0-9-]{36}$/.test(destination.slice(currentPath.length + 10)), 'execution_owner_path_invalid')
        await mutate(async () => {
          const row = response(await native({ op: 'ownerArchive', handleId, source: currentPath, destination }))
          executionAssert(row.writeThrough === true && row.noReplace === true &&
            sameIdentity(directory(row, destination), originalIdentity), 'execution_owner_unknown')
          currentPath = destination; await assertOwned(); archived = true
        })
      }),
      close: () => serialize(async () => {
        if (closed) return
        const row = response(await native({ op: 'ownerCloseDirectory', handleId }))
        executionAssert(row.closed === true, 'execution_owner_unknown'); closed = true
      }),
    })
  }
  const selected = new Map<string, Readonly<{ root: WindowsOwnerFileIdentity; parent: WindowsOwnerFileIdentity }>>()
  return Object.freeze({
    async validateSelectedProfile(requestedRoot: string, requestedDatabase: string, deadline?: number, signal?: AbortSignal): Promise<void> {
      executionAssert(process.platform === 'win32', 'execution_owner_platform_pending')
      requestLive(deadline, signal)
      const root = canonicalPath(requestedRoot), databasePath = canonicalPath(requestedDatabase)
      executionAssert(databasePath.toLowerCase().startsWith(root.toLowerCase() + '\\'), 'execution_database_alias')
      const row = response(await native({ op: 'ownerValidateSelectedProfile', root, databasePath, directories: directoryPaths }, deadline, signal))
      executionAssert(row.root === root && row.databasePath === databasePath && row.privateAcl === true && row.reparse === false && row.filesystem === 'NTFS', 'execution_owner_unknown')
      const rootIdentity = identity(row.rootIdentity), parentIdentity = identity(row.parentIdentity)
      if (row.databaseIdentity !== null) identity(row.databaseIdentity)
      const key = root.toLowerCase() + '\0' + databasePath.toLowerCase(), previous = selected.get(key)
      executionAssert(!previous || (sameIdentity(previous.root, rootIdentity) && sameIdentity(previous.parent, parentIdentity)), 'execution_owner_unknown')
      selected.set(key, Object.freeze({ root: rootIdentity, parent: parentIdentity }))
    },
    prepareDirectory: (directoryPath: string, createExclusive: boolean, deadline?: number, signal?: AbortSignal) => acquire(directoryPath, createExclusive, deadline, signal, true),
    createDirectory: (directoryPath: string, deadline?: number, signal?: AbortSignal) => acquire(directoryPath, true, deadline, signal),
    openDirectory: (directoryPath: string, deadline?: number, signal?: AbortSignal) => acquire(directoryPath, false, deadline, signal),
    readSelectedAuthMetadata: async (selectionId: string, deadline?: number, signal?: AbortSignal) => {
      executionAssert(process.platform === 'win32', 'execution_owner_platform_pending')
      requestLive(deadline, signal)
      executionAssert(typeof selectionId === 'string' && /^[1-9]\d{0,19}$/.test(selectionId), 'execution_owner_unknown')
      const row = metadataResponse(await native({ op: 'ownerReadMetadata', purpose: 'SelectedAuth', selectionId },
        deadline, signal), 'SelectedAuth', null)
      const keys = [...selected.keys()]
      const key = keys.find(value => String(row.path).toLowerCase() ===
        path.win32.join(value.split('\0', 1)[0]!, 'data', 'opencode', 'auth.json').toLowerCase())
      executionAssert(key !== undefined, 'execution_owner_unknown')
      const expected = selected.get(key)!
      executionAssert(sameIdentity(identity(row.rootIdentity), expected.root), 'execution_owner_unknown')
      const fileIdentity = identity(row.fileIdentity), directoryIdentity = identity(row.directoryIdentity)
      executionAssert(fileIdentity.volumeSerial === directoryIdentity.volumeSerial &&
        fileIdentity.ownerSid === directoryIdentity.ownerSid, 'execution_owner_unknown')
      return Object.freeze({ sha256: String(row.sha256), bytes: Number(row.bytes), rootIdentity: expected.root,
        directoryIdentity, fileIdentity })
    } })
}
