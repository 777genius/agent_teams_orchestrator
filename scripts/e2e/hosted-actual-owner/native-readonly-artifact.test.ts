import { expect, test } from 'bun:test'
import { readReadonlyArtifact } from './native-readonly-artifact.js'

const pin = { relativePath: 'recipe.json', device: '1', inode: '2', size: 10, sha256: 'a'.repeat(64) }
// Invalid borrowed fd makes any premature I/O fail with EBADF. Admission must
// reject attacker-controlled paths/size/deadline before reaching that fd.
test('namespace public artifact bounds reject before touching a borrowed root', () => {
  for (const path of ['/etc/passwd', '../recipe.json', 'a/../recipe.json', 'a//recipe.json', 'a\\b', '']) {
    expect(() => readReadonlyArtifact(-1, { ...pin, relativePath: path }, 1024)).toThrow(/selected_readonly_artifact_path/)
  }
  expect(() => readReadonlyArtifact(-1, { ...pin, size: 2048 }, 1024)).toThrow('selected_readonly_artifact_pin')
  expect(() => readReadonlyArtifact(-1, pin, 1024, 0)).toThrow('hosted_owner_v2_deadline')
})
