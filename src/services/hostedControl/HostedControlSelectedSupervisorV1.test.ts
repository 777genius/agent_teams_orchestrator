import { expect, test } from 'bun:test'
import { parseSelectedSupervisorEvidenceV1 } from './HostedControlSelectedSupervisorV1.js'

function evidence() {
  const sha256 = 'a'.repeat(64)
  const image = { device: '1', inode: '2', size: '100', sha256 }
  const file = { path: '/p3b2/supervisor.cjs', root: 'p3b2', relativePath: 'supervisor.cjs',
    device: '1', inode: '3', size: 100, mode: 0o400, nlink: 1, sha256 }
  const process = { pid: 3, parentPid: 1, startTicks: '100', pidNamespaceInode: '10',
    mountNamespaceInode: '11', networkNamespaceInode: '12' }
  return { selectedSupervisor: { contract: 'agent-teams.hosted-selected-supervisor-process/v1',
    ...process, processStartToken: sha256, observedMonotonicNs: '200', executable: image,
    module: file, loader: { ...file, path: '/toolchain/loader', root: 'toolchain', relativePath: 'loader' },
    namespaceInit: { ...process, pid: 1, parentPid: 0, executable: image } },
    selectedControl: { contract: 'agent-teams.hosted-selected-control-verification/v1', authorityEpoch: 1,
      controllerNonce: sha256, freezeId: sha256, reviewId: sha256, authorizationId: sha256,
      artifacts: ['freeze.json', 'review.json', 'authorization.json', 'reviewer.spki', 'authorizer.spki'].map((name, i) => ({
        path: '/admission/' + name, descriptor: 14 + i, relativePath: name,
        device: '1', inode: String(10 + i), size: 100, sha256 })) },
    selectedRecipe: { path: '/p3b2/recipe.json', device: '1', inode: '20', size: 100, sha256 } }
}

test('retains selected supervisor wire facts without generating a custody or authority receipt', () => {
  const input = evidence(), parsed = parseSelectedSupervisorEvidenceV1(input)
  expect(parsed).toEqual(input)
  expect(Object.isFrozen(parsed.selectedSupervisor.namespaceInit)).toBe(true)
  expect(parsed.selectedControl.artifacts.map(row => row.descriptor)).toEqual([14, 15, 16, 17, 18])
})

test('rejects partial evidence, extra authority claims and out-of-range native observations', () => {
  const missing: any = evidence(); delete missing.selectedRecipe
  expect(() => parseSelectedSupervisorEvidenceV1(missing)).toThrow()
  const invented: any = evidence(); invented.selectedControl.accepted = true
  expect(() => parseSelectedSupervisorEvidenceV1(invented)).toThrow()
  const oversized = evidence(); oversized.selectedSupervisor.startTicks = '18446744073709551616'
  expect(() => parseSelectedSupervisorEvidenceV1(oversized)).toThrow()
  const invalid = evidence(); invalid.selectedSupervisor.pid = -1
  expect(() => parseSelectedSupervisorEvidenceV1(invalid)).toThrow()
})

import { assertSelectedSupervisorArgvV1 } from './HostedControlSelectedSupervisorV1.js'

test('actual supervisor cmdline must name the retained loader and module with no extra process arguments', () => {
  const selected = parseSelectedSupervisorEvidenceV1(evidence()).selectedSupervisor
  const args = ['/toolchain/node', '--import', selected.loader.path, selected.module.path, '--selected-supervisor-v1']
  const wire = (items: string[]) => Buffer.from(items.join('\0') + '\0')
  expect(() => assertSelectedSupervisorArgvV1(wire(args), selected)).not.toThrow()
  for (const other of [
    [...args, '--eval', 'other module'],
    args.map((arg, i) => i === 2 ? '/toolchain/other-loader' : arg),
    args.map((arg, i) => i === 3 ? '/p3b2/other.cjs' : arg),
    args.map((arg, i) => i === 0 ? '/toolchain/../sandbox/node' : arg),
  ]) expect(() => assertSelectedSupervisorArgvV1(wire(other), selected)).toThrow()
  expect(() => assertSelectedSupervisorArgvV1(Buffer.from(args.join('\0')), selected)).toThrow('argv_frame')
})
