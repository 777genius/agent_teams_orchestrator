import assert from 'node:assert/strict'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, lstat, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { openCodeBunVersion } from '../../src/constants/openCodeBunVersion.js'
import { privateOpenCodeReadEnvironment } from '../../src/services/opencode/profile/OpenCodeV2ManagedConfig.js'
import { prepareWindowsPrivateDirectories } from '../../src/services/opencode/profile/OpenCodePrivateDirectories.js'
import { createWindowsNativeBroker, resolveWindowsNativeArtifact } from '../../src/services/opencode/host/windows/OpenCodeV2WindowsNativeBroker.js'
import { createWindowsOwnerFilesystem } from '../../src/services/opencode/host/windows/OpenCodeV2WindowsOwnerFilesystem.js'
import { acquireExecutionProfileOwner } from '../../src/services/opencode/host/OpenCodeV2ExecutionOwner.js'
import { retireExecutionChild } from '../../src/services/opencode/host/OpenCodeV2ExecutionLifecycle.js'
import { executionHash } from '../../src/services/opencode/execution/OpenCodeV2ExecutionContracts.js'
import { validateExecutionProfile, type SelectedExecutionProfile } from '../../src/services/opencode/host/OpenCodeV2ExecutionBinding.js'
import { verifyOpenCodeV2ServerGraph } from '../../src/services/opencode/host/OpenCodeV2ServerGraph.js'
import { planWindowsExecution, ownerFilesystemForWindowsPlan, bindWindowsExecutionSelectedConfig,
  launchWindowsExecution, closeWindowsExecutionPlan } from '../../src/services/opencode/host/windows/OpenCodeV2WindowsExecution.js'
import { readShellProbeResult, createShellProbeConfig, shellProbePermissions } from './windows-shell-tool-contract.js'

// Actual registered ShellTool checkpoint, with no LLM or production launch
// qualification claim. Run only in the disposable native-source SDK checkout.
assert.equal(process.platform, 'win32'); assert.equal(process.arch, 'x64')
assert.equal(process.versions.bun, openCodeBunVersion())
const [root, receiptPath, sourceNode, sourceNodeSha256] = process.argv.slice(2)
assert.ok(root && receiptPath && sourceNode && sourceNodeSha256)
assert.ok([root, receiptPath, sourceNode].every(value => path.isAbsolute(value)))
assert.match(path.basename(root), /^TEST-windows-shell-[a-f0-9-]{36}$/)
assert.equal(receiptPath, root + '.json')
assert.match(sourceNodeSha256, /^[a-f0-9]{64}$/)
const sdkRoot = await realpath(path.resolve(import.meta.dir, '../..'))
assert.equal(path.basename(sdkRoot), 'TEST-native-sdk')
assert.equal(await realpath(sourceNode), sourceNode)
const originalNode = await lstat(sourceNode)
assert.ok(originalNode.isFile() && !originalNode.isSymbolicLink() && originalNode.nlink === 1)
const digest = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex')
assert.equal(await digest(sourceNode), sourceNodeSha256)
const graph = await verifyOpenCodeV2ServerGraph('2.0.32')
const childEntry = await realpath(path.join(import.meta.dir, 'windows-shell-tool-child.ts'))
const entrySha256 = await digest(childEntry), bun = { path: await realpath(process.execPath), sha256: await digest(process.execPath) }
const nonce = randomUUID(), leaseOwnerId = randomUUID(), deadline = Date.now() + 180_000
const project = path.join(root, 'TEST-project'), profileRoot = path.join(root, 'opencode', 'v2', 'profiles', 'TEST-shell')
const controllerRoot = path.join(root, 'TEST-claude')
const configDirectory = path.join(profileRoot, 'config', 'opencode'), dataDirectory = path.join(profileRoot, 'data', 'opencode')
const databasePath = path.join(dataDirectory, 'opencode.db')
const directories = [root, project, controllerRoot, profileRoot, ...['home', 'config', 'data', 'cache', 'state', 'tmp', 'appdata', 'localappdata']
  .map(name => path.join(profileRoot, name))]
const configContent = JSON.stringify(createShellProbeConfig(controllerRoot, bun.path))
const setup = createWindowsNativeBroker(await resolveWindowsNativeArtifact())
setup.events.on('error', () => {})
const setupFilesystem = createWindowsOwnerFilesystem((input, until, signal) => setup.request(input.op, input, until, signal))
let stage = 'private-directories', primary: unknown, failed = false
let plan: Awaited<ReturnType<typeof planWindowsExecution>> | undefined
let owner: Awaited<ReturnType<typeof acquireExecutionProfileOwner>> | undefined
let launch: ReturnType<typeof launchWindowsExecution> | undefined
let spawned = false, physicalRetired = false, released = false
let mapping: Awaited<ReturnType<NonNullable<typeof launch>['prepare']>> | undefined
let retirement: Promise<void> | undefined, setupClosed = false
let exited = false, exitResolve!: () => void
const exit = new Promise<void>(resolve => { exitResolve = resolve })
const cleanupFailures: string[] = []
const cleanupErrors: unknown[] = []
const cleanupFailed = (phase: string, error: unknown) => { cleanupFailures.push(phase); cleanupErrors.push(error) }
const facts: Record<string, unknown> = { schema: 1, kind: 'registered-shell-tool-no-model', qualified: false,
  modelInferenceRequested: false, productionProviderQualificationClaimed: false, pin: '2.0.32',
  effect: '4.0.1', entrySha256, moduleSha256: graph.moduleSha256, sourceNodeSha256 }
function retire(): Promise<void> {
  return retirement ??= (async () => {
    if (!launch) return
    // One close attempt and one absolute budget, including uncertain startup.
    const closeDeadline = Date.now() + 29_000
    if (!mapping) {
      await launch.retire(closeDeadline)
      throw new Error('TEST_shell_tool_mapping_unknown')
    }
    const receipt = await retireExecutionChild({ pid: mapping.bun.hostPID, birth: mapping.bun.birth,
      exited: () => exited, acknowledged: () => launch!.acknowledged(), disposeTransport: async () => {},
      sendClose: () => launch!.sendClose(), waitExit: exit, readBirth: () => launch!.readBirth(),
      kill: until => launch!.kill(until), retireOwnedDescendants: until => launch!.retire(until) }, closeDeadline,
    phase => { facts.cleanupPhase = phase })
    physicalRetired = true; await owner!.release(receipt); released = true
  })()
}
try {
  await prepareWindowsPrivateDirectories(directories, setupFilesystem, [root])
  facts.privateDirectoriesPrepared = true
  for (const [directory, write] of [[configDirectory, 'config'], [dataDirectory, 'database']] as const) {
    // Prepared writers require the same exclusive creator handle. Leave these
    // fixed leaves missing above; reopening an existing directory is read-only.
    stage = `${write}-directory-create`
    const held = await setupFilesystem.createDirectory(directory, deadline)
    let writeFailed = false
    try {
      stage = `${write}-write`
      if (write === 'config') await held.writePreparedConfig(configContent, createHash('sha256').update(configContent).digest('hex'), deadline)
      else await held.createPreparedDatabase(deadline)
    } catch (error) { writeFailed = true; throw error }
    finally {
      if (!writeFailed) stage = `${write}-directory-close`
      try { await held.close() }
      catch (error) {
        cleanupFailed(`${write}-directory-close`, error)
        if (!writeFailed) throw error
      }
    }
    facts[write === 'config' ? 'configPrepared' : 'databasePrepared'] = true
  }
  stage = 'setup-broker-close'
  await setup.close(); setupClosed = true
  const node = path.join(project, 'TEST-node.exe'), program = path.join(project, 'TEST-verify.cjs')
  const output = path.join(project, 'TEST-command-result.json'), marker = `TEST_SHELL_TOOL_${nonce}`
  stage = 'node-copy'
  await copyFile(sourceNode, node, constants.COPYFILE_EXCL)
  assert.equal(await digest(node), sourceNodeSha256)
  const nodeBefore = await lstat(node)
  const expectedOutput = JSON.stringify({ schema: 1, nonce, marker })
  const programContent = `require('node:fs').writeFileSync(${JSON.stringify(output)},${JSON.stringify(expectedOutput)},{flag:'wx'});console.log(${JSON.stringify(marker)});\n`
  stage = 'verifier-write'
  await writeFile(program, programContent, { flag: 'wx', mode: 0o600 })
  const { NODE_ENV: _nodeEnv, ...privateEnv } = privateOpenCodeReadEnvironment(profileRoot)
  const env = Object.freeze({ ...privateEnv, PWD: project, OPENCODE_CONFIG_DIR: configDirectory }) as Readonly<Record<string, string>>
  const profile: SelectedExecutionProfile = Object.freeze({ epoch: randomUUID(), root: profileRoot, directory: project,
    databasePath, env, envSha256: executionHash(env), config: { directory: configDirectory, content: configContent,
      sha256: createHash('sha256').update(configContent).digest('hex') },
    selection: { agent: 'TEST-shell-agent', model: { providerID: 'TEST-provider', id: 'TEST-model' }, permissions: shellProbePermissions } })
  stage = 'profile-validate'
  await validateExecutionProfile(profile)
  stage = 'plan'
  const profileDirectories = [...new Set([profileRoot, configDirectory, dataDirectory,
    ...['home', 'config', 'data', 'cache', 'state', 'tmp', 'appdata', 'localappdata'].map(name => path.join(profileRoot, name))])]
  plan = await planWindowsExecution({ bun, entry: childEntry, cwd: project, writableRoots: [project, profileRoot],
    readOnlyRoots: [sdkRoot, path.dirname(bun.path)], profileDirectories, env,
    protectedRoots: [path.join(profileRoot, '.opencode-v2-execution-owner'),
      path.join(dataDirectory, '.opencode.db.opencode-v2-execution-owner')] })
  const filesystem = ownerFilesystemForWindowsPlan(plan)
  await filesystem.validateSelectedProfile(profileRoot, databasePath, deadline, undefined, project)
  owner = await acquireExecutionProfileOwner(profile, { hostInstanceId: nonce, leaseOwnerId, graphSha256: graph.moduleSha256 }, { windowsPlan: plan })
  stage = 'config-select'
  await bindWindowsExecutionSelectedConfig(plan, profile, 'TEST-shell-tool', deadline)
  stage = 'launch'
  await owner.beforeSpawn(); spawned = true
  launch = launchWindowsExecution(plan, nonce, leaseOwnerId, bun, deadline)
  launch.child.once('close', () => { exited = true; exitResolve() })
  launch.child.on('error', () => {})
  const preparedMapping = await launch.prepare(deadline); mapping = preparedMapping
  await owner.bindChild(preparedMapping.bun.hostPID, preparedMapping.bun.birth, preparedMapping)
  let resultResolve!: (value: unknown) => void
  const result = new Promise<unknown>(resolve => { resultResolve = resolve })
  launch.child.on('message', (value: Record<string, unknown>) => {
    if (value.type === 'TEST-shell-tool-result' && value.nonce === nonce && value.leaseOwnerId === leaseOwnerId &&
      value.namespace === preparedMapping.namespace.name && value.pid === preparedMapping.bun.nativePID && executionHash(value.birth) === executionHash(preparedMapping.bun.birth))
      resultResolve(value.result)
  })
  stage = 'registered-tool'
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await launch.start({ pin: '2.0.32', profile, deadline, entrySha256, moduleSha256: graph.moduleSha256,
      node, nodeSha256: sourceNodeSha256, program, programSha256: await digest(program), marker,
      password: randomBytes(32).toString('base64url') }, deadline)
    const observed = await Promise.race([result, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('TEST_shell_tool_timeout')), Math.max(1, deadline - Date.now()))
    })])
    const parsed = readShellProbeResult(observed)
    assert.ok(parsed); facts.tool = parsed
    assert.equal(parsed.succeeded, true, 'TEST_registered_shell_tool_failed')
    assert.equal(await readFile(output, 'utf8'), expectedOutput)
    assert.equal(await digest(program), createHash('sha256').update(programContent).digest('hex'))
    assert.equal(await realpath(node), node)
    const nodeAfter = await lstat(node)
    assert.ok(nodeAfter.isFile() && !nodeAfter.isSymbolicLink() && nodeAfter.nlink === 1)
    assert.equal(nodeAfter.dev, nodeBefore.dev); assert.equal(nodeAfter.ino, nodeBefore.ino)
    assert.equal(nodeAfter.birthtimeMs, nodeBefore.birthtimeMs)
    assert.equal(await digest(node), sourceNodeSha256)
    facts.copiedNodeUnchanged = true; facts.exactVerifierEffect = true
  } finally {
    clearTimeout(timer)
  }
} catch (error) { failed = true; primary = error }
finally {
  facts.stage = stage
  if (launch) facts.commandsBeforeClose = launch.commands()
  // An unknown launch never receives a synthetic release or a second launch.
  if (spawned && launch) {
    try { await retire() } catch (error) { cleanupFailed('physical-retirement', error) }
  }
  if (owner && !spawned) {
    try { await owner.abandonBeforeSpawn(); released = true } catch (error) { cleanupFailed('owner-abandon', error) }
  }
  if (!setupClosed) { try { await setup.close() } catch (error) { cleanupFailed('setup-broker', error) } }
  if (plan) { try { await closeWindowsExecutionPlan(plan) } catch (error) { cleanupFailed('plan-broker', error) } }
  if (launch) facts.commandsAfterClose = launch.commands()
  facts.physicalRetired = physicalRetired; facts.ownerReleased = released; facts.cleanupFailures = cleanupFailures
  facts.qualified = !failed && cleanupFailures.length === 0 && physicalRetired && released
  try { await writeFile(receiptPath, JSON.stringify(facts, null, 2) + '\n', { flag: 'wx', mode: 0o600 }) }
  catch (error) { cleanupFailed('receipt-write', error); facts.qualified = false }
  try { console.log(JSON.stringify({ event: 'TEST-registered-shell-tool', ...facts })) }
  catch (error) { cleanupFailed('receipt-output', error) }
  if (cleanupFailures.length) throw new AggregateError([...(failed ? [primary] : []), ...cleanupErrors], 'TEST_shell_tool_cleanup_unknown', { cause: failed ? primary : cleanupErrors[0] })
}
if (failed) throw primary
