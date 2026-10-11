import path from 'node:path'
import { canonicalExecutionJSON, executionAssert, executionRecord } from '../../execution/OpenCodeV2ExecutionContracts.js'

const MAX_BYTES = 16 * 1024
const RECORD_NAMES = new Set(['owner.json', 'release.json', 'containment.json', 'child.json'])

export type WindowsOwnerFileIdentity = Readonly<{
  volumeSerial: string; fileId: string; ownerSid: string
}>
export type WindowsOwnerNativeRequest =
  | Readonly<{ op: 'ownerOpenDirectory'; path: string; createExclusive: boolean }>
  | Readonly<{ op: 'ownerAssertDirectory'; handleId: string; path: string }>
  | Readonly<{ op: 'ownerWriteExclusive'; handleId: string; name: string; bytesBase64: string }>
  | Readonly<{ op: 'ownerReadRecord'; handleId: string; name: string; maxBytes: number }>
  | Readonly<{ op: 'ownerArchive'; handleId: string; source: string; destination: string }>
  | Readonly<{ op: 'ownerCloseDirectory'; handleId: string }>

/** The selected persistent native helper owns the handles. This port is not a
 * qualification receipt: production must bind it to the authenticated helper. */
export type WindowsOwnerNativePort = (request: WindowsOwnerNativeRequest) => Promise<unknown>

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

export type WindowsOwnerDirectory = Readonly<{
  identity: WindowsOwnerFileIdentity
  assertOwned(): Promise<void>
  writeExclusive(name: string, value: unknown): Promise<void>
  readRecord(name: string): Promise<unknown>
  archive(destination: string): Promise<void>
  close(): Promise<void>
}>

/** CreateDirectoryW is exclusive; an existing or partial fence is never adopted
 * by createDirectory. No rollback removes it after an uncertain native failure.
 * Open is read-only authority acquisition, not ownership/adoption of a fence. */
export function createWindowsOwnerFilesystem(native: WindowsOwnerNativePort) {
  const acquire = async (requestedPath: string, createExclusive: boolean): Promise<WindowsOwnerDirectory> => {
    executionAssert(process.platform === 'win32', 'execution_owner_platform_pending')
    let currentPath = canonicalPath(requestedPath)
    const opened = response(await native({ op: 'ownerOpenDirectory', path: currentPath, createExclusive }))
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
    const assertOwned = async (): Promise<void> => {
      executionAssert(!closed && !uncertain, 'execution_owner_unknown')
      const row = response(await native({ op: 'ownerAssertDirectory', handleId, path: currentPath }))
      executionAssert(sameIdentity(directory(row, currentPath), originalIdentity), 'execution_owner_unknown')
    }
    const mutate = async (action: () => Promise<void>): Promise<void> => {
      await assertOwned()
      executionAssert(createExclusive && !archived, 'execution_owner_read_only')
      try { await action() } catch (error) { uncertain = true; throw error }
    }
    return Object.freeze({ identity: originalIdentity,
      assertOwned: () => serialize(assertOwned),
      writeExclusive: (recordName: string, value: unknown) => serialize(async () => {
        name(recordName)
        const bytes = Buffer.from(canonicalExecutionJSON(value) + '\n', 'utf8')
        executionAssert(bytes.length <= MAX_BYTES, 'execution_owner_record_invalid')
        await mutate(async () => {
          const row = response(await native({ op: 'ownerWriteExclusive', handleId, name: recordName, bytesBase64: bytes.toString('base64') }))
          executionAssert(row.writtenBytes === bytes.length && row.flushed === true && row.links === 1 &&
            row.reparse === false && row.privateAcl === true, 'execution_owner_unknown')
          await assertOwned()
        })
      }),
      readRecord: (recordName: string) => serialize(async () => {
        name(recordName); await assertOwned()
        const row = response(await native({ op: 'ownerReadRecord', handleId, name: recordName, maxBytes: MAX_BYTES }))
        executionAssert(typeof row.bytesBase64 === 'string' && row.bytesBase64.length <= Math.ceil(MAX_BYTES / 3) * 4 &&
          row.links === 1 && row.reparse === false && row.privateAcl === true, 'execution_owner_unknown')
        const bytes = Buffer.from(row.bytesBase64, 'base64')
        executionAssert(bytes.length > 0 && bytes.length <= MAX_BYTES && bytes.toString('base64') === row.bytesBase64, 'execution_owner_unknown')
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
        executionAssert(Buffer.from(canonicalExecutionJSON(value) + '\n').equals(bytes), 'execution_owner_unknown')
        await assertOwned(); return value
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
  return Object.freeze({ createDirectory: (directoryPath: string) => acquire(directoryPath, true),
    openDirectory: (directoryPath: string) => acquire(directoryPath, false) })
}
