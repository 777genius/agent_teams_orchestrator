import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rename, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { launchOpenCodeNativeAuthority, resolveOpenCodeNativeAuthorityArtifacts,
  verifyOpenCodeNativeAuthorityArtifacts, type OpenCodeNativeAuthorityChild,
} from './OpenCodeNativeAuthorityArtifacts.js'
import { OpenCodeWindowsPublicationAuthorityClient } from './OpenCodeWindowsPublicationAuthorityClient.js'

const sandboxes: string[] = []
afterAll(async () => {
  for (const sandbox of sandboxes) await rm(sandbox, { recursive: true, force: true })
})

describe('Windows production publication authority launcher round-trip', () => {
  test.skipIf(process.platform !== 'win32')(
    'resolves the real pair, correlates OPEN_ROOT/CLOSE, exits zero, and physically releases the sandbox',
    async () => {
      const sandbox = await mkdtemp(path.join(os.tmpdir(), 'opencode-authority-roundtrip-'))
      sandboxes.push(sandbox)
      const artifacts = resolveOpenCodeNativeAuthorityArtifacts()
      verifyOpenCodeNativeAuthorityArtifacts(artifacts)
      let child: OpenCodeNativeAuthorityChild | undefined
      const client = new OpenCodeWindowsPublicationAuthorityClient({
        deadline: Date.now() + 15_000,
        ...artifacts,
        launch: input => {
          expect(input).toEqual({ ...artifacts, argument: '--windows-publication-authority-v1' })
          child = launchOpenCodeNativeAuthority(input)
          return child
        },
      })
      try {
        const opened = await client.openRoot(sandbox, false, false)
        expect(opened.createdPaths).toEqual([])
        expect(opened.volumeSerial).toMatch(/^\d+$/)
        expect(opened.fileId).toMatch(/^\d+$/)
        await client.close()
        expect(child).toBeDefined()
        expect(await child!.exited).toBe(0)
        await client.physicalSettlement
        const moved = `${sandbox}-released`
        await rename(sandbox, moved); await rename(moved, sandbox)
      } finally {
        if (child) { try { child.kill('SIGKILL') } catch {}; await client.physicalSettlement }
      }
    },
    30_000,
  )
})
