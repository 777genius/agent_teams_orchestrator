import { expect, test } from 'bun:test'
import { canonicalJson, sha256 } from './native-http-contract.js'
import { selectedOwnerImages, verifyP3B2Recipe } from './native-owner-recipe.js'
import { OPENCODE_IDENTITIES } from './native-controller-contract.js'
import type { IntegrationDescriptor } from './native-controller-contract.js'

// Data fixtures only; no signature authority or provider custody is minted.
function fixture(version = 4) {
  const pin = (relativePath: string, inode: number, mode = 0o400, root = 'p3b2') =>
    ({ root, relativePath, inode: String(inode), device: '1', size: 123, mode, nlink: 1, sha256: 'a'.repeat(64) })
  const image = pin('bin/hosted-owner', 1, 0o500)
  const entry = version === 4 ? image : pin('src/owner.ts', 2, 0o555)
  const supervisor = pin('bin/supervisor', 3, 0o500), recipe = pin('recipe.json', 4)
  const node = pin('bin/node', 5, 0o500, 'toolchain'), loader = pin('loader.mjs', 6, 0o400, 'toolchain')
  const descriptor = { p3b2: { entry, supervisor, recipe, recipeSha256: '',
    sourceBaseCommit: 'b'.repeat(40), resultCommit: 'c'.repeat(40), closure: { merkleRoot: 'd'.repeat(64) } },
    toolchain: { node, loader }, openCode: { linuxX64Binary: { sha256: 'e'.repeat(64) },
      identities: { linuxX64BinarySha256: 'e'.repeat(64) } } } as unknown as IntegrationDescriptor
  const argv = ['--hosted-actual-owner-sealed-protocol=v2', '--runtime-manifest', '/sandbox/runtime-manifest.json']
  const invocation = { format: version === 4 ? 'agent-teams.hosted-owner-compiled-invocation/v1' :
    'agent-teams.hosted-owner-source-invocation/v1', executable: image,
    module: { path: `/p3b2/${entry.relativePath}`, sha256: entry.sha256 } }
  const value: any = { schemaVersion: version, purpose: version === 4 ? 'agent-teams.p3b2.compiled-actual-owner-entry/v4' :
    version === 3 ? 'agent-teams.p3b2.selected-native-supervisor/v3' : 'agent-teams.p3b2.source-actual-owner-entry/v2',
    sourceBaseCommit: descriptor.p3b2.sourceBaseCommit, resultCommit: descriptor.p3b2.resultCommit,
    entry: { relativePath: entry.relativePath, sha256: entry.sha256 },
    supervisor: { relativePath: supervisor.relativePath, sha256: supervisor.sha256 },
    candidateOpenCodeSha256: 'e'.repeat(64), argv: version === 4 ? argv : ['run', invocation.module.path, ...argv],
    accepted: true, sourceTreeRequired: version !== 4, launchHelper: pin('bin/helper', 7, 0o500),
    [version === 4 ? 'compiledInvocation' : 'sourceInvocation']: invocation,
    ...(version >= 3 ? { supervisorInvocation: { format: 'agent-teams.hosted-selected-supervisor-invocation/v1',
      launcher: supervisor, executable: node, loader, module: pin('supervisor.cjs', 8),
      argv: ['--selected-namespace-v1', loader.relativePath, node.relativePath, 'supervisor.cjs'] } } : {}) }
  const composition = { format: 'agent-teams.hosted-selected-native-composition/v1',
    serverAuthFormat: 'agent-teams.hosted-control.opencode-server-auth/v2',
    preparationModule: pin('prepare.cjs', 9), kernelModule: pin('kernel.node', 10) }
  const verify = () => {
    const bytes = Buffer.from(canonicalJson(value)), digest = sha256(bytes)
    return verifyP3B2Recipe(bytes, { ...descriptor, p3b2: { ...descriptor.p3b2,
      recipeSha256: digest, recipe: { ...descriptor.p3b2.recipe, sha256: digest } } })
  }
  return { value, descriptor, verify, composition }
}

test('compiled v4 admits one image, direct sealed argv and selected Product composition pins', () => {
  const f = fixture(); f.value.nativeComposition = f.composition
  const s = f.verify()!
  expect(s.source).toBeUndefined()
  expect(s.compiled?.module).toEqual({ path: '/p3b2/bin/hosted-owner', sha256: s.executable.sha256 })
  expect(s.supervisor?.module.relativePath).toBe('supervisor.cjs')
  expect(s.preparationModule).toEqual(f.composition.preparationModule)
  expect(s.kernelModule).toEqual(f.composition.kernelModule)
  expect(selectedOwnerImages(s).map(p => p.relativePath)).toEqual([
    'bin/hosted-owner', 'bin/helper', 'supervisor.cjs', 'prepare.cjs', 'kernel.node'])
  expect(Object.isFrozen(s.compiled?.module)).toBe(true)
})

test('v2/v3 source invocation remains separate; existing optional Product v3 pins are preserved', () => {
  for (const version of [2, 3]) {
    const f = fixture(version)
    if (version === 3) f.value.nativeComposition = f.composition
    expect(f.verify()!.source?.module.path).toBe('/p3b2/src/owner.ts')
    expect(f.verify()!.compiled).toBeUndefined()
    if (version === 3) expect(f.verify()!.kernelModule).toEqual(f.composition.kernelModule)
    f.value.argv = f.value.argv.slice(2)
    expect(f.verify).toThrow(/argv/)
  }
})

test('v4 rejects source fallback, extra keys, wrong version/path/argv and partial image equality', () => {
  const changes: ((v: any) => void)[] = [
    v => { v.schemaVersion = 5 }, v => { v.purpose = 'agent-teams.p3b2.selected-native-supervisor/v3' },
    v => { v.sourceTreeRequired = true }, v => { v.sourceInvocation = v.compiledInvocation },
    v => { delete v.supervisorInvocation }, v => { v.argv.unshift('run') },
    v => { v.compiledInvocation.module.path = '/proc/self/fd/11' },
    v => { v.compiledInvocation.module.sha256 = 'f'.repeat(64) },
    v => { v.compiledInvocation.executable = { ...v.compiledInvocation.executable, inode: '99' } },
    v => { v.compiledInvocation.executable = { ...v.compiledInvocation.executable, mode: 0o555 } },
    v => { v.compiledInvocation.extra = true }, v => { v.closureMerkleRoot = 'd'.repeat(64) },
  ]
  for (const change of changes) { const f = fixture(); change(f.value); expect(f.verify).toThrow() }
  const f = fixture(); f.value.compiledInvocation.module.path = '/p3b2/bin/other'
  f.value.entry.relativePath = 'bin/other'; (f.descriptor.p3b2.entry as any).relativePath = 'bin/other'
  expect(f.verify).toThrow(/compiled_image/)
})

test('the intentional compiled image alias never permits helper, recipe or composition aliases', () => {
  for (const target of ['launchHelper', 'preparationModule', 'kernelModule']) {
    for (const key of ['relativePath', 'inode']) {
      const f = fixture(); f.value.nativeComposition = f.composition
      const pin = target === 'launchHelper' ? f.value.launchHelper : f.value.nativeComposition[target]
      pin[key] = f.value.compiledInvocation.executable[key]
      expect(f.verify).toThrow()
    }
  }
  for (const patch of [{ mode: 0o500 }, { relativePath: '../kernel.node' }, { size: 32 * 1024 * 1024 + 1 },
    { inode: '18446744073709551616' }, { sha256: 'A'.repeat(64) }]) {
    const f = fixture(); f.value.nativeComposition = { ...f.composition, kernelModule: { ...f.composition.kernelModule, ...patch } }
    expect(f.verify).toThrow(/selected_kernel_pin/)
  }
  const f = fixture(); f.value.nativeComposition = { ...f.composition, serverAuthFormat: 'v1' }
  expect(f.verify).toThrow(/composition_version/)
})


test('recipe digest and canonical byte bindings cannot be replaced with equivalent JSON', () => {
  const f = fixture(); const bytes = Buffer.from(canonicalJson(f.value))
  expect(() => verifyP3B2Recipe(bytes, f.descriptor)).toThrow(/version_digest/)
  expect(() => verifyP3B2Recipe(Buffer.from(JSON.stringify(f.value, null, 2)), f.descriptor)).toThrow(/noncanonical/)
})

test('legacy built recipe v1 still returns no native selection', () => {
  const f = fixture()
  const value = { schemaVersion: 1, purpose: 'agent-teams.p3b2.built-actual-owner-entry/v1',
    sourceBaseCommit: f.value.sourceBaseCommit, resultCommit: f.value.resultCommit,
    entry: f.value.entry, supervisor: f.value.supervisor,
    closureMerkleRoot: f.descriptor.p3b2.closure.merkleRoot,
    candidateOpenCodeSha256: OPENCODE_IDENTITIES.linuxX64BinarySha256,
    argv: ['--runtime-manifest', '/sandbox/runtime-manifest.json'], sourceTreeRequired: false, accepted: true }
  expect(verifyP3B2Recipe(Buffer.from(canonicalJson(value)), f.descriptor)).toBeUndefined()
})
