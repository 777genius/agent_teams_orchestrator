import { mkdir } from 'node:fs/promises'
import path from 'node:path'

import { writeFileAtomic } from '../../utils/atomicWrite.js'
import {
  getOpenCodePassiveSnapshotPath,
  getOpenCodePassiveStatusRootDirectory,
} from './OpenCodePassiveStatusProductionReader.js'
import {
  encodeOpenCodeRedactedSnapshotV1,
  OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES,
  type OpenCodeRedactedSnapshotV1,
  type OpenCodeRedactedSnapshotWriterPort,
} from './OpenCodeRedactedStatusSnapshot.js'

type SnapshotWriterDeps = Readonly<{
  rootDirectory?: string
  makeDirectory?: (directory: string) => Promise<unknown>
  writeAtomic?: (filePath: string, data: string) => Promise<void>
}>

/** Explicit update-path writer. It is intentionally never owned or called by readStatus. */
export class OpenCodePassiveStatusSnapshotWriter implements OpenCodeRedactedSnapshotWriterPort {
  readonly #rootDirectory: string
  readonly #makeDirectory: (directory: string) => Promise<unknown>
  readonly #writeAtomic: (filePath: string, data: string) => Promise<void>

  constructor(deps: SnapshotWriterDeps = {}) {
    this.#rootDirectory = deps.rootDirectory ?? getOpenCodePassiveStatusRootDirectory()
    this.#makeDirectory = deps.makeDirectory ?? (directory => mkdir(directory, { recursive: true, mode: 0o700 }))
    this.#writeAtomic = deps.writeAtomic ?? ((filePath, data) => writeFileAtomic(filePath, data, { mode: 0o600 }))
  }

  async write(snapshot: OpenCodeRedactedSnapshotV1, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new Error('Passive snapshot update cancelled')
    const encoded = encodeOpenCodeRedactedSnapshotV1(snapshot)
    if (!encoded.ok || !encoded.bytes || encoded.bytes.byteLength > OPEN_CODE_REDACTED_SNAPSHOT_MAX_BYTES) {
      throw new TypeError('Passive snapshot is not a bounded redacted snapshot')
    }
    // Own the exact immutable bounded payload before any asynchronous filesystem boundary.
    const owned = new TextDecoder('utf-8', { fatal: true }).decode(encoded.bytes)
    const snapshotFile = getOpenCodePassiveSnapshotPath(this.#rootDirectory, encoded.value.projectScope)
    await this.#makeDirectory(path.dirname(snapshotFile))
    if (signal.aborted) throw new Error('Passive snapshot update cancelled')
    await this.#writeAtomic(snapshotFile, owned)
    if (signal.aborted) throw new Error('Passive snapshot update cancelled')
    // Binary metadata is global and contains the same already-redacted payload.
    await this.#writeAtomic(path.join(this.#rootDirectory, 'binary.snapshot.json'), owned)
  }
}
