import { expect, test } from 'bun:test'

import { OpenCodeHostManager } from './OpenCodeHostManager.js'

const digest = `sha256:${'a'.repeat(64)}` as const

test.skipIf(process.platform !== 'linux')(
  'retains one installed artifact digest proof per resolved launcher path',
  () => {
    const resolutions: string[] = []
    const manager = new OpenCodeHostManager({
      resolveOpenCodeArtifactDigest: binaryPath => {
        resolutions.push(binaryPath)
        return digest
      },
    })
    const resolve = (manager as unknown as {
      resolveInstalledArtifact(binaryPath: string): typeof digest | null
    }).resolveInstalledArtifact.bind(manager)

    expect(resolve('/opt/opencode-a')).toBe(digest)
    expect(resolve('/opt/opencode-a')).toBe(digest)
    expect(resolutions).toEqual(['/opt/opencode-a'])
    expect(resolve('/opt/opencode-b')).toBe(digest)
    expect(resolutions).toEqual(['/opt/opencode-a', '/opt/opencode-b'])
  },
)
