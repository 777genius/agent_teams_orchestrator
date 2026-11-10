import {expect,test} from 'bun:test'
test('summary inventory retains the prepared V1 profile required by provider mutations; passive reads do not prepare it',async()=>{
 const target=import.meta.resolve('./OpenCodeInventoryService.ts'),identity=import.meta.resolve('./compatibility/OpenCodeNativeIdentity.ts'),profile=import.meta.resolve('./OpenCodeProfileManager.ts');
 const script=`import {mock} from 'bun:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
 const root=await mkdtemp(path.join(tmpdir(),'TEST-summary-'));let prepared=0,read=0;const managed={profileRootPath:root};
 const original=await import(${JSON.stringify(identity)});mock.module(${JSON.stringify(identity)},()=>({...original,inspectOpenCodeReadSelection:async()=>{read++;return {path:'/TEST/opencode',policy:{generation:'v1',version:'1.18.34'},fingerprint:'TEST'}}}));
 const p=await import(${JSON.stringify(profile)});p.openCodeProfileManager.prepareProfile=async()=>{prepared++;return managed};
 const {openCodeInventoryService:service}=await import(${JSON.stringify(target)});
 service.probePreparedProfile=async input=>({detected:true,profile:input.profile});
 try{const summary=await service.probe(root,{mode:'summary'});assert.equal(summary.detected,true);assert.equal(summary.profile,managed);assert.equal(prepared,1);assert.equal(read,1);
 const passive=await service.probe(root,{mode:'passive'});assert.equal(passive.profile,null);assert.equal(prepared,1);assert.equal(read,1)}finally{await rm(root,{recursive:true,force:true})}`;
 const child=Bun.spawn([process.execPath,'-e',script],{cwd:import.meta.dir,stdout:'pipe',stderr:'pipe'});const [exit,stderr]=await Promise.all([child.exited,new Response(child.stderr).text()]);expect({exit,stderr}).toEqual({exit:0,stderr:''});
},15000)

test('settings directory retains summary credential evidence without CLI sweeps or treating anonymous Zen as connected', async () => {
  const target = import.meta.resolve('./OpenCodeInventoryService.ts')
  const identity = import.meta.resolve('./compatibility/OpenCodeNativeIdentity.ts')
  const profile = import.meta.resolve('./OpenCodeProfileManager.ts')
  const adapter = import.meta.resolve('../../features/runtimeProviderManagement/adapters/opencode/OpenCodeProviderManagementAdapter.ts')
  const script = `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    import { mkdtemp, rm, realpath, writeFile } from 'node:fs/promises'
    import { tmpdir } from 'node:os'
    import path from 'node:path'
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-directory-credentials-')))
    const connected = ['cursor-acp', 'github-copilot', 'google', 'kimi-for-coding', 'kimi-code-plan-global',
      'minimax-coding-plan', 'openai', 'openrouter', 'xai', 'xiaomi-token-plan-sgp', 'zai-coding-plan'].sort()
    const authPath = path.join(root, 'fixture-auth.json')
    const sourcePath = path.join(root, 'fixture-local-auth.json')
    const fixtureKey = 'TEST-only-placeholder'
    const credentials = Object.fromEntries(connected.map(id => [id, { type: 'api', key: fixtureKey }]))
    await writeFile(authPath, JSON.stringify(credentials))
    await writeFile(sourcePath, JSON.stringify({ google: credentials.google }))
    const managed = { profileRootPath: root, projectPath: root, managedAuthPath: authPath,
      globalAuthPath: authPath, sourceAuthPath: sourcePath, profileScope: null, authState: 'synced', managedConfig: {} }
    const original = await import(${JSON.stringify(identity)})
    mock.module(${JSON.stringify(identity)}, () => ({ ...original, inspectOpenCodeReadSelection: async () => ({
      path: '/TEST/opencode', policy: { generation: 'v1', version: '1.18.31' }, fingerprint: 'TEST',
    }) }))
    const p = await import(${JSON.stringify(profile)})
    p.openCodeProfileManager.prepareProfile = async () => managed
    const { OpenCodeProviderManagementAdapter } = await import(${JSON.stringify(adapter)})
    const { openCodeInventoryService: service } = await import(${JSON.stringify(target)})
    const commands = []
    service.execOpenCode = async (_binary, args) => {
      commands.push(args)
      assert.ok(['--version', 'providers'].includes(args[0]), 'No model/agent discovery CLI sweeps')
      return { stdout: args[0] === '--version' ? '1.18.31' : '', stderr: '', code: 0 }
    }

    const rows = [...connected, 'opencode', 'kiro'].map(id => ({ id, models: { fixture: {} } }))
    const directory = new OpenCodeProviderManagementAdapter({ inventoryService: service,
      hostManager: {
        ensureHost: async () => ({ hostKey: 'TEST', baseUrl: 'http://TEST.invalid', version: '1.18.31' }),
        releaseHost: async () => {},
      },
      clientFactory: { create: () => ({
        getConfigProviders: async () => ({ providers: rows, default: {} }),
        getProviders: async () => ({ all: rows, connected: rows.map(row => row.id), default: {} }),
        getProviderAuth: async () => ({}),
      }) },
    })
    try {
      const summary = await directory.loadDirectory({ runtimeId: 'opencode', projectPath: root, summary: true, limit: 100 })
      assert.equal(summary.ok, true)
      assert.deepEqual(summary.value.entries.filter(row => row.state === 'connected').map(row => row.providerId).sort(), connected)
      commands.length = 0
      const full = await directory.loadDirectory({ runtimeId: 'opencode', projectPath: root, limit: 100 })
      assert.equal(full.ok, true)
      assert.deepEqual(full.value.entries.filter(row => row.state === 'connected').map(row => row.providerId).sort(), connected)
      assert.deepEqual(commands, [], 'Settings reads must keep their zero-CLI optimization')
      assert.deepEqual(full.value.entries.find(row => row.providerId === 'google').ownership, ['managed', 'local'])
      assert.equal(full.value.entries.find(row => row.providerId === 'kiro').state, 'available', 'Config-only providers need credential evidence')
      assert.equal(full.value.entries.find(row => row.providerId === 'opencode').state, 'available', 'Anonymous Zen is available without a connection')
      assert.ok(!JSON.stringify(full).includes(fixtureKey))
      // Removing a saved connection must affect the next uncached inventory.
      delete credentials['github-copilot']
      await writeFile(authPath, JSON.stringify(credentials))
      const next = await service.probe(root, { mode: 'full', v1SettingsOnly: true })
      assert.ok(!next.connectedProviders.some(row => row.id === 'github-copilot'))
    } finally { await rm(root, { recursive: true, force: true }) }
  `
  const child = Bun.spawn([process.execPath, '-e', script], { cwd: import.meta.dir, stdout: 'pipe', stderr: 'pipe' })
  const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: '' })
}, 60000)

test('settings-only V1 preparation does not replace either V2 full catalog route or cache an empty full inventory',async()=>{
 const target=import.meta.resolve('./OpenCodeInventoryService.ts'),identity=import.meta.resolve('./compatibility/OpenCodeNativeIdentity.ts'),profile=import.meta.resolve('./OpenCodeProfileManager.ts'),v2=import.meta.resolve('./catalog/OpenCodeV2InventoryService.ts');
 const script=`import {mock} from 'bun:test';import assert from 'node:assert/strict';import {mkdtemp,rm,realpath} from 'node:fs/promises';import {tmpdir} from 'node:os';import path from 'node:path';
 const root=await realpath(await mkdtemp(path.join(tmpdir(),'TEST-settings-')));let prepared=0,reads=0,v2Reads=0,captured;let selected={path:'/TEST/opencode',policy:{generation:'v1',version:'1.18.31'},fingerprint:'TEST'};
 const original=await import(${JSON.stringify(identity)});mock.module(${JSON.stringify(identity)},()=>({...original,inspectOpenCodeReadSelection:async()=>{reads++;return selected}}));
 mock.module(${JSON.stringify(v2)},()=>({probeOpenCodeV2Inventory:async(native,directory)=>{v2Reads++;assert.equal(native,selected.native);assert.equal(directory,root);return {readGeneration:'v2',models:['TEST/authoritative']}}}));
 const p=await import(${JSON.stringify(profile)});p.openCodeProfileManager.prepareProfile=async()=>{prepared++;return {profileRootPath:root}};
 const {openCodeInventoryService:service}=await import(${JSON.stringify(target)});service.probePreparedProfile=async input=>{captured=input;return {detected:true}};
 try{await service.probe(root,{v1SettingsOnly:true});assert.equal(reads,1);assert.equal(prepared,1);assert.equal(captured.mode,'profile');assert.equal(captured.verifiedVersion,'1.18.31');assert.equal(captured.cacheEnabled,false);assert.ok(captured.cacheKey.includes('\\0profile\\0'));
 await service.probe(root,{mode:'full'});assert.equal(captured.mode,'full');assert.equal(captured.cacheEnabled,true);assert.equal(captured.verifiedVersion,undefined);
 for(const version of ['2.0.0','2.0.32']){selected={...selected,policy:{generation:'v2',version},native:{version,dialect:'v2-'+version}};const result=await service.probe(root,{v1SettingsOnly:true});assert.deepEqual(result.models,['TEST/authoritative']);assert.equal(result.readGeneration,'v2')}
 assert.equal(v2Reads,2);assert.equal(prepared,2);assert.equal(reads,4)}finally{await rm(root,{recursive:true,force:true})}`;
 const child=Bun.spawn([process.execPath,'-e',script],{cwd:import.meta.dir,stdout:'pipe',stderr:'pipe'});const [exit,stderr]=await Promise.all([child.exited,new Response(child.stderr).text()]);expect({exit,stderr}).toEqual({exit:0,stderr:''});
},15000)
