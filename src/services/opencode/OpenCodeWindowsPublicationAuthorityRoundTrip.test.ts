import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtemp, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { launchOpenCodeNativeAuthority, resolveOpenCodeNativeAuthorityArtifacts,
  verifyOpenCodeNativeAuthorityArtifacts, type OpenCodeNativeAuthorityChild,
} from './OpenCodeNativeAuthorityArtifacts.js'
import { OpenCodeWindowsPublicationAuthorityClient,
  type OpenCodeWindowsPublicationAuthorityOptions } from './OpenCodeWindowsPublicationAuthorityClient.js'

const sandboxes: string[] = []
function nativeFixtureBase(): string {
  const localAppData = process.env.LOCALAPPDATA
  if (!localAppData || !path.win32.isAbsolute(localAppData)) {
    throw new Error('Windows native fixture LocalAppData is unavailable [redacted]')
  }
  return path.join(localAppData, 'Temp')
}
afterAll(async () => {
  for (const sandbox of sandboxes) await rm(sandbox, { recursive: true, force: true })
})

describe('Windows production publication authority launcher round-trip', () => {
  test.skipIf(process.platform !== 'win32')(
    'resolves the real pair, correlates OPEN_ROOT/CLOSE, exits zero, and physically releases the sandbox',
    async () => {
      const sandbox = await mkdtemp(path.join(nativeFixtureBase(), 'opencode-authority-roundtrip-'))
      sandboxes.push(sandbox)
      const artifacts = resolveOpenCodeNativeAuthorityArtifacts()
      verifyOpenCodeNativeAuthorityArtifacts(artifacts)
      let child: OpenCodeNativeAuthorityChild | undefined
      const deadline = Date.now() + 15_000
      const launch: NonNullable<OpenCodeWindowsPublicationAuthorityOptions['launch']> = input => {
        expect(input).toEqual({ ...artifacts, argument: '--windows-publication-authority-v1' })
        child = launchOpenCodeNativeAuthority(input)
        return child
      }
      const client = new OpenCodeWindowsPublicationAuthorityClient({
        deadline,
        ...artifacts,
        launch,
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
