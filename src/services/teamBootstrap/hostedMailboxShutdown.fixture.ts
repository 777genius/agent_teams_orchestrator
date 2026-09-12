import {
  chmodSync, chownSync, closeSync, constants, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readlinkSync, rmSync, writeFileSync,
} from 'node:fs'
import { chmod, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const APP_UID = 65534
const APP_GID = 65534
const TEAM = 'atlas'

async function command(argv: string[]): Promise<void> {
  const child = Bun.spawn({ cmd: argv, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ])
  if (exitCode !== 0) throw new Error(`${argv[0]} exited ${exitCode}: ${stderr || stdout}`)
}

function mountId(path: string, directory = false): number {
  const fd = openSync(path, constants.O_RDONLY | 0o2000000 | (directory ? constants.O_DIRECTORY : 0))
  try {
    const value = /^mnt_id:\s+(\d+)$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, 'utf8'))
    if (!value) throw new Error('missing mount id')
    return Number(value[1])
  } finally { closeSync(fd) }
}

function errno(error: unknown): string {
  return String((error as NodeJS.ErrnoException)?.code ?? 'UNKNOWN')
}

async function worker(specPath: string): Promise<void> {
  const spec = JSON.parse(await Bun.file(specPath).text())
  process.env.CLAUDE_CONFIG_DIR = spec.config
  const authorityModule = await import(spec.authorityUrl)
  const { createHostedMailboxShutdownHandler } = await import(spec.handlerUrl)
  const cleanup = await import(spec.cleanupUrl)
  const tasksModule = await import(spec.tasksUrl)
  const capabilities = /^CapEff:\s+([0-9a-f]+)$/mi.exec(readFileSync('/proc/self/status', 'utf8'))?.[1]
  if (!capabilities) throw new Error('worker capability state is unavailable')
  let chmodErrno = 'NONE'
  try { await chmod(spec.config, 0o700) } catch (error) { chmodErrno = errno(error) }
  let renameErrno = 'NONE'
  try { await rename(spec.teams, `${spec.teams}-moved`) } catch (error) { renameErrno = errno(error) }
  await writeFile(join(spec.tasks, 'nested-write-probe'), 'ok')
  const remount = Bun.spawn({
    cmd: ['/usr/bin/mount', '-o', 'remount,rw,bind', spec.config], stdout: 'pipe', stderr: 'pipe',
  })
  const [, , remountExit] = await Promise.all([
    new Response(remount.stdout).text(), new Response(remount.stderr).text(), remount.exited,
  ])
  const fds = {
    rootFd: openSync(spec.team, constants.O_RDONLY | 0o2000000 | constants.O_DIRECTORY),
    rootParentFd: openSync(spec.teams, constants.O_RDONLY | 0o2000000 | constants.O_DIRECTORY),
    anchorFd: openSync(spec.anchor, constants.O_RDONLY | 0o2000000),
    anchorParentFd: openSync(spec.anchorParent, constants.O_RDONLY | 0o2000000 | constants.O_DIRECTORY),
    bindingRecordFd: openSync(spec.record, constants.O_RDONLY | 0o2000000),
  }
  const memberId = `member_${'a'.repeat(32)}`
  const secondMemberId = `member_${'b'.repeat(32)}`
  const taskDirectory = join(spec.tasks, TEAM)
  const taskPath = join(taskDirectory, 'a.json')
  const secondTaskPath = join(taskDirectory, 'b.json')
  const task = (id: string, owner: string) => ({
    id, subject: id, description: '', owner, status: 'pending', blocks: [], blockedBy: [],
  })
  const member = {
    agentId: 'worker@atlas', name: 'worker', joinedAt: 1000, tmuxPaneId: 'process:999999', cwd: '/tmp',
    subscriptions: [], backendType: 'process', processStartedAtMs: 1,
    processOsIdentity: 'unix-pgid:999999', processOwnerToken: 'owner', processRunId: 'run',
    spawnClaimToken: 'claim', spawnClaimRunId: 'claim-run', outstandingShutdownRequestId: 'request-1',
  }
  const secondMember = { ...member, agentId: 'second@atlas', name: 'second', joinedAt: 2000,
    processOwnerToken: 'owner-2', processRunId: 'run-2', spawnClaimToken: 'claim-2',
    spawnClaimRunId: 'claim-run-2', outstandingShutdownRequestId: 'request-2' }
  const config = (members: unknown[]) => ({ name: TEAM, createdAt: 1, leadAgentId: 'lead@atlas', members })
  const messageFor = (candidate: typeof member, requestId = candidate.outstandingShutdownRequestId) => ({
    from: candidate.name, text: JSON.stringify({
      type: 'shutdown_approved', requestId, from: candidate.name, backendType: 'process',
      paneId: candidate.tmuxPaneId, processStartedAtMs: candidate.processStartedAtMs,
      processOsIdentity: candidate.processOsIdentity, processOwnerToken: candidate.processOwnerToken,
      processRunId: candidate.processRunId, timestamp: new Date().toISOString(),
    }), timestamp: new Date().toISOString(), read: false,
  })
  const appTeammate = (candidate: typeof member) => ({ name: candidate.name, tmuxSessionName: 'x',
    tmuxPaneId: candidate.tmuxPaneId, cwd: '/tmp', spawnedAt: candidate.joinedAt + 200,
    rosterJoinedAt: candidate.joinedAt,
    processStartedAtMs: candidate.processStartedAtMs, processOsIdentity: candidate.processOsIdentity,
    processOwnerToken: candidate.processOwnerToken, processRunId: candidate.processRunId,
    spawnClaimToken: candidate.spawnClaimToken, spawnClaimRunId: candidate.spawnClaimRunId })
  let appState: any
  const resetAppState = (...members: Array<typeof member>) => {
    appState = { teamContext: { teamName: TEAM, teamFilePath: join(spec.team, 'config.json'),
      leadAgentId: 'lead@atlas', teammates: Object.fromEntries(members.map(candidate =>
        [candidate.agentId, appTeammate(candidate)])) } }
  }
  resetAppState(member, secondMember)
  const handler = createHostedMailboxShutdownHandler({
    teamName: TEAM, getAppState: () => appState,
    setAppState: (update: (state: typeof appState) => typeof appState) => { appState = update(appState) },
  })
  const identity = (candidate: typeof member) => ({
    agentId: candidate.agentId, joinedAt: candidate.joinedAt, paneId: candidate.tmuxPaneId,
    processStartedAtMs: candidate.processStartedAtMs,
    processOsIdentity: candidate.processOsIdentity, processOwnerToken: candidate.processOwnerToken,
    processRunId: candidate.processRunId, spawnClaimToken: candidate.spawnClaimToken,
    spawnClaimRunId: candidate.spawnClaimRunId,
  })
  const writeState = async (candidate: typeof member, requestId: string, taskIdentity: unknown,
    phase: 'prepared' | 'roster_removed' | 'tasks_cleaned' | 'complete' = 'prepared') => {
    await cleanup.writeHostedMailboxShutdownCleanupState({ canonicalTeamRoot: spec.team, teamName: TEAM, state: {
      version: 1, requestId, teammateName: candidate.name, identity: identity(candidate), taskIdentity,
      phase, updatedAt: new Date().toISOString(),
    } })
  }
  let authority
  try {
    authority = await authorityModule.admitCanonicalTeamLockAuthority({
      binding: { protocolVersion: 1, registrationId: spec.binding.registrationId,
        publicTeamId: spec.binding.publicTeamId, legacyKey: TEAM,
        storageGeneration: spec.binding.storageGeneration,
        admittedWriterImage: spec.binding.admittedWriterImage, canonicalTeamRoot: spec.team },
      ...fds, rootName: TEAM, anchorName: 'lock', bindingRecordName: 'binding.json',
    })
    await writeFile(join(spec.team, 'config.json'), JSON.stringify(config([member, secondMember])))
    await writeFile(join(spec.team, 'team.identity.json'), JSON.stringify({ teamId: `team_${'1'.repeat(32)}` }))
    await writeFile(join(spec.team, 'members.meta.json'), JSON.stringify({ version: 1, members: [
      { name: member.name, memberId }, { name: secondMember.name, memberId: secondMemberId },
    ] }))
    await writeFile(taskPath, JSON.stringify(task('a', memberId)))
    await writeFile(secondTaskPath, JSON.stringify(task('b', secondMemberId)))
    const producerSemantics = {
      configJoinedAt: member.joinedAt,
      appSpawnedAt: appState.teamContext.teammates[member.agentId].spawnedAt,
      appRosterJoinedAt: appState.teamContext.teammates[member.agentId].rosterJoinedAt,
      runtimeIdentityMatches: appState.teamContext.teammates[member.agentId].processOwnerToken === member.processOwnerToken &&
        appState.teamContext.teammates[member.agentId].processRunId === member.processRunId &&
        appState.teamContext.teammates[member.agentId].spawnClaimToken === member.spawnClaimToken &&
        appState.teamContext.teammates[member.agentId].spawnClaimRunId === member.spawnClaimRunId,
      normalCleanupRemoved: false,
    }

    // Every supplied target incarnation field must agree with trusted config.
    const captureFences: Record<string, boolean | string> = {}
    const conflictingTargets = [
      ['wrongJoinedAtNameOnly', { name: member.name, memberId, joinedAt: member.joinedAt + 1 }],
      ['wrongJoinedAtExplicit', { name: member.name, agentId: member.agentId, memberId, joinedAt: member.joinedAt + 1 }],
      ['wrongAgentId', { name: member.name, agentId: 'replacement@atlas', memberId, joinedAt: member.joinedAt }],
    ] as const
    for (const [caseName, target] of conflictingTargets) {
      await writeFile(join(spec.team, 'members.meta.json'), JSON.stringify({ version: 1, members: [target] }))
      try {
        await tasksModule.captureTrustedTeammateTaskIdentity(TEAM, member.agentId, member.name)
        captureFences[caseName] = false
      } catch (error) {
        captureFences[caseName] = (error as Error).message ===
          'Hosted shutdown roster target conflicts with config incarnation'
      }
    }
    await writeFile(join(spec.team, 'members.meta.json'), JSON.stringify({ version: 1, members: [
      { name: member.name, agentId: member.agentId, memberId, joinedAt: member.joinedAt },
      { name: secondMember.name, memberId: secondMemberId },
    ] }))
    const repairedCapture = await tasksModule.captureTrustedTeammateTaskIdentity(TEAM, member.agentId, member.name)
    captureFences.repairedOwner = repairedCapture.hostedOwnerId

    // Restore the original unrelated name-only metadata rows before proving
    // sequential A/B capture; the explicit row above belongs only to the repair.
    await writeFile(join(spec.team, 'members.meta.json'), JSON.stringify({ version: 1, members: [
      { name: member.name, memberId }, { name: secondMember.name, memberId: secondMemberId },
    ] }))
    const firstTaskIdentity = await tasksModule.captureTrustedTeammateTaskIdentity(TEAM, member.agentId, member.name)
    await writeState(member, 'request-1', firstTaskIdentity)
    const firstHandled = await handler(messageFor(member))
    producerSemantics.normalCleanupRemoved = !appState.teamContext.teammates[member.agentId]
    // Capture B only after A has been removed while A's name-only metadata row remains.
    const secondTaskIdentity = await tasksModule.captureTrustedTeammateTaskIdentity(TEAM, secondMember.agentId, secondMember.name)
    await writeState(secondMember, 'request-2', secondTaskIdentity)
    const secondHandled = await handler(messageFor(secondMember))
    const secondCompleted = await cleanup.readHostedMailboxShutdownCleanupState({ canonicalTeamRoot: spec.team,
      teamName: TEAM, requestId: 'request-2', teammateName: secondMember.name })
    const sequential = { firstHandled, secondHandled,
      firstOwner: JSON.parse(await readFile(taskPath, 'utf8')).owner ?? null,
      secondOwner: JSON.parse(await readFile(secondTaskPath, 'utf8')).owner ?? null,
      membersRemaining: JSON.parse(await readFile(join(spec.team, 'config.json'), 'utf8')).members.length,
      appsRemaining: Object.keys(appState.teamContext.teammates).length, phase: secondCompleted.phase,
      joinedAt: secondCompleted.identity.joinedAt,
      firstHostedOwnerId: firstTaskIdentity.hostedOwnerId, secondHostedOwnerId: secondTaskIdentity.hostedOwnerId }

    // A malformed task stops at roster_removed; repairing the same file makes retry settle.
    resetAppState(member)
    await writeFile(join(spec.team, 'config.json'), JSON.stringify(config([member])))
    await writeFile(join(spec.team, 'members.meta.json'), JSON.stringify({ version: 1, members: [{ name: member.name, memberId }] }))
    await writeFile(taskPath, '{bad')
    await writeState(member, 'request-malformed', firstTaskIdentity)
    const malformedMessage = messageFor(member, 'request-malformed')
    let partialRejected = false
    try { await handler(malformedMessage) } catch { partialRejected = true }
    const partial = await cleanup.readHostedMailboxShutdownCleanupState({ canonicalTeamRoot: spec.team,
      teamName: TEAM, requestId: 'request-malformed', teammateName: member.name })
    await writeFile(taskPath, JSON.stringify(task('a', memberId)))
    await handler(malformedMessage)
    const retried = await cleanup.readHostedMailboxShutdownCleanupState({ canonicalTeamRoot: spec.team,
      teamName: TEAM, requestId: 'request-malformed', teammateName: member.name })

    await writeFile(join(spec.team, 'config.json'), '{bad')
    let parseRejected = false
    try {
      await createHostedMailboxShutdownHandler({ teamName: TEAM, getAppState: () => appState, setAppState: () => {} })({
        ...messageFor(member, 'request-parse') })
    } catch { parseRejected = true }

    // Filename identity is strict: b's replacement owner survives both failure and repaired retry.
    const replacementOwner = `member_${'c'.repeat(32)}`
    await writeFile(join(spec.team, 'config.json'), JSON.stringify(config([])))
    await writeFile(taskPath, JSON.stringify({ ...task('b', memberId), subject: 'mismatched-a' }))
    await writeFile(secondTaskPath, JSON.stringify(task('b', replacementOwner)))
    await writeState(member, 'request-mismatch', firstTaskIdentity, 'roster_removed')
    const mismatchMessage = messageFor(member, 'request-mismatch')
    let mismatchRejected = false
    try { await handler(mismatchMessage) } catch { mismatchRejected = true }
    const mismatchOwnerAfterReject = JSON.parse(await readFile(secondTaskPath, 'utf8')).owner
    await writeFile(taskPath, JSON.stringify(task('a', memberId)))
    await handler(mismatchMessage)
    const mismatchState = await cleanup.readHostedMailboxShutdownCleanupState({ canonicalTeamRoot: spec.team,
      teamName: TEAM, requestId: 'request-mismatch', teammateName: member.name })
    const mismatch = { rejected: mismatchRejected,
      repairedOwner: JSON.parse(await readFile(taskPath, 'utf8')).owner ?? null,
      replacementOwnerAfterReject: mismatchOwnerAfterReject,
      replacementOwnerAfterRetry: JSON.parse(await readFile(secondTaskPath, 'utf8')).owner,
      retryPhase: mismatchState.phase }

    // Both resumable phases reject a same-key replacement incarnation before touching its task.
    const replacement = { ...member, processRunId: 'replacement' }
    const replacementResults: Record<string, boolean> = {}
    for (const phase of ['prepared', 'roster_removed'] as const) {
      const requestId = `request-replacement-${phase}`
      await writeFile(join(spec.team, 'config.json'), JSON.stringify(config([replacement])))
      await writeFile(taskPath, JSON.stringify(task('a', replacementOwner)))
      await writeState(member, requestId, firstTaskIdentity, phase)
      try { await handler(messageFor(member, requestId)); replacementResults[phase] = false }
      catch { replacementResults[phase] = true }
      replacementResults[`${phase}OwnerPreserved`] = JSON.parse(await readFile(taskPath, 'utf8')).owner === replacementOwner
    }

    // A replacement differing only by joinedAt survives prepared resume; restoring
    // the captured incarnation permits an ordinary retry to finish.
    const joinedAtReplacement = { ...member, joinedAt: member.joinedAt + 1 }
    const joinedAtRequest = 'request-replacement-joined-at'
    resetAppState(joinedAtReplacement)
    await writeFile(join(spec.team, 'config.json'), JSON.stringify(config([joinedAtReplacement])))
    await writeFile(taskPath, JSON.stringify(task('a', replacementOwner)))
    await writeState(member, joinedAtRequest, firstTaskIdentity)
    let joinedAtRejected = false
    try { await handler(messageFor(member, joinedAtRequest)) }
    catch (error) { joinedAtRejected = (error as Error).message === 'Hosted shutdown roster identity was replaced' }
    const joinedAtPhaseAfterReject = (await cleanup.readHostedMailboxShutdownCleanupState({
      canonicalTeamRoot: spec.team, teamName: TEAM, requestId: joinedAtRequest, teammateName: member.name,
    })).phase
    const joinedAtAfterReject = {
      rosterJoinedAt: JSON.parse(await readFile(join(spec.team, 'config.json'), 'utf8')).members[0]?.joinedAt,
      taskOwner: JSON.parse(await readFile(taskPath, 'utf8')).owner,
      appSpawnedAt: appState.teamContext.teammates[member.agentId]?.spawnedAt,
      appRosterJoinedAt: appState.teamContext.teammates[member.agentId]?.rosterJoinedAt,
    }
    resetAppState(member)
    await writeFile(join(spec.team, 'config.json'), JSON.stringify(config([member])))
    await writeFile(taskPath, JSON.stringify(task('a', memberId)))
    await handler(messageFor(member, joinedAtRequest))
    const joinedAtRetry = await cleanup.readHostedMailboxShutdownCleanupState({ canonicalTeamRoot: spec.team,
      teamName: TEAM, requestId: joinedAtRequest, teammateName: member.name })
    const joinedAtFence = { rejected: joinedAtRejected, phaseAfterReject: joinedAtPhaseAfterReject, ...joinedAtAfterReject,
      retryPhase: joinedAtRetry.phase, retryOwner: JSON.parse(await readFile(taskPath, 'utf8')).owner ?? null,
      retryAppRemoved: !appState.teamContext.teammates[member.agentId] }

    resetAppState(joinedAtReplacement)
    await writeFile(join(spec.team, 'config.json'), JSON.stringify(config([])))
    await writeState(member, 'request-app-joined-at', firstTaskIdentity, 'tasks_cleaned')
    await handler(messageFor(member, 'request-app-joined-at'))
    const appStateFence = {
      replacementPreserved: appState.teamContext.teammates[member.agentId]?.rosterJoinedAt === joinedAtReplacement.joinedAt,
      phase: (await cleanup.readHostedMailboxShutdownCleanupState({ canonicalTeamRoot: spec.team,
        teamName: TEAM, requestId: 'request-app-joined-at', teammateName: member.name })).phase,
    }

    // Historical AppState has no proof of which roster incarnation it mirrors.
    // It must remain at tasks_cleaned until actual roster-backed state is restored.
    const historicalRequest = 'request-historical-app-state'
    resetAppState(member)
    delete appState.teamContext.teammates[member.agentId].rosterJoinedAt
    await writeFile(join(spec.team, 'config.json'), JSON.stringify(config([])))
    await writeState(member, historicalRequest, firstTaskIdentity, 'tasks_cleaned')
    let historicalRejected = false
    try { await handler(messageFor(member, historicalRequest)) }
    catch (error) { historicalRejected = (error as Error).message === 'Hosted shutdown AppState roster incarnation is unavailable' }
    const historicalPhase = (await cleanup.readHostedMailboxShutdownCleanupState({ canonicalTeamRoot: spec.team,
      teamName: TEAM, requestId: historicalRequest, teammateName: member.name })).phase
    const historicalPreserved = Boolean(appState.teamContext.teammates[member.agentId])
    resetAppState(member)
    await handler(messageFor(member, historicalRequest))
    const historicalRetry = await cleanup.readHostedMailboxShutdownCleanupState({ canonicalTeamRoot: spec.team,
      teamName: TEAM, requestId: historicalRequest, teammateName: member.name })
    const historicalAppState = { rejected: historicalRejected, phase: historicalPhase,
      preserved: historicalPreserved, retryPhase: historicalRetry.phase,
      retryRemoved: !appState.teamContext.teammates[member.agentId] }

    // Pre-incarnation cleanup records are unreadable and cannot borrow identity
    // from the current roster to remove user-owned state.
    const legacyRequest = 'request-legacy-cleanup'
    resetAppState(joinedAtReplacement)
    await writeFile(join(spec.team, 'config.json'), JSON.stringify(config([joinedAtReplacement])))
    await writeFile(taskPath, JSON.stringify(task('a', replacementOwner)))
    const { joinedAt: _joinedAt, ...legacyIdentity } = identity(member)
    await cleanup.writeHostedMailboxShutdownCleanupState({ canonicalTeamRoot: spec.team, teamName: TEAM, state: {
      version: 1, requestId: legacyRequest, teammateName: member.name, identity: legacyIdentity,
      taskIdentity: firstTaskIdentity, phase: 'prepared', updatedAt: new Date().toISOString(),
    } })
    let legacyRejected = false
    try { await handler(messageFor(member, legacyRequest)) }
    catch (error) { legacyRejected = (error as Error).message === 'Hosted shutdown cleanup state is invalid' }
    const legacyCleanup = {
      rejected: legacyRejected,
      rosterJoinedAt: JSON.parse(await readFile(join(spec.team, 'config.json'), 'utf8')).members[0]?.joinedAt,
      taskOwner: JSON.parse(await readFile(taskPath, 'utf8')).owner,
      appSpawnedAt: appState.teamContext.teammates[member.agentId]?.spawnedAt,
      appRosterJoinedAt: appState.teamContext.teammates[member.agentId]?.rosterJoinedAt,
    }

    // Every cleanup phase publication has a bounded ordinary persistence retry.
    const publicationRetries: Record<string, boolean> = {}
    for (const phase of ['prepared', 'roster_removed', 'tasks_cleaned', 'complete'] as const) {
      const requestId = `request-publish-${phase}`
      await chmod(spec.team, 0o500)
      let rejected = false
      try { await writeState(member, requestId, firstTaskIdentity, phase) } catch { rejected = true }
      await chmod(spec.team, 0o700)
      await writeState(member, requestId, firstTaskIdentity, phase)
      const published = await cleanup.readHostedMailboxShutdownCleanupState({ canonicalTeamRoot: spec.team,
        teamName: TEAM, requestId, teammateName: member.name })
      publicationRetries[phase] = rejected && published?.phase === phase
    }

    // Resume the handler across publication failures after each side-effect boundary.
    const handlerPhaseRetries: Record<string, boolean> = {}
    for (const phase of ['prepared', 'roster_removed', 'tasks_cleaned'] as const) {
      const requestId = `request-handler-${phase}`
      resetAppState(member)
      await writeFile(join(spec.team, 'config.json'), JSON.stringify(config([])))
      await writeFile(taskPath, JSON.stringify(task('a', phase === 'tasks_cleaned' ? replacementOwner : memberId)))
      await writeFile(secondTaskPath, JSON.stringify(task('b', replacementOwner)))
      await writeState(member, requestId, firstTaskIdentity, phase)
      await chmod(spec.team, 0o500)
      let rejected = false
      try { await handler(messageFor(member, requestId)) } catch { rejected = true }
      await chmod(spec.team, 0o700)
      const afterFailure = await cleanup.readHostedMailboxShutdownCleanupState({ canonicalTeamRoot: spec.team,
        teamName: TEAM, requestId, teammateName: member.name })
      await handler(messageFor(member, requestId))
      const afterRetry = await cleanup.readHostedMailboxShutdownCleanupState({ canonicalTeamRoot: spec.team,
        teamName: TEAM, requestId, teammateName: member.name })
      const owner = JSON.parse(await readFile(taskPath, 'utf8')).owner ?? null
      const replacementStillOwned = JSON.parse(await readFile(secondTaskPath, 'utf8')).owner === replacementOwner
      handlerPhaseRetries[phase] = rejected && afterFailure?.phase === phase && afterRetry?.phase === 'complete' &&
        owner === (phase === 'tasks_cleaned' ? replacementOwner : null) && replacementStillOwned &&
        !appState.teamContext.teammates[member.agentId]
    }

    // Real unseeded capture/termination follows unix-pgid conservative recovery.
    const recoveryMember = { ...member, outstandingShutdownRequestId: 'request-recovery', processOsIdentity: 'unix-pgid:999999' }
    resetAppState(recoveryMember)
    await writeFile(join(spec.team, 'config.json'), JSON.stringify(config([recoveryMember])))
    await writeFile(join(spec.team, 'members.meta.json'), JSON.stringify({ version: 1, members: [{ name: member.name, memberId }] }))
    const recoveryMessage = messageFor(recoveryMember)
    await chmod(spec.team, 0o500)
    let recoveryRejected = false
    try { await handler(recoveryMessage) } catch { recoveryRejected = true }
    await chmod(spec.team, 0o700)
    const recoveryHandled = await handler(recoveryMessage)
    const recoveryConfig = JSON.parse(await readFile(join(spec.team, 'config.json'), 'utf8'))
    const recovery = recoveryConfig.members[0]?.terminationRecovery
    const recoveryState = await cleanup.readHostedMailboxShutdownCleanupState({ canonicalTeamRoot: spec.team,
      teamName: TEAM, requestId: 'request-recovery', teammateName: member.name })
    console.log(JSON.stringify({
      namespace: { isolated: spec.isolated, configReadOnly: spec.configReadOnly,
        nestedTasksWritable: true, configOwner: lstatSync(spec.config).uid,
        workerUid: process.geteuid?.(), workerGid: process.getegid?.(), capabilities,
        chmodErrno, renameErrno, remountDenied: remountExit !== 0,
        privatePropagation: spec.privatePropagation,
        distinctNestedMounts: new Set([
          mountId(spec.config, true), mountId(spec.tasks, true), mountId(spec.team, true),
        ]).size === 3,
        canonicalTeamOwner: lstatSync(spec.team).uid, teamParentOwner: lstatSync(spec.teams).uid,
        registryOwner: lstatSync(spec.registry).uid, bindingOwner: lstatSync(spec.record).uid },
      taskPathMatchesProduction: tasksModule.getTaskPath(TEAM, 'a') === taskPath,
      producerSemantics,
      captureFences, sequential, partialRejected, partialPhase: partial.phase, retryPhase: retried.phase,
      parseRejected, mismatch, replacementResults, joinedAtFence, appStateFence, historicalAppState, legacyCleanup,
      publicationRetries, handlerPhaseRetries,
      recovery: { publicationRejected: recoveryRejected, retryHandled: recoveryHandled,
        persistedRequestId: recovery?.requestId, persistedAgentId: recovery?.agentId,
        memberPresent: recoveryConfig.members.length === 1,
        appPresent: Boolean(appState.teamContext.teammates[recoveryMember.agentId]), cleanupStateAbsent: recoveryState === null },
    }))
  } finally {
    if (authority) authorityModule.revokeCanonicalTeamLockAuthority(authority)
    for (const fd of Object.values(fds)) try { closeSync(fd) } catch {}
  }
}

async function rootFixture(parentNamespace: string): Promise<void> {
  if (process.platform !== 'linux' || process.geteuid?.() !== 0) throw new Error('fixture requires Linux root')
  const isolated = readlinkSync('/proc/self/ns/mnt') !== parentNamespace
  if (!isolated) throw new Error('fixture did not enter a private mount namespace')
  const initialMountInfo = readFileSync('/proc/self/mountinfo', 'utf8')
  const privatePropagation = initialMountInfo.split('\n').filter(Boolean).every(line => {
    const optionalFields = line.split(' - ')[0]?.split(' ').slice(6) ?? []
    return !optionalFields.some(field => field.startsWith('shared:') || field.startsWith('master:'))
  })
  if (!privatePropagation) throw new Error('fixture mount namespace propagation is not private')
  const base = mkdtempSync('/tmp/hosted-mailbox-shutdown-')
  const mounts: string[] = []
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    const backing = join(base, 'backing')
    const configSource = join(backing, 'config')
    const tasksSource = join(backing, 'tasks')
    const teamSource = join(backing, 'team')
    const view = join(base, 'view')
    const config = join(view, 'config')
    const teams = join(config, 'teams')
    const team = join(teams, TEAM)
    const tasks = join(config, 'tasks')
    const registry = join(config, 'registry')
    const anchorParent = join(registry, 'registration')
    const anchor = join(anchorParent, 'lock')
    const record = join(anchorParent, 'binding.json')
    const temp = join(base, 'tmp')
    const cache = join(base, 'cache')
    mkdirSync(join(configSource, 'teams', TEAM), { recursive: true, mode: 0o755 })
    mkdirSync(join(configSource, 'tasks'), { recursive: true, mode: 0o755 })
    mkdirSync(join(configSource, 'registry', 'registration'), { recursive: true, mode: 0o755 })
    mkdirSync(join(tasksSource, TEAM), { recursive: true, mode: 0o700 })
    mkdirSync(teamSource, { recursive: true, mode: 0o700 })
    mkdirSync(config, { recursive: true, mode: 0o700 })
    chmodSync(view, 0o755)
    chmodSync(backing, 0o700)
    mkdirSync(temp, { mode: 0o700 })
    mkdirSync(cache, { mode: 0o700 })
    chownSync(configSource, APP_UID, APP_GID)
    for (const path of [tasksSource, join(tasksSource, TEAM), teamSource, temp, cache]) chownSync(path, APP_UID, APP_GID)
    for (const path of [join(configSource, 'teams'), join(configSource, 'registry'), join(configSource, 'registry', 'registration')]) chmodSync(path, 0o555)
    writeFileSync(join(configSource, 'registry', 'registration', 'lock'), '')
    chmodSync(join(configSource, 'registry', 'registration', 'lock'), 0o444)
    await command(['/usr/bin/mount', '--bind', configSource, config])
    mounts.push(config)
    await command(['/usr/bin/mount', '-o', 'remount,bind,ro', config])
    await command(['/usr/bin/mount', '--bind', tasksSource, tasks])
    mounts.push(tasks)
    await command(['/usr/bin/mount', '--bind', teamSource, team])
    mounts.push(team)

    const root = lstatSync(team)
    const parent = lstatSync(teams)
    const anchorStat = lstatSync(anchor)
    const anchorParentStat = lstatSync(anchorParent)
    const binding = {
      protocolVersion: 1, registrationId: 'shutdown-test', publicTeamId: 'public-atlas',
      legacyKey: TEAM, storageGeneration: 'generation-1', admittedWriterImage: 'image-1',
      canonicalTeamRoot: team,
      root: { dev: root.dev, ino: root.ino, mountId: mountId(team, true) },
      rootParent: { dev: parent.dev, ino: parent.ino, mountId: mountId(teams, true) },
      anchor: { dev: anchorStat.dev, ino: anchorStat.ino, mountId: mountId(anchor) },
      anchorParent: { dev: anchorParentStat.dev, ino: anchorParentStat.ino, mountId: mountId(anchorParent, true) },
    }
    writeFileSync(join(configSource, 'registry', 'registration', 'binding.json'), JSON.stringify(binding))
    chmodSync(join(configSource, 'registry', 'registration', 'binding.json'), 0o444)
    const specPath = join(base, 'fixture.json')
    const sourceRoot = import.meta.dir
    writeFileSync(specPath, JSON.stringify({
      config, teams, team, tasks, registry, anchor, anchorParent, record, binding, isolated,
      privatePropagation,
      configReadOnly: readFileSync('/proc/self/mountinfo', 'utf8').split('\n').some(line =>
        line.includes(` ${config.replaceAll(' ', '\\040')} `) && line.split(' - ')[0]?.split(' ')[5]?.split(',').includes('ro')),
      authorityUrl: pathToFileURL(join(sourceRoot, '../../utils/swarm/canonicalTeamLockAuthority.ts')).href,
      handlerUrl: pathToFileURL(join(sourceRoot, 'hostedMailboxShutdown.ts')).href,
      cleanupUrl: pathToFileURL(join(sourceRoot, 'hostedMailboxShutdownCleanup.ts')).href,
      tasksUrl: pathToFileURL(join(sourceRoot, '../../utils/tasks.ts')).href,
    }))
    chmodSync(specPath, 0o444)
    chmodSync(base, 0o755)
    console.log('FIXTURE_READY')
    child = Bun.spawn({
      cmd: [process.execPath, '--no-install', '--tsconfig-override', join(sourceRoot, '../../..', 'tsconfig.json'),
        import.meta.path, '--worker', specPath], uid: APP_UID, gid: APP_GID,
      stdout: 'inherit', stderr: 'inherit',
      env: { ...process.env, HOME: config, TMPDIR: temp, XDG_CACHE_HOME: cache,
        BUN_INSTALL_CACHE_DIR: cache, CLAUDE_CONFIG_DIR: config },
    })
    const exitCode = await child.exited
    child = undefined
    if (exitCode !== 0) throw new Error(`application worker exited ${exitCode}`)
  } finally {
    if (child) { child.kill('SIGKILL'); await child.exited }
    let unmountError: unknown
    for (const target of mounts.reverse()) {
      try { await command(['/usr/bin/umount', target]) } catch (error) { unmountError ??= error }
    }
    if (!unmountError) rmSync(base, { recursive: true, force: true })
    else throw unmountError
  }
}

const [mode, value] = process.argv.slice(2)
if (mode === '--worker') await worker(value)
else if (mode === '--fixture-root') await rootFixture(value)
else throw new Error(`invalid fixture mode: ${basename(mode ?? '')}`)
