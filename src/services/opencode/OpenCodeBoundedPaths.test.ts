import type { OpenCodeExecutionProbeResult } from './types.js'
import { describe, expect, test, spyOn } from 'bun:test'
import * as fsPromises from 'node:fs/promises'
import * as atomicWrites from '../../utils/atomicWrite.js'
import * as boundedPathsModule from './OpenCodeBoundedPaths.js'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, rm, realpath, symlink, link } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import {
  assertBoundedAuthObjects, validateOpenCodeBoundedPaths, resolveBoundedAuthPath,
  applyBoundedLocalMcp, type OpenCodeBoundedExecutionPaths,
} from './OpenCodeBoundedPaths.js'
import { getCoordinationDatabasePath, withOpenCodeAuthCoordinationLock } from './OpenCodeAuthCoordinationLock.js'
import { listPreparedAuthPaths, prepareOpenCodeProfile, type OpenCodeProfilePreparationInput } from './OpenCodeProfilePreparation.js'
import { resolveOpenCodeAppMcpLaunchConfig } from './OpenCodeAppMcpLaunchConfig.js'
import {
  readOpenCodeAuthStore, readOpenCodeAuthCredential, reconcileOpenCodeManagedAuthStores, reconcileOpenCodeManagedAuthStore,
  upsertOpenCodeAuthCredential, removeOpenCodeAuthCredential, fanOutOpenCodeOAuthCredential, withOpenCodeOAuthRefreshLock,
} from './OpenCodeAuthStore.js'
import {
  canonicalPreparedProfile, decodePreparedProfile, projectPreparedProfile, restorePreparedProfile,
  retainPreparedProfile, verifyPreparedProfileBinding,
} from './OpenCodePreparedProfileContract.js'
import { retainOpenCodeProfileCurrentness } from './OpenCodeProfileCurrentness.js'
import { buildManagedConfigFingerprint } from './OpenCodeManagedConfigFingerprint.js'
import { OpenCodeOAuthRefreshCoordinator } from './OpenCodeOAuthRefreshCoordinator.js'

type Draft<T> = { -readonly [K in keyof T]: T[K] extends object ? Draft<T[K]> : T[K] }
const digest = (s: string) => createHash('sha256').update(s).digest('hex')
const oauth = (expires: number, access = `synthetic-${expires}`) => ({ type:'oauth', expires, access, refresh:'synthetic-refresh' })
async function put(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive:true })
  await writeFile(file,JSON.stringify(value),{mode:0o600})
}
async function fixture(run: (input: OpenCodeProfilePreparationInput, c: OpenCodeBoundedExecutionPaths, root: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(),'owner-bounded-source-')))
  try {
    const project = path.join(root,'project'), data = path.join(root,'data'), cache = path.join(root,'cache')
    const profile = path.join(data,'opencode/profiles',digest(project).slice(0,16))
    const global = path.join(data,'opencode/auth.json'), selected = path.join(profile,'data/opencode/auth.json')
    const source = path.join(root,'imports/auth.json')
    const c = validateOpenCodeBoundedPaths({
      format:'agent-teams.opencode-bounded-paths/v1',
      nativeSubscriptionHomePath:path.join(profile,'native-subscription-home'),
      // No success substitute: both real probes execute the actual Owner wrappers.
      // These deliberately absent selections cover unavailable CLI behavior only.
      // Root's later qualification must supply actual selected CLI artifacts.
      nativeExecutables:{cursor:path.join(root,'selected/cursor'),kiro:path.join(root,'selected/kiro'),path:[path.join(root,'selected')]},
      authCoordinationOutputDirectory:path.join(root,'coordination'),
      globalAuthPath:global, selectedAuthPath:selected, immutableAuthPaths:[source],
      authStores:[
        {logicalPath:global,outputPath:path.join(root,'stores/global/auth.json')},
        {logicalPath:selected,outputPath:selected},
        {logicalPath:path.join(data,'opencode/profiles','a'.repeat(16),'data/opencode/auth.json'),outputPath:path.join(root,'stores/peer/auth.json')},
      ],
      localMcp:{cwd:project,home:path.join(root,'mcp/home'),tmp:path.join(root,'mcp/tmp'),claudeDir:path.join(root,'mcp/claude'),
        command:[path.join(root,'selected/node'),path.join(root,'selected/mcp.js')],environment:{LANG:'C',PATH:path.join(root,'selected')}},
    })
    await mkdir(project); await mkdir(path.join(root,'source-home')); await mkdir(path.join(root,'selected'))
    await writeFile(path.join(project,'AGENTS.md'),'synthetic behavior')
    await put(source,{xai:oauth(100), api:{type:'api',key:'stale-import'}})
    await put(c.authStores[0].outputPath,{xai:oauth(200),api:{type:'api',key:'global-wins'}})
    await put(selected,{xai:oauth(300)})
    await put(c.authStores[2].outputPath,{xai:oauth(400),peerOnly:{type:'api',key:'preserved'}})
    const input: OpenCodeProfilePreparationInput = {
      projectPath:project,workingDirectory:project,paths:{data,cache},sourceHomePath:path.join(root,'source-home'),
      sourceAuthPaths:[source],globalAuthPath:global,environment:{HOME:path.join(root,'source-home')},platform:'linux',
      appMcpConfig:{type:'local',command:[...c.localMcp.command],environment:{LANG:'C'}},
      options:{includeManagedSubscriptionPlugins:true},boundedPaths:c,
    }
    await run(input,c,root)
  } finally { await rm(root,{recursive:true,force:true}) }
}

describe('actual bounded Owner preparation/auth source contract', () => {
  test('the admitted canonical J hash stays unchanged',()=>{
    expect(digest('/sandbox/project').slice(0,16)).toBe('88d06db8abf3f8d4')
  })
  test('canonical J/K/P, mapped freshness, global API precedence and all-peer fanout', () => fixture(async (input,c) => {
    const original = await readFile(c.immutableAuthPaths[0],'utf8')
    const profile = await prepareOpenCodeProfile(input)
    expect(profile.projectPath).toBe(input.projectPath)
    expect(profile.profileRootKey).toBe(digest(input.projectPath).slice(0,16))
    expect(profile.managedAuthPath).toBe(c.selectedAuthPath)
    expect(profile.profileRootPath).toBe(path.join(input.paths.data,'opencode/profiles',profile.profileRootKey))
    for (const store of c.authStores) expect((await readOpenCodeAuthStore(store.logicalPath,c)).xai).toEqual(oauth(400))
    expect((await readOpenCodeAuthStore(c.selectedAuthPath,c)).api.key).toBe('global-wins')
    // The exported reader canonicalizes provider IDs to lowercase; fanout preserves this API credential.
    expect((await readOpenCodeAuthStore(c.authStores[2].logicalPath,c)).peeronly.key).toBe('preserved')
    expect(await readFile(c.immutableAuthPaths[0],'utf8')).toBe(original)
    expect(await stat(c.globalAuthPath).then(()=>true,()=>false)).toBe(false)
    expect(profile.boundedAuthSources).toEqual(await Promise.all(c.authStores.map(async s=>({path:s.outputPath,fingerprint:digest(await readFile(s.outputPath,'utf8'))}))))
    expect(profile.sourceAuthSources).toEqual([{path:c.immutableAuthPaths[0],fingerprint:digest(original)}])
    expect(profile.authState).toBe('ok')
    expect(profile.managedConfig.plugin).toBeDefined()
    const wrapper = await readFile(profile.env.CURSOR_AGENT_EXECUTABLE!,'utf8')
    expect(wrapper).toContain(c.nativeExecutables.cursor)
    expect(wrapper).toContain(c.nativeSubscriptionHomePath)
    expect(wrapper).not.toContain(input.sourceHomePath)
    expect(profile.env.CURSOR_ACP_HOME_DIR).toBe(c.nativeSubscriptionHomePath)
    expect(profile.env.PATH).toBe([path.join(profile.profileRootPath,'native-subscription-cli-bin'),...c.nativeExecutables.path].join(':'))
  }))

  for (const freshCursor of [false,true]) test(`real native marker paths retain Cursor freshness and remove unavailable Kiro (fresh=${freshCursor})`,()=>fixture(async (input,c)=>{
    const store = await readOpenCodeAuthStore(c.globalAuthPath,c)
    await put(c.authStores[0].outputPath,{...store,
      'cursor-acp':{type:'api',key:'cursor-agent',expires:freshCursor ? Date.now()+86400000 : 0},
      kiro:oauth(Date.now()+86400000,'authenticated'),
    })
    await prepareOpenCodeProfile(input)
    for (const authPath of [c.globalAuthPath,c.selectedAuthPath]) {
      const current = await readOpenCodeAuthStore(authPath,c)
      expect(current.kiro).toBeUndefined()
      if (freshCursor) expect(current['cursor-acp']?.key).toBe('cursor-agent')
      else expect(current['cursor-acp']).toBeUndefined()
    }
  }))

  test('unchanged desktop default storage and legacy projection remain usable', () => fixture(async (input,c) => {
    const profile = await prepareOpenCodeProfile({...input,boundedPaths:undefined,
      options:{includeManagedSubscriptionPlugins:false},appMcpConfig:null})
    expect(profile.boundedPaths).toBeUndefined()
    expect(profile.managedAuthPath).toBe(c.selectedAuthPath)
    expect(getCoordinationDatabasePath(c.selectedAuthPath)).toBe(c.globalAuthPath+'.agent-teams-coordination.sqlite')
    const projection = projectPreparedProfile(profile)
    expect(projection).not.toHaveProperty('boundedPaths')
    expect(restorePreparedProfile(projection).managedAuthPath).toBe(c.selectedAuthPath)
  }))

  test('one physical SQLite authority, real nested refresh, atomic inode replacement and no temporary debris', () => fixture(async (input,c) => {
    await prepareOpenCodeProfile(input)
    const databases = c.authStores.map(s=>getCoordinationDatabasePath(s.logicalPath,JSON.parse(JSON.stringify(c))))
    expect(new Set(databases).size).toBe(1)
    expect(path.dirname(databases[0])).toBe(c.authCoordinationOutputDirectory)
    const before = await stat(c.authStores[0].outputPath)
    await withOpenCodeAuthCoordinationLock({authPath:c.globalAuthPath,boundedPaths:c,operation:async()=>{
      await expect(withOpenCodeAuthCoordinationLock({authPath:c.selectedAuthPath,
        boundedPaths:{...c,authCoordinationOutputDirectory:path.join(path.dirname(c.authCoordinationOutputDirectory),'other')},
        operation:async()=>undefined})).rejects.toThrow('opencode_bounded_coordination_mismatch')
      await expect(withOpenCodeAuthCoordinationLock({authPath:c.selectedAuthPath,
        operation:async()=>undefined})).rejects.toThrow('opencode_bounded_coordination_mismatch')
      await withOpenCodeOAuthRefreshLock({authPath:c.selectedAuthPath,providerId:'xai',boundedPaths:JSON.parse(JSON.stringify(c)),operation:async()=>{
        await upsertOpenCodeAuthCredential({authPath:c.selectedAuthPath,providerId:'xai',credential:oauth(900),boundedPaths:c})
        await fanOutOpenCodeOAuthCredential({providerId:'xai',sourceAuthPath:c.selectedAuthPath,
          targetAuthPaths:c.authStores.map(s=>s.logicalPath),boundedPaths:c})
      }})
    }})
    expect((await stat(c.authStores[0].outputPath)).ino).not.toBe(before.ino)
    for (const store of c.authStores) {
      expect((await readOpenCodeAuthStore(store.logicalPath,c)).xai).toEqual(oauth(900))
      expect(await readdir(path.dirname(store.outputPath))).toEqual(['auth.json'])
    }
    expect(await readdir(c.authCoordinationOutputDirectory)).toContain(path.basename(databases[0]))
  }))

  test('independent logical participants contend on the same real SQLite lease and abort without writes', () => fixture(async (input,c) => {
    await prepareOpenCodeProfile(input)
    let entered!: () => void, release!: () => void
    const ready = new Promise<void>(resolve=>{entered=resolve})
    const hold = new Promise<void>(resolve=>{release=resolve})
    const owner = withOpenCodeOAuthRefreshLock({authPath:c.globalAuthPath,providerId:'xai',boundedPaths:c,
      operation:async()=>{entered();await hold}})
    await ready
    try {
      // This call originates outside the owner's AsyncLocalStorage operation.
      await expect(withOpenCodeAuthCoordinationLock({authPath:c.authStores[2].logicalPath,boundedPaths:JSON.parse(JSON.stringify(c)),
        timeoutMs:1,operation:async()=>{throw new Error('second authority entered')}})).rejects.toThrow('Timed out waiting')
      const controller = new AbortController(), reason = new Error('synthetic cancellation')
      controller.abort(reason)
      await expect(withOpenCodeOAuthRefreshLock({authPath:c.selectedAuthPath,providerId:'xai',boundedPaths:c,
        abortSignal:controller.signal,operation:async()=>{throw new Error('cancelled participant entered')}})).rejects.toBe(reason)
    } finally { release();await owner }
    await withOpenCodeOAuthRefreshLock({authPath:c.selectedAuthPath,providerId:'xai',boundedPaths:c,operation:async()=>undefined})
  }))

  test('visible undeclared peers reject, while hidden declared peers remain participants', () => fixture(async (input,c) => {
    expect(await listPreparedAuthPaths(input.paths.data,c)).toContain(c.authStores[2].logicalPath)
    const unknown = path.join(input.paths.data,'opencode/profiles','b'.repeat(16))
    await mkdir(unknown,{recursive:true})
    await expect(prepareOpenCodeProfile(input)).rejects.toThrow('opencode_bounded_paths_rejected')
    expect((await readOpenCodeAuthStore(c.globalAuthPath,c)).xai).toEqual(oauth(200))
  }))

  test('equal-expiry tie order survives mapping and caller cannot prune declared peers', () => fixture(async (input,c) => {
    await put(c.immutableAuthPaths[0],{xai:oauth(400,'source-tie')})
    await prepareOpenCodeProfile(input)
    expect((await readOpenCodeAuthStore(c.selectedAuthPath,c)).xai.access).toBe('source-tie')
    await expect(reconcileOpenCodeManagedAuthStores({sourceAuthPaths:[c.globalAuthPath,...c.immutableAuthPaths],
      globalAuthPath:c.globalAuthPath,managedAuthPath:c.selectedAuthPath,peerManagedAuthPaths:[],boundedPaths:c})).rejects.toThrow('opencode_bounded_auth_membership')
    await expect(fanOutOpenCodeOAuthCredential({providerId:'xai',sourceAuthPath:c.selectedAuthPath,targetAuthPaths:[c.globalAuthPath],boundedPaths:c})).rejects.toThrow()
    expect(()=>resolveBoundedAuthPath(c.authStores[2].outputPath,c)).toThrow()
    await expect(upsertOpenCodeAuthCredential({authPath:c.immutableAuthPaths[0],providerId:'xai',credential:oauth(999),boundedPaths:c})).rejects.toThrow()
  }))

  test('real resolver overrides are resolved inside preparation before retention; D/B win', () => fixture(async (input,c) => {
    const resolved = await resolveOpenCodeAppMcpLaunchConfig({env:{
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND:c.localMcp.command[0],
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY:c.localMcp.command[1],
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON:JSON.stringify({HOME:' ../mcp/home ',USERPROFILE:c.localMcp.home,
        TMPDIR:'../mcp/tmp',AGENT_TEAMS_MCP_CLAUDE_DIR:'../mcp/claude',LANG:'C',
        CLAUDE_MULTIMODEL_DATA_HOME:'/stale/data',CLAUDE_MULTIMODEL_CACHE_HOME:'/stale/cache'}),
    },workingDirectory:input.projectPath,moduleDirectory:input.projectPath,repositoryRoot:input.projectPath,
      entrypoint:null,home:null,platform:'linux',resolveExecutable:()=>null})
    const profile = await prepareOpenCodeProfile({...input,appMcpConfig:resolved.config})
    const config = Object.values(profile.managedConfig.mcp as Record<string,Record<string,unknown>>)[0]
    expect(config.cwd).toBe(input.projectPath)
    expect(config.environment).toEqual({...c.localMcp.environment,HOME:c.localMcp.home,USERPROFILE:c.localMcp.home,
      TMPDIR:c.localMcp.tmp,TMP:c.localMcp.tmp,TEMP:c.localMcp.tmp,AGENT_TEAMS_MCP_CLAUDE_DIR:c.localMcp.claudeDir,
      CLAUDE_MULTIMODEL_DATA_HOME:input.paths.data,CLAUDE_MULTIMODEL_CACHE_HOME:input.paths.cache})
    expect(JSON.parse(projectPreparedProfile(profile).managedConfigJson)).toEqual(profile.managedConfig)
  }))

  test('retained full environment and contract are HMAC-covered across real generations and restored refresh', () => fixture(async (input,c) => {
    const profile = await prepareOpenCodeProfile(input), publication = retainPreparedProfile(profile)
    const key = Buffer.alloc(32,42), context = {expectedHostSha256:'1'.repeat(64),ownerProcessStartToken:'2'.repeat(64),bootstrapDigest:'3'.repeat(64)}
    try {
      const first = publication.transfer(key,context)
      const second = publication.transfer(key,{...context,ownerProcessStartToken:'4'.repeat(64)})
      expect(first.publicationId).toBe(second.publicationId)
      expect(first.binding.hmacSha256).not.toBe(second.binding.hmacSha256)
      const bytes = Buffer.from(canonicalPreparedProfile(first.preparedProfile))
      verifyPreparedProfileBinding(bytes,first.binding,key,context)
      const changed = structuredClone(first.preparedProfile)
      const config = JSON.parse(changed.managedConfigJson)
      const server = Object.values(config.mcp)[0] as {environment:Record<string,string>}
      server.environment.LANG = 'en_US.UTF-8'
      expect(buildManagedConfigFingerprint(config)).toBe(changed.managedConfigFingerprint)
      changed.managedConfigJson = JSON.stringify(config)
      expect(()=>decodePreparedProfile(Buffer.from(canonicalPreparedProfile(changed)))).toThrow()
      expect(()=>verifyPreparedProfileBinding(Buffer.from(canonicalPreparedProfile(changed)),first.binding,key,context)).toThrow()
      const moved = structuredClone(first.preparedProfile)
      moved.boundedPaths = {...c,authCoordinationOutputDirectory:path.join(path.dirname(c.authCoordinationOutputDirectory),'other-coordination')}
      expect(()=>verifyPreparedProfileBinding(Buffer.from(canonicalPreparedProfile(moved)),first.binding,key,context)).toThrow()
      const escaped = structuredClone(first.preparedProfile)
      escaped.boundedRuntimeEnvironment!.NODE_OPTIONS = '--require=/outside/loader.js'
      expect(()=>decodePreparedProfile(Buffer.from(canonicalPreparedProfile(escaped)))).toThrow()
      const restored = restorePreparedProfile(decodePreparedProfile(bytes))
      expect(restored.boundedPaths).toEqual(c)
      expect(restored.env).toEqual(profile.env)
      // Coordinator must pass the actual restored profile through its existing probe API.
      const coordinator = new OpenCodeOAuthRefreshCoordinator({boundedProfileLifetime:{withCurrentProfile:async (_profile,operation)=>operation()},nowMs:()=>1000,probeModel:async params=>{
        expect(params.preparedProfile).toBe(restored)
        await upsertOpenCodeAuthCredential({authPath:restored.managedAuthPath,providerId:'xai',credential:oauth(9999999),boundedPaths:restored.boundedPaths})
        return {outcome:'available'} as OpenCodeExecutionProbeResult
      }})
      await expect(coordinator.ensureFreshForPrompt({selectedModel:'xai/test',projectPath:input.projectPath,profile:restored})).resolves.toEqual({checked:true,refreshed:true})
      expect((await readOpenCodeAuthCredential({authPath:c.selectedAuthPath,providerId:'xai',boundedPaths:JSON.parse(JSON.stringify(c))}))?.expires).toBe(9999999)
    } finally { publication.close(); key.fill(0) }
    expect(()=>publication.transfer(Buffer.alloc(32),context)).toThrow()
  }))

  test.skipIf(process.platform !== 'linux')('currentness pins effective global/peer files and full projection, including absent objects', () => fixture(async (input,c) => {
    const profile = await prepareOpenCodeProfile(input), projection = projectPreparedProfile(profile)
    const retained = retainOpenCodeProfileCurrentness(projection)
    try {
      expect(retained.isCurrent()).toBe(true)
      await put(c.authStores[2].outputPath,{xai:oauth(500)})
      expect(retained.isCurrent()).toBe(false)
    } finally { retained.close() }
  }))

  test.skipIf(process.platform !== 'linux')('absent immutable imports retain their actual absent-parent identity', () => fixture(async (input,c,root) => {
    const absent = path.join(root,'missing-parent/import.json')
    const boundedPaths = validateOpenCodeBoundedPaths({...c,immutableAuthPaths:[...c.immutableAuthPaths,absent]})
    const profile = await prepareOpenCodeProfile({...input,boundedPaths,sourceAuthPaths:boundedPaths.immutableAuthPaths})
    expect(profile.sourceAuthSources?.find(s=>s.path === absent)?.fingerprint).toBeNull()
    const retained = retainOpenCodeProfileCurrentness(projectPreparedProfile(profile))
    try {
      expect(retained.isCurrent()).toBe(true)
      await put(absent,{xai:oauth(999)})
      expect(retained.isCurrent()).toBe(false)
    } finally { retained.close() }
  }))

  test('strict contract rejects aliases, overlap, unknown peers and live linked outputs before effects', () => fixture(async (_input,c,root) => {
    for (const mutate of [
      (v: Draft<OpenCodeBoundedExecutionPaths>)=>{Object.assign(v,{extra:true})},
      (v: Draft<OpenCodeBoundedExecutionPaths>)=>{v.authStores[2].logicalPath=v.authStores[0].logicalPath},
      (v: Draft<OpenCodeBoundedExecutionPaths>)=>{v.authStores[2].logicalPath=path.join(root,'unknown/auth.json')},
      (v: Draft<OpenCodeBoundedExecutionPaths>)=>{v.authStores[2].outputPath=v.authStores[0].outputPath},
      (v: Draft<OpenCodeBoundedExecutionPaths>)=>{v.authCoordinationOutputDirectory=path.dirname(v.authStores[0].outputPath)},
      (v: Draft<OpenCodeBoundedExecutionPaths>)=>{v.immutableAuthPaths=[v.globalAuthPath]},
      (v: Draft<OpenCodeBoundedExecutionPaths>)=>{v.nativeExecutables.path=['relative']},
      (v: Draft<OpenCodeBoundedExecutionPaths>)=>{v.localMcp.environment.NODE_OPTIONS='--require=/outside/loader.js'},
    ]) {
      const value = structuredClone(c) as Draft<OpenCodeBoundedExecutionPaths>; mutate(value)
      expect(()=>validateOpenCodeBoundedPaths(value)).toThrow()
    }
    const output = c.authStores[2].outputPath
    await rm(output); await symlink(c.immutableAuthPaths[0],output)
    await expect(assertBoundedAuthObjects(c)).rejects.toThrow()
    await rm(output); await link(c.immutableAuthPaths[0],output)
    await expect(assertBoundedAuthObjects(c)).rejects.toThrow()
  }))

  test('nested loaders, network/transport escapes, unknown environment, outside HOME and cwd reject', () => fixture(async (input,c) => {
    for (const environment of [{NODE_OPTIONS:'--import=/escape.js'},{HTTPS_PROXY:'https://escape.invalid'},
      {CLAUDE_TEAM_CONTROL_URL:'http://escape.invalid'},{XDG_RUNTIME_DIR:'/escape'},
      {HOME:'/outside'},{AGENT_TEAMS_MCP_CLAUDE_DIR:'../../outside'},{LANG:'{file:/outside/secret}'}]) {
      const config = {mcp:{app:{type:'local',command:[...c.localMcp.command],environment}}}
      expect(()=>applyBoundedLocalMcp(config,c,input.paths.data,input.paths.cache)).toThrow()
      await expect(prepareOpenCodeProfile({...input,appMcpConfig:{type:'local',command:[...c.localMcp.command],environment}})).rejects.toThrow()
    }
    await expect(prepareOpenCodeProfile({...input,environment:{NODE_OPTIONS:'--require=/escape'}})).rejects.toThrow()
    await expect(prepareOpenCodeProfile({...input,environment:{CURSOR_ACP_HOME_DIR:input.sourceHomePath}})).rejects.toThrow()
    await expect(prepareOpenCodeProfile({...input,appMcpConfig:{type:'remote',url:'https://escape.invalid'}})).rejects.toThrow()
    await expect(prepareOpenCodeProfile({...input,appMcpConfig:{...input.appMcpConfig!,cwd:'/outside'}})).rejects.toThrow()
  }))
})

// These are source regression fixtures. They do not mount the Root Product port.
describe('bounded review regressions', () => {
  test('provider IDs are normalized by the real reader without deleting peer-only API credentials', () => fixture(async (_input,c) => {
    const before = await readOpenCodeAuthStore(c.authStores[2].logicalPath,c)
    expect(before.peeronly).toEqual({type:'api',key:'preserved'})
    expect(before.peerOnly).toBeUndefined()
    await fanOutOpenCodeOAuthCredential({providerId:'xai',sourceAuthPath:c.selectedAuthPath,
      targetAuthPaths:c.authStores.map(s=>s.logicalPath),boundedPaths:c})
    expect((await readOpenCodeAuthStore(c.authStores[2].logicalPath,c)).peeronly).toEqual(before.peeronly)
    expect((await readOpenCodeAuthStore(c.selectedAuthPath,c)).peeronly).toBeUndefined()
  }))

  test('XDG state dot components and substitutions reject at actual admission and private decode', () => fixture(async (input,c) => {
    const profile = await prepareOpenCodeProfile({...input,environment:{...input.environment,
      XDG_STATE_HOME:c.nativeSubscriptionHomePath+'/state'}})
    const original = projectPreparedProfile(profile)
    expect(restorePreparedProfile(original).env.XDG_STATE_HOME).toBe(c.nativeSubscriptionHomePath+'/state')
    for (const value of [c.nativeSubscriptionHomePath+'/../outside-state',c.nativeSubscriptionHomePath+'/./state',
      c.nativeSubscriptionHomePath+'//state',c.nativeSubscriptionHomePath+'/{env:HOME}',
      c.nativeSubscriptionHomePath+'/{file:/outside}', '../state', '/outside-state']) {
      const before = await authBytes(c)
      await expect(prepareOpenCodeProfile({...input,environment:{...input.environment,XDG_STATE_HOME:value}})).rejects.toThrow()
      expect(await authBytes(c)).toEqual(before)
      const projection = structuredClone(original)
      projection.boundedRuntimeEnvironment!.XDG_STATE_HOME = value
      expect(()=>decodePreparedProfile(Buffer.from(canonicalPreparedProfile(projection)))).toThrow()
    }
  }))

  test('peer permutations select canonical equal-expiry winners in both exported multi-store APIs', () => fixture(async (_input,initial,root) => {
    const c = validateOpenCodeBoundedPaths({...initial,authStores:[...initial.authStores,
      {logicalPath:path.join(path.dirname(initial.globalAuthPath),'profiles','b'.repeat(16),'data/opencode/auth.json'),
        outputPath:path.join(root,'stores/peer-b/auth.json')}]})
    const [global,selected,a,b] = c.authStores
    const seed = async (selectedExpiry=100,globalExpiry=100,importExpiry=100) => {
      await put(global.outputPath,{xai:oauth(globalExpiry,'global'),api:{type:'api',key:'global'}})
      await put(selected.outputPath,{xai:oauth(selectedExpiry,'selected')})
      await put(a.outputPath,{xai:oauth(400,'A'),peeronly:{type:'api',key:'keep'}})
      await put(b.outputPath,{xai:oauth(400,'B')})
      await put(c.immutableAuthPaths[0],{xai:oauth(importExpiry,'import'),api:{type:'api',key:'stale'}})
    }
    for (const peers of permutations([selected.logicalPath,a.logicalPath,b.logicalPath])) {
      await seed()
      await reconcileOpenCodeManagedAuthStores({boundedPaths:c,globalAuthPath:c.globalAuthPath,
        managedAuthPath:c.selectedAuthPath,sourceAuthPaths:[c.globalAuthPath,...c.immutableAuthPaths],peerManagedAuthPaths:peers})
      for (const store of c.authStores) expect((await readOpenCodeAuthStore(store.logicalPath,c)).xai.access).toBe('A')
      expect((await readOpenCodeAuthStore(c.selectedAuthPath,c)).api.key).toBe('global')
      expect((await readOpenCodeAuthStore(a.logicalPath,c)).peeronly.key).toBe('keep')
    }
    for (const targets of permutations([global.logicalPath,a.logicalPath,b.logicalPath])) {
      await seed()
      await fanOutOpenCodeOAuthCredential({boundedPaths:c,providerId:'xai',sourceAuthPath:c.selectedAuthPath,targetAuthPaths:targets})
      for (const store of c.authStores) expect((await readOpenCodeAuthStore(store.logicalPath,c)).xai.access).toBe('A')
    }
    for (const [selectedExpiry,globalExpiry,importExpiry,winner] of [
      [400,100,100,'selected'], [400,400,400,'import'],
    ] as const) {
      await seed(selectedExpiry,globalExpiry,importExpiry)
      await reconcileOpenCodeManagedAuthStores({boundedPaths:c,globalAuthPath:c.globalAuthPath,managedAuthPath:c.selectedAuthPath,
        sourceAuthPaths:[c.globalAuthPath,...c.immutableAuthPaths],peerManagedAuthPaths:[b.logicalPath,a.logicalPath]})
      expect((await readOpenCodeAuthStore(c.selectedAuthPath,c)).xai.access).toBe(winner)
    }
    for (const [source,selectedExpiry,globalExpiry,winner] of [
      [selected.logicalPath,400,400,'selected'], [a.logicalPath,400,400,'A'],
      [selected.logicalPath,100,400,'global'], [b.logicalPath,400,400,'B'],
      [global.logicalPath,400,400,'global'], [global.logicalPath,400,100,'selected'],
    ] as const) {
      await seed(selectedExpiry,globalExpiry)
      await fanOutOpenCodeOAuthCredential({boundedPaths:c,providerId:'xai',sourceAuthPath:source,
        targetAuthPaths:c.authStores.map(s=>s.logicalPath).reverse()})
      for (const store of c.authStores) expect((await readOpenCodeAuthStore(store.logicalPath,c)).xai.access).toBe(winner)
    }
  }))

  test('complete effective import order is mandatory, including global; only actual ENOENT is omitted', () => fixture(async (_input,initial,root) => {
    const second = path.join(root,'imports/second.json'), absent = path.join(root,'absent/import.json')
    const c = validateOpenCodeBoundedPaths({...initial,immutableAuthPaths:[...initial.immutableAuthPaths,second,absent]})
    await put(second,{xai:oauth(400,'last-import')})
    const complete = [c.globalAuthPath,c.immutableAuthPaths[0],second]
    const reconcile = (sources: string[]) => reconcileOpenCodeManagedAuthStores({boundedPaths:c,sourceAuthPaths:sources,
      globalAuthPath:c.globalAuthPath,managedAuthPath:c.selectedAuthPath,peerManagedAuthPaths:c.authStores.slice(1).map(s=>s.logicalPath)})
    for (const sources of [[],complete.slice(1),[c.globalAuthPath],complete.slice().reverse(),[...complete,absent],
      [complete[0],complete[2],complete[1]], [...complete,complete[1]]]) {
      const before = await authBytes(c)
      await expect(reconcile(sources)).rejects.toThrow('opencode_bounded_auth_sources')
      await expect(reconcileOpenCodeManagedAuthStore({boundedPaths:c,sourceAuthPaths:sources,managedAuthPath:c.selectedAuthPath})).rejects.toThrow()
      expect(await authBytes(c)).toEqual(before)
      expect(await readdir(c.authCoordinationOutputDirectory).catch(()=>[])).toEqual([])
    }
    await put(c.immutableAuthPaths[0],{xai:oauth(400,'first-import')})
    await reconcile(complete)
    expect((await readOpenCodeAuthStore(c.selectedAuthPath,c)).xai.access).toBe('last-import')
    await rm(c.authStores[0].outputPath)
    await reconcile(complete.slice(1))
    expect((await readOpenCodeAuthStore(c.globalAuthPath,c)).xai.access).toBe('last-import')
  }))

  for (const bad of ['false','0','null','""','   \n','[]','true','"credential"','{"xai":false}','{']) {
    for (const role of ['global','import','peer'] as const) test(`present ${role} document ${JSON.stringify(bad)} rejects before any writes`, () => fixture(async (input,c) => {
      const target = role === 'global' ? c.authStores[0].outputPath : role === 'peer' ? c.authStores[2].outputPath : c.immutableAuthPaths[0]
      await writeFile(target,bad)
      const before = await authBytes(c)
      await expect(prepareOpenCodeProfile(input)).rejects.toThrow()
      await expect(reconcileOpenCodeManagedAuthStores({boundedPaths:c,sourceAuthPaths:[c.globalAuthPath,...c.immutableAuthPaths],
        globalAuthPath:c.globalAuthPath,managedAuthPath:c.selectedAuthPath,
        peerManagedAuthPaths:c.authStores.slice(1).map(s=>s.logicalPath)})).rejects.toThrow()
      await expect(upsertOpenCodeAuthCredential({boundedPaths:c,authPath:c.selectedAuthPath,providerId:'xai',credential:oauth(900)})).rejects.toThrow()
      await expect(fanOutOpenCodeOAuthCredential({boundedPaths:c,providerId:'xai',sourceAuthPath:c.selectedAuthPath,
        targetAuthPaths:c.authStores.map(s=>s.logicalPath)})).rejects.toThrow()
      let refreshEntered = false
      await expect(withOpenCodeOAuthRefreshLock({boundedPaths:c,authPath:c.selectedAuthPath,providerId:'xai',
        operation:async()=>{refreshEntered=true}})).rejects.toThrow()
      expect(refreshEntered).toBe(false)
      expect(await authBytes(c)).toEqual(before)
      expect(await readdir(c.authCoordinationOutputDirectory).catch(()=>[])).toEqual([])
      for (const store of c.authStores) expect(await readdir(path.dirname(store.outputPath))).toEqual(['auth.json'])
      expect(await readdir(path.dirname(path.dirname(path.dirname(c.selectedAuthPath))))).toEqual(['data'])
    }))
  }

  test('legacy falsy/blank documents stay separate; bounded ENOENT and explicit empty objects remain valid', () => fixture(async (_input,c,root) => {
    const legacy = path.join(root,'legacy-auth.json')
    for (const raw of ['false','0','null','""',' \n']) {
      await writeFile(legacy,raw)
      expect(await readOpenCodeAuthStore(legacy)).toEqual({})
    }
    await rm(c.authStores[0].outputPath)
    expect(await readOpenCodeAuthStore(c.globalAuthPath,c)).toEqual({})
    await put(c.authStores[0].outputPath,{})
    expect(await readOpenCodeAuthStore(c.globalAuthPath,c)).toEqual({})
  }))
})

async function authBytes(c: OpenCodeBoundedExecutionPaths) {
  return Promise.all([...c.immutableAuthPaths,...c.authStores.map(s=>s.outputPath)].map(async p=>({path:p,
    bytes:await readFile(p,'utf8').catch(error=>{if (error.code === 'ENOENT') return null;throw error})})))
}
function permutations<T>(values: T[]): T[][] {
  return values.length ? values.flatMap((value,index)=>permutations(values.filter((_,i)=>i!==index)).map(tail=>[value,...tail])) : [[]]
}

describe('bounded reentrant marker mutation scheduling', () => {
  for (const logicalIndex of [0,1]) for (const action of ['delete','insert'] as const) {
    test(`${action} sibling native markers at ${logicalIndex === 0 ? 'global' : 'selected'} serialize read through actual replacement`, () => fixture(async (_input,c) => {
      const target = c.authStores[logicalIndex]
      await put(target.outputPath,action === 'delete'
        ? {'cursor-acp':{type:'api',key:'cursor-agent'},kiro:oauth(900),'unrelated':{type:'api',key:'keep'}}
        : {unrelated:{type:'api',key:'keep'}})
      // Admit real fixture objects once. Only the scheduling phase uses captured
      // reads; the real exported mutation APIs and atomic replacement still run.
      await assertBoundedAuthObjects(c)
      const read = fsPromises.readFile, replace = atomicWrites.writeJsonFileAtomic
      const snapshots = new Map((await authBytes(c)).map(entry=>[entry.path,entry.bytes!]))
      const writes: Array<Record<string,unknown>> = []
      let firstEntered!: () => void, releaseFirst!: () => void
      const entered = new Promise<void>(resolve=>{firstEntered=resolve})
      const held = new Promise<void>(resolve=>{releaseFirst=resolve})
      await withOpenCodeAuthCoordinationLock({authPath:c.globalAuthPath,boundedPaths:c,operation:async()=>{
        const identitySpy = spyOn(boundedPathsModule,'assertBoundedAuthObjects').mockResolvedValue(undefined)
        const readSpy = spyOn(fsPromises,'readFile').mockImplementation(((file: unknown,options: unknown) => {
          if (typeof file === 'string' && snapshots.has(file) && options === 'utf8') return Promise.resolve(snapshots.get(file)!)
          return read(file as Parameters<typeof read>[0],options as Parameters<typeof read>[1])
        }) as typeof read)
        const replaceSpy = spyOn(atomicWrites,'writeJsonFileAtomic').mockImplementation(async (...args) => {
          if (args[0] === target.outputPath) {
            writes.push(structuredClone(args[1]) as Record<string,unknown>)
            if (writes.length === 1) { firstEntered();await held }
          }
          await replace(...args)
          if (snapshots.has(args[0])) snapshots.set(args[0],await read(args[0],'utf8'))
        })
        const mutate = (providerId:string) => action === 'delete'
          ? removeOpenCodeAuthCredential({authPath:target.logicalPath,providerId,boundedPaths:c})
          : upsertOpenCodeAuthCredential({authPath:target.logicalPath,providerId,boundedPaths:c,
            credential:providerId === 'kiro' ? oauth(900) : {type:'api',key:'cursor-agent'}})
        let first: Promise<void> | undefined, second: Promise<void> | undefined
        try {
          first = mutate('cursor-acp')
          await entered
          // Both inherit the same real SQLite lease. The read and identity
          // scheduler above resolves without I/O, so one event-loop checkpoint
          // drains the sibling to its queue wait (or exposes a stale replacement).
          second = withOpenCodeOAuthRefreshLock({authPath:target.logicalPath,providerId:'kiro',boundedPaths:c,
            operation:()=>mutate('kiro')})
          await new Promise<void>(resolve=>setImmediate(resolve))
          expect(writes).toHaveLength(1)
        } finally {
          releaseFirst()
          await Promise.allSettled([first,second].filter((p): p is Promise<void>=>!!p))
          replaceSpy.mockRestore();readSpy.mockRestore();identitySpy.mockRestore()
        }
        await first;await second
        expect(writes).toHaveLength(2)
        const final = JSON.parse(await read(target.outputPath,'utf8'))
        expect(final.unrelated).toEqual({type:'api',key:'keep'})
        if (action === 'delete') {
          expect(writes[1]['cursor-acp']).toBeUndefined()
          expect(final['cursor-acp']).toBeUndefined();expect(final.kiro).toBeUndefined()
        } else {
          expect(writes[1]['cursor-acp']).toEqual({type:'api',key:'cursor-agent'})
          expect(final['cursor-acp']).toEqual({type:'api',key:'cursor-agent'});expect(final.kiro).toEqual(oauth(900))
        }
      }})
      expect(await readdir(path.dirname(target.outputPath))).toEqual(['auth.json'])
    }))
  }
})

describe('bounded actual action and execution edges', () => {
  test('connect and model-test pass one admitted profile to host, refresh, and proof throughout cleanup', () => fixture(async (input,c) => {
    const { OpenCodeProviderManagementAdapter } = await import('../../features/runtimeProviderManagement/adapters/opencode/OpenCodeProviderManagementAdapter.js')
    const profile = await prepareOpenCodeProfile(input)
    const inventory: import('./types.js').OpenCodeInventorySnapshot = {
      detected:true,binaryPath:c.nativeExecutables.cursor,version:'fixture',projectPath:profile.projectPath,profile,
      connectedProviders:[{id:'openrouter',authHint:'api',source:'credentials',credentialScopes:['managed']}],
      availableProviders:['openrouter'],models:['openrouter/openrouter/free'],agents:[],
      authStorePath:profile.managedAuthPath,probeError:null,diagnostics:[],
    }
    const host: import('./types.js').OpenCodeHostHandle = {
      hostKey:'fixture',profileRootKey:profile.profileRootKey,projectPath:profile.projectPath,
      projectBehaviorFingerprint:profile.projectBehaviorFingerprint,baseUrl:'http://127.0.0.1:1',port:1,pid:1,
      version:'fixture',state:'healthy',profile,resolvedConfigFingerprint:profile.managedConfigFingerprint,diagnostics:[],
    }
    let active = false, admitted = true, probes = 0, hosts = 0, refreshes = 0, initialReads = 0, cleanups = 0
    const lifetime: import('./OpenCodeBoundedPaths.js').OpenCodeBoundedProfileLifetime = {
      async withCurrentProfile(selected,operation) {
        if (!admitted) throw new Error('fixture lifetime closed')
        expect(selected).toBe(profile);expect(active).toBe(false);active=true
        try { return await operation() } finally { active=false }
      },
    }
    const dependencies: ConstructorParameters<typeof OpenCodeProviderManagementAdapter>[0] = {
      boundedProfileLifetime:lifetime,
      inventoryService:{probe:async()=>{initialReads++;return inventory},probePrepared:async selected=>{
        expect(active).toBe(true);expect(selected).toBe(profile);refreshes++;return inventory
      }},
      hostManager:{ensureHost:async args=>{
        expect(active).toBe(true);expect(args?.preparedProfile).toBe(profile)
        expect(args?.projectPath).toBe(profile.projectPath);hosts++;return host
      },releaseHost:async()=>{expect(active).toBe(true);cleanups++}},
      clientFactory:{create:()=>({
        getConfigProviders:async()=>({providers:[{id:'openrouter',name:'OpenRouter',models:{'openrouter/free':{}}}],default:{}}),
        getProviders:async()=>({all:[{id:'openrouter',name:'OpenRouter'}],connected:['openrouter'],default:{}}),
        getProviderAuth:async()=>({openrouter:[{type:'api'}]}),
        setProviderAuth:async()=>{expect(active).toBe(true);return true},
      })},
      executionProbe:{probeModel:async args=>{
        expect(active).toBe(true);expect(args.preparedProfile).toBe(profile)
        expect(args.projectPath).toBe(profile.projectPath);probes++;return probeSuccess(args.selectedModel)
      }},
    }
    const adapter = new OpenCodeProviderManagementAdapter(dependencies)
    expect((await adapter.connectWithApiKey({runtimeId:'opencode',providerId:'openrouter',apiKey:'synthetic-key',projectPath:profile.projectPath})).ok).toBe(true)
    expect((await adapter.testModel({runtimeId:'opencode',providerId:'openrouter',modelId:'openrouter/openrouter/free',projectPath:profile.projectPath})).ok).toBe(true)
    expect({probes,hosts,refreshes,initialReads,cleanups}).toEqual({probes:2,hosts:2,refreshes:1,initialReads:2,cleanups:2})
    for (const logical of [c.globalAuthPath,c.selectedAuthPath]) expect((await readOpenCodeAuthStore(logical,c)).openrouter.key).toBe('synthetic-key')
    const before = await authBytes(c)
    admitted=false
    const closed = await adapter.connectWithApiKey({runtimeId:'opencode',providerId:'openrouter',apiKey:'must-not-write'})
    expect(closed.ok).toBe(false);expect(hosts).toBe(2);expect(await authBytes(c)).toEqual(before)
    const unmounted = new OpenCodeProviderManagementAdapter({...dependencies,boundedProfileLifetime:undefined})
    expect((await unmounted.connectWithApiKey({runtimeId:'opencode',providerId:'openrouter',apiKey:'must-not-write'})).ok).toBe(false)
    expect(hosts).toBe(2);expect(await authBytes(c)).toEqual(before)
    const missingProbe = new OpenCodeProviderManagementAdapter({...dependencies,executionProbe:undefined})
    expect((await missingProbe.connectWithApiKey({runtimeId:'opencode',providerId:'openrouter',apiKey:'must-not-write'})).ok).toBe(false)
    expect(hosts).toBe(2);expect(await authBytes(c)).toEqual(before)

    // xAI has an outer refresh lease before its inner managed-client action.
    // That path must reuse the first inventory, including with nested lifetimes.
    let oauthReads=0, oauthHosts=0, depth=0
    const oauthDeps = {...dependencies,
      boundedProfileLifetime:{async withCurrentProfile<T>(selected: import('./types.js').OpenCodePreparedProfile,operation:()=>Promise<T>) {
        expect(selected).toBe(profile);depth++;try { return await operation() } finally { depth-- }
      }},
      inventoryService:{...dependencies.inventoryService!,probe:async()=>{
        oauthReads++;if (oauthReads>1) throw new Error('ambient second inventory')
        return inventory
      }},
      hostManager:{ensureHost:async(args: Parameters<NonNullable<typeof dependencies.hostManager>['ensureHost']>[0])=>{
        expect(depth).toBe(2);expect(args?.preparedProfile).toBe(profile);oauthHosts++
        throw new Error('fixture OAuth host fence')
      },releaseHost:async()=>{}},
    }
    const oauthInput = {runtimeId:'opencode' as const,providerId:'xai',method:'oauth' as const,
      authMethodIndex:0,oauthOperationId:'fixture-operation',projectPath:profile.projectPath}
    const observer = {authorizationReady:async()=>{throw new Error('must not authorize')}}
    await rm(c.authCoordinationOutputDirectory,{recursive:true,force:true})
    const noOAuthLifetime = new OpenCodeProviderManagementAdapter({...oauthDeps,boundedProfileLifetime:undefined})
    expect((await noOAuthLifetime.connectProvider(oauthInput,observer)).ok).toBe(false)
    expect(await readdir(c.authCoordinationOutputDirectory).catch(()=>[])).toEqual([])
    oauthReads=0
    const oauthResult = await new OpenCodeProviderManagementAdapter(oauthDeps).connectProvider(oauthInput,observer)
    expect(oauthResult.ok).toBe(false)
    if ('error' in oauthResult) expect(oauthResult.error.message).toBe('fixture OAuth host fence')
    expect({oauthReads,oauthHosts,depth}).toEqual({oauthReads:1,oauthHosts:1,depth:0})
    expect(await authBytes(c)).toEqual(before)
  }))

  test('default bounded host, Cursor probe and xAI coordinator reject before ambient preparation or effects', () => fixture(async (input,c) => {
    const { OpenCodeExecutionProbe } = await import('./OpenCodeExecutionProbe.js')
    const { OpenCodeHostManager } = await import('./OpenCodeHostManager.js')
    const { openCodeProfileManager } = await import('./OpenCodeProfileManager.js')
    const profile = await prepareOpenCodeProfile(input), before = await authBytes(c)
    await rm(c.authCoordinationOutputDirectory,{recursive:true,force:true})
    const ambient = spyOn(openCodeProfileManager,'prepareProfile').mockImplementation(async()=>{throw new Error('ambient prepare')})
    try {
      await expect(new OpenCodeHostManager().ensureHost({projectPath:profile.projectPath,preparedProfile:profile})).rejects.toThrow('UNMOUNTED')
      await expect(new OpenCodeExecutionProbe().probeModel({projectPath:profile.projectPath,preparedProfile:profile,
        selectedModel:'cursor-acp/test',cursorNativePreflightBeforeHost:true,cursorNativePreflightOnly:true})).rejects.toThrow('UNMOUNTED')
      await expect(new OpenCodeOAuthRefreshCoordinator().ensureFreshForPrompt({projectPath:profile.projectPath,
        profile,selectedModel:'xai/test'})).rejects.toThrow('UNMOUNTED')
      expect(ambient).not.toHaveBeenCalled()
      expect(await authBytes(c)).toEqual(before)
      expect(await readdir(c.authCoordinationOutputDirectory).catch(()=>[])).toEqual([])
    } finally { ambient.mockRestore() }
  }))

  test.skipIf(process.platform !== 'linux')('actual custody-bound Cursor native spawn and xAI host acquisition use the retained selected context', () => fixture(async (input,c) => {
    const { supervisedFixture } = await import('./OpenCodeSupervisedCustody.test-fixture.js')
    const { createOpenCodeSupervisedCustodyAcquirer } = await import('./OpenCodeSupervisedHostCustody.js')
    const { OpenCodeExecutionProbe } = await import('./OpenCodeExecutionProbe.js')
    const { OpenCodeHostManager } = await import('./OpenCodeHostManager.js')
    const { OpenCodeClientFactory } = await import('./OpenCodeClientFactory.js')
    const { OpenCodePreflightLeaseRegistry } = await import('./OpenCodePreflightLease.js')
    const portable = await import('../../utils/portableCli.js')
    const profile = await prepareOpenCodeProfile({...input,options:{...input.options,toolApprovalMode:'manual'}})
    let rejectHostEffect = false, nativeCalls = 0, hostCalls = 0, active = 0, live = true
    const selected = await supervisedFixture({mutateBundle(bundle) {
      const preflights = new OpenCodePreflightLeaseRegistry()
      const prepareLease = bundle.prepareLeaseToken
      Object.assign(bundle,{
        registerPreflightLease:preflights.register.bind(preflights),
        releasePreflightLease:preflights.release.bind(preflights),
      })
      bundle.prepareLeaseToken = async lease => preflights.has(lease)
        ? {consume:()=>live} : prepareLease(lease)
      const prepare = bundle.prepareEffectToken
      bundle.prepareEffectToken = async()=>{
        if (rejectHostEffect) throw new Error('fixture host effect fence')
        return prepare()
      }
    }})
    // The fixture owns its listener/process. Join the real prepared profile to
    // that test-only admission before calling the genuine custody acquirer.
    Object.assign(selected.profile,profile)
    for (const key of ['projectPath','profileRootKey','profileRootPath','projectBehaviorFingerprint',
      'managedConfigFingerprint','sourceAuthFingerprint','managedAuthFingerprint','sourceAuthSources'] as const) {
      Object.assign(selected.expected.profile,{[key]:profile[key]})
    }
    const ensure = OpenCodeHostManager.prototype.ensureHost
    const hostSpy = spyOn(OpenCodeHostManager.prototype,'ensureHost').mockImplementation(async function(this: InstanceType<typeof OpenCodeHostManager>,args) {
      expect(active).toBeGreaterThan(0);hostCalls++
      expect(projectPreparedProfile(args!.preparedProfile!)).toEqual(projectPreparedProfile(profile))
      expect(args?.projectPath).toBe(profile.projectPath)
      expect(args?.profileOptions).toEqual({toolApprovalMode:'manual'})
      return ensure.call(this,args)
    })
    const spawnSpy = spyOn(portable,'spawnPortableCli').mockImplementation((executable,args,options)=>{
      expect(active).toBeGreaterThan(0);nativeCalls++
      expect(executable).toBe(profile.env.CURSOR_AGENT_EXECUTABLE!)
      expect(options?.cwd).toBe(profile.tmpPath);expect(options?.env).toEqual(profile.env)
      expect(args).toContain(profile.tmpPath)
      expect(options?.env?.CURSOR_ACP_HOME_DIR).toBe(c.nativeSubscriptionHomePath)
      expect(options?.env?.PATH).toBe(profile.env.PATH)
      // Stop at the actual spawn boundary. No fake native success or provider.
      throw new Error('fixture selected spawn fence')
    })
    try {
      // selected.acquire captured the original fixture expectation before the
      // bounded profile join above. Capture the completed test admission now;
      // mutating selected.expected cannot update an existing acquirer's snapshot.
      const custody = await createOpenCodeSupervisedCustodyAcquirer(selected.source)()
      const policy = {mode:'supervisor-adopt-only' as const,custody}
      const hostManager = new OpenCodeHostManager({acquisitionPolicy:policy})
      const clientFactory = new OpenCodeClientFactory({acquisitionPolicy:policy})
      const boundedProfileLifetime: import('./OpenCodeBoundedPaths.js').OpenCodeBoundedProfileLifetime = {
        async withCurrentProfile(request,operation) {
          if (!live) throw new Error('fixture lifetime closed')
          expect(projectPreparedProfile(request)).toEqual(projectPreparedProfile(await custody.readPreparedProfile()))
          active++;try { return await operation() } finally { active-- }
        },
      }
      const noLifetime = new OpenCodeExecutionProbe({acquisitionPolicy:policy,hostManager,clientFactory})
      await expect(noLifetime.probeModel({projectPath:profile.projectPath,selectedModel:'xai/test'})).rejects.toThrow('UNMOUNTED')
      await expect(noLifetime.probeModel({projectPath:profile.projectPath,preparedProfile:profile,
        selectedModel:'cursor-acp/test',cursorNativePreflightBeforeHost:true})).rejects.toThrow('UNMOUNTED')
      expect(hostCalls).toBe(0);expect(nativeCalls).toBe(0)
      const substituted = structuredClone(profile)
      substituted.env.LANG = 'changed-after-admission'
      const substitutionLease = custody.createPreflightLease('execution')
      try {
        await expect(ensure.call(hostManager,{projectPath:profile.projectPath,preparedProfile:substituted,
          lease:substitutionLease})).rejects.toThrow('bounded profile substitution')
      } finally { custody.releasePreflightLease(substitutionLease) }
      const probe = new OpenCodeExecutionProbe({acquisitionPolicy:policy,hostManager,clientFactory,boundedProfileLifetime})
      const result = await probe.probeModel({projectPath:profile.projectPath,preparedProfile:profile,
        selectedModel:'cursor-acp/test',cursorNativePreflightBeforeHost:true,cursorNativePreflightOnly:true})
      expect(result.outcome).toBe('unknown');expect(nativeCalls).toBe(1);expect(hostCalls).toBe(0)
      rejectHostEffect=true
      const refresh = new OpenCodeOAuthRefreshCoordinator({boundedProfileLifetime,nowMs:()=>1000,probeModel:probe.probeModel.bind(probe)})
      await expect(refresh.ensureFreshForPrompt({projectPath:profile.projectPath,profile,selectedModel:'xai/test'})).rejects.toThrow('fixture host effect fence')
      expect(hostCalls).toBe(1);expect(nativeCalls).toBe(1)
      expect(selected.requests).toHaveLength(0)
      live=false
      await expect(probe.probeModel({projectPath:profile.projectPath,preparedProfile:profile,selectedModel:'cursor-acp/test',
        cursorNativePreflightBeforeHost:true})).rejects.toThrow('fixture lifetime closed')
      expect(nativeCalls).toBe(1);expect(active).toBe(0)
      expect(()=>new OpenCodeExecutionProbe({acquisitionPolicy:policy,hostManager,clientFactory,boundedProfileLifetime,
        prepareProfile:async()=>profile})).toThrow('custody-bound consumers')
    } finally { spawnSpy.mockRestore();hostSpy.mockRestore();await selected.close() }
  }),30_000)
})

function probeSuccess(modelId:string): OpenCodeExecutionProbeResult {
  return {providerId:'opencode',modelId,probePrompt:'PONG',expectedOutput:'PONG',outcome:'available',reason:null,
    durationMs:0,rawStatus:null,durableState:'idle',latestAssistantText:'PONG',latestAssistantPreview:'PONG',
    toolCallCount:0,errorCount:0,diagnostics:[]}
}
