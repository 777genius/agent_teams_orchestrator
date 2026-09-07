import { describe, expect, spyOn, test } from 'bun:test'
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import * as authStore from './OpenCodeAuthStore.js'
import { resolveOpenCodeAuthCoordinationPath } from './OpenCodeAuthCoordinationLock.js'
import { prepareOpenCodeProfile } from './OpenCodeProfilePreparation.js'
import { buildManagedConfigFingerprint } from './OpenCodeManagedConfigFingerprint.js'
import { canonicalPreparedProfile, decodePreparedProfile, projectPreparedProfile, restorePreparedProfile, retainPreparedProfile, verifyPreparedProfileBinding, PREPARED_PROFILE_MAXIMUM, PRIVATE_PROFILE_AUTH, PRIVATE_PROFILE_DOCUMENT_MAXIMUM } from './OpenCodePreparedProfileContract.js'
import { encodePrivatePreparedProfile } from '../hostedControl/HostedControlPrivateProfileProducer.js'
import { AUTH_V2, BOOTSTRAP_V2, LEASE_V2, STATEMENT_V2, canonicalV2, decodeFramesV2, hashV2, macV2, verifyLeaseV2 } from '../hostedControl/HostedControlBootstrapV2Wire.js'
import { fixtureHeaderV2, assembleFixtureV2, u32 } from '../hostedControl/fixtures/bootstrapV2Producer.js'

const sentinel = 'synthetic-private-profile-sentinel'
async function withPreparation(run: (profile: Awaited<ReturnType<typeof prepareOpenCodeProfile>>) => void | Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'owner-profile-contract-'))
  try {
    const projectPath = path.join(root,'project'), home = path.join(root,'source-home')
    await mkdir(projectPath); await mkdir(home)
    await writeFile(path.join(projectPath,'AGENTS.md'), 'synthetic behavior')
    // These are synthetic files under a fresh tmp root, never real user stores.
    const auth = path.join(root,'source-auth.json')
    await writeFile(auth, JSON.stringify({ synthetic: {type:'api',key:sentinel} }))
    const profile = await prepareOpenCodeProfile({ projectPath, workingDirectory: projectPath,
      paths: {data:path.join(root,'data'),cache:path.join(root,'cache')}, sourceHomePath:home,
      sourceAuthPaths:[path.join(root,'absent.json'),auth], globalAuthPath:path.join(root,'data/opencode/auth.json'),
      platform:'linux', environment: { HOME:home, UNRELATED_SECRET:sentinel,
        OPENCODE_CONFIG_CONTENT:JSON.stringify({ provider:{synthetic:{options:{apiKey:sentinel, temperature:0.25}}} }) },
      appMcpConfig:{type:'remote',url:`https://example.invalid/${sentinel}`,headers:{Authorization:sentinel}},
      options:{toolApprovalMode:'manual',includeManagedSubscriptionPlugins:false},
    })
    expect(resolveOpenCodeAuthCoordinationPath(profile.globalAuthPath!)).toBe(
      resolveOpenCodeAuthCoordinationPath(profile.managedAuthPath))
    await run(profile)
  } finally { await rm(root,{recursive:true,force:true}) }
}
function frames(header: any, authFrame: Buffer, key: Buffer) {
  delete header.leaseEvidence.leaseArtifactSha256
  const lease = Buffer.from(canonicalV2({format:LEASE_V2,launcherLeaseId:header.leaseEvidence.launcherLeaseId,
    bootstrapStatementSha256:hashV2(STATEMENT_V2+'\0'+canonicalV2(header))}))
  header.leaseEvidence.leaseArtifactSha256 = hashV2(lease)
  const bytes = Buffer.from(canonicalV2(header)), signed = Buffer.concat([u32(bytes.length),bytes])
  return { bootstrap:Buffer.concat([signed,key,macV2(key,BOOTSTRAP_V2,signed)]), auth:authFrame, lease }
}
function expected(header: any, profile: any) {
  for (const field of ['projectPath','profileRootKey','profileRootPath','projectBehaviorFingerprint','managedConfigFingerprint','sourceAuthFingerprint','managedAuthFingerprint','sourceAuthSources']) header.expectedHost.profile[field] = profile[field]
}
describe('actual preparation and private publication source contract', () => {
  test('split explicit auth authority rejects before preparation or reconciliation creates files', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'profile-authority-r1089-'))
    const reconcile = spyOn(authStore, 'reconcileOpenCodeManagedAuthStores')
    try {
      const input = { projectPath: path.join(root, 'project'), workingDirectory: root,
        paths: {data:path.join(root,'data'),cache:path.join(root,'cache')}, sourceHomePath:root,
        sourceAuthPaths:[], globalAuthPath:path.join(root,'unrelated/auth.json'),
        platform:'linux' as const, environment:{}, appMcpConfig:null,
        // Access to preparation options proves validation has already finished.
        get options(): never { throw new Error('preparation entered before authority validation') },
      }
      await expect(prepareOpenCodeProfile(input)).rejects.toThrow('opencode_preparation_auth_authority')
      expect(reconcile).not.toHaveBeenCalled()
      expect(await readdir(root)).toEqual([])
    } finally { reconcile.mockRestore(); await rm(root,{recursive:true,force:true}) }
  })
  test('private decoder and restoration require a literal string auth state', () => withPreparation(profile => {
    const projection = projectPreparedProfile(profile)
    for (const authState of [['stale'], ['ok'], {}, null, 0, 1]) {
      const invalid = {...projection, authState}
      expect(()=>decodePreparedProfile(Buffer.from(canonicalPreparedProfile(invalid)))).toThrow('opencode_private_profile_rejected')
      expect(()=>restorePreparedProfile(invalid as unknown as typeof projection)).toThrow('opencode_private_profile_rejected')
    }
    for (const authState of ['missing', 'ok', 'stale'] as const) {
      const valid = {...projection, authState}
      expect(decodePreparedProfile(Buffer.from(canonicalPreparedProfile(valid))).authState).toBe(authState)
      expect(restorePreparedProfile(valid).authState).toBe(authState)
    }
  }))
  test('real preparation -> reusable producer -> FD4/FD7 decoder, authenticates actual bytes and keeps public binding small', () => withPreparation(profile => {
    const projection = projectPreparedProfile(profile)
    expect(projection.managedConfigJson).toBe(profile.env.OPENCODE_CONFIG_CONTENT!)
    expect(projection.runtimePathEnvironment).not.toHaveProperty('UNRELATED_SECRET')
    expect(projection.managedAuthFingerprint).not.toBeNull()
    expect(projection.behaviorSources).toEqual(['AGENTS.md'])
    const publication = retainPreparedProfile(profile), key = Buffer.alloc(32,42), header = fixtureHeaderV2()
    expected(header,profile)
    const produced = encodePrivatePreparedProfile({publication, proofKey:key, expectedHost:header.expectedHost, descriptorMap:header.descriptorMap,
      ownerProcessStartToken:header.supervisorBinding.ownerProcessStartToken, bootstrapDigest:header.bootstrapBinding.bootstrapDigest,
      credentials:{id:header.expectedHost.serverAuthId,username:'synthetic-user',password:sentinel}})
    Object.assign(header,{serverAuthBinding:produced.serverAuthBinding,preparedProfileBinding:produced.preparedProfileBinding})
    expect(canonicalV2(header)).not.toContain(sentinel)
    expect(canonicalV2(produced.preparedProfileBinding)).not.toContain(sentinel)
    expect(produced.frame.toString()).toContain(sentinel)
    const f = frames(header, produced.frame,key)
    expect(()=>decodeFramesV2(Buffer.from(f.bootstrap),Buffer.from(f.auth))).toThrow()
    const decoded = decodeFramesV2(f.bootstrap,f.auth,PRIVATE_PROFILE_AUTH)
    verifyLeaseV2(f.lease,decoded.header)
    expect(decoded.preparedProfile).toEqual(projection)
    expect(f.auth.every(b=>b===0) && f.bootstrap.every(b=>b===0)).toBe(true)
    expect(decoded.bootstrapV2HeaderSha256).not.toBe(header.bootstrapBinding.bootstrapDigest)
    decoded.secret.fill(0); publication.close(); key.fill(0)
  }))
  test('full-byte commitment rejects normalized remote URL/environment collisions and every generation has a different binding', () => withPreparation(profile => {
    const publication = retainPreparedProfile(profile), key=Buffer.alloc(32,42)
    const context={expectedHostSha256:'1'.repeat(64),ownerProcessStartToken:'2'.repeat(64),bootstrapDigest:'3'.repeat(64)}
    const transfer=publication.transfer(key,context), original=Buffer.from(canonicalPreparedProfile(transfer.preparedProfile))
    const config=JSON.parse(transfer.preparedProfile.managedConfigJson)
    config.mcp['agent-teams'].url='https://substituted.invalid'; config.mcp['agent-teams'].environment={nested:{secret:sentinel}}
    expect(buildManagedConfigFingerprint(config)).toBe(profile.managedConfigFingerprint)
    const tampered=Buffer.from(canonicalPreparedProfile({...transfer.preparedProfile,managedConfigJson:JSON.stringify(config)}))
    expect(()=>verifyPreparedProfileBinding(tampered,transfer.binding,key,context)).toThrow('opencode_private_profile_rejected')
    const bindings=new Set<string>()
    for (let generation=1;generation<=4;generation++) {
      const next={...context,expectedHostSha256:String(generation).repeat(64),ownerProcessStartToken:String(generation+4).repeat(64)}
      bindings.add(publication.transfer(key,next).binding.hmacSha256)
      expect(()=>verifyPreparedProfileBinding(original,transfer.binding,key,next)).toThrow()
    }
    expect(bindings.size).toBe(4)
    publication.close(); publication.close()
    expect(()=>publication.transfer(key,context)).toThrow('opencode_private_profile_rejected')
    original.fill(0);tampered.fill(0);key.fill(0)
  }))
  test('exact canonical keys, Unicode, paths, depth, finite JSON and aggregate bounds fail closed', () => withPreparation(profile => {
    const p=projectPreparedProfile(profile), encoded=canonicalPreparedProfile(p)
    for (const text of [encoded+'\n', '\ufeff'+encoded, encoded.replace('"authState":','"authState":"ok","authState":'), encoded.replace('"authState":"ok"','"authState":"\\ud800"')]) expect(()=>decodePreparedProfile(Buffer.from(text))).toThrow()
    for (const patch of [{extra:sentinel},{format:'unknown'},{homePath:'/bad/../path'},{sourceAuthSources:[]},{runtimePathEnvironment:{...p.runtimePathEnvironment,SECRET:sentinel}},{managedConfigJson:'{"secret":"'+sentinel+'",'}])
      expect(()=>decodePreparedProfile(Buffer.from(canonicalPreparedProfile({...p,...patch})))).toThrow('opencode_private_profile_rejected')
    for (const bad of [NaN,Infinity,-0,'\ud800']) expect(()=>canonicalPreparedProfile(bad)).toThrow()
    let deep:unknown=null; for(let i=0;i<66;i++) deep=[deep]
    expect(()=>canonicalPreparedProfile(deep)).toThrow()
    expect(()=>decodePreparedProfile(Buffer.alloc(PREPARED_PROFILE_MAXIMUM+1,32))).toThrow()
    expect(PRIVATE_PROFILE_DOCUMENT_MAXIMUM).toBe(1024*1024)
  }))
  test('projection accepts exactly 768 KiB, rejects one extra byte, and producer failure after close is generic', () => withPreparation(profile => {
    const p=projectPreparedProfile(profile), config=JSON.parse(p.managedConfigJson)
    config.environment={padding:''}
    const base={...p,managedConfigJson:JSON.stringify(config)}
    const overhead=Buffer.byteLength(canonicalPreparedProfile(base))
    config.environment.padding='x'.repeat(PREPARED_PROFILE_MAXIMUM-overhead)
    const exact=Buffer.from(canonicalPreparedProfile({...p,managedConfigJson:JSON.stringify(config)}))
    expect(exact.length).toBe(PREPARED_PROFILE_MAXIMUM)
    expect(decodePreparedProfile(exact).managedConfigFingerprint).toBe(p.managedConfigFingerprint)
    config.environment.padding+='x'
    expect(()=>decodePreparedProfile(Buffer.from(canonicalPreparedProfile({...p,managedConfigJson:JSON.stringify(config)})))).toThrow()
    const publication=retainPreparedProfile(profile),header=fixtureHeaderV2(),key=Buffer.alloc(32,42)
    publication.close(); expected(header,profile)
    expect(()=>encodePrivatePreparedProfile({publication,proofKey:key,expectedHost:header.expectedHost,descriptorMap:header.descriptorMap,
      ownerProcessStartToken:header.supervisorBinding.ownerProcessStartToken,bootstrapDigest:header.bootstrapBinding.bootstrapDigest,
      credentials:{id:header.expectedHost.serverAuthId,username:'user',password:sentinel}})).toThrow('opencode_private_profile_rejected')
    exact.fill(0);key.fill(0)
  }))
  test('even a reauthenticated private document cannot substitute full profile bytes under the retained public binding', () => withPreparation(profile => {
    const publication=retainPreparedProfile(profile),header=fixtureHeaderV2(),key=Buffer.alloc(32,42)
    expected(header,profile)
    const produced=encodePrivatePreparedProfile({publication,proofKey:key,expectedHost:header.expectedHost,descriptorMap:header.descriptorMap,
      ownerProcessStartToken:header.supervisorBinding.ownerProcessStartToken,bootstrapDigest:header.bootstrapBinding.bootstrapDigest,
      credentials:{id:header.expectedHost.serverAuthId,username:'user',password:sentinel}})
    const doc=JSON.parse(produced.frame.subarray(4).toString()),config=JSON.parse(doc.preparedProfile.managedConfigJson)
    config.mcp['agent-teams'].url='https://substitution.invalid'
    doc.preparedProfile.managedConfigJson=JSON.stringify(config)
    doc.preparedProfileSha256=hashV2(canonicalPreparedProfile(doc.preparedProfile))
    const text=Buffer.from(canonicalPreparedProfile(doc)),auth=Buffer.concat([u32(text.length),text])
    Object.assign(header,{preparedProfileBinding:produced.preparedProfileBinding,
      serverAuthBinding:{...produced.serverAuthBinding,authHmacSha256:macV2(key,PRIVATE_PROFILE_AUTH,auth).toString('hex')}})
    const f=frames(header,auth,key)
    expect(()=>decodeFramesV2(f.bootstrap,f.auth,PRIVATE_PROFILE_AUTH)).toThrow('hosted_owner_v2_frame_rejected')
    expect(f.auth.every(b=>b===0) && f.bootstrap.every(b=>b===0)).toBe(true)
    produced.frame.fill(0);text.fill(0);key.fill(0);publication.close()
  }))
  test('retention rejects inconsistent producer results and isolates later mutation of producer-owned fields', () => withPreparation(profile => {
    const originalJson = profile.env.OPENCODE_CONFIG_CONTENT!
    const changed = JSON.parse(originalJson)
    changed.mcp['agent-teams'].url = 'https://changed-after-preparation.invalid'
    // This deliberately collides under the existing normalized fingerprint.
    expect(buildManagedConfigFingerprint(changed)).toBe(profile.managedConfigFingerprint)
    expect(()=>retainPreparedProfile({...profile, managedConfig:changed})).toThrow('opencode_private_profile_rejected')
    expect(()=>retainPreparedProfile({...profile, env:{...profile.env, OPENCODE_CONFIG_CONTENT:JSON.stringify(changed)}})).toThrow('opencode_private_profile_rejected')

    const publication = retainPreparedProfile(profile), key = Buffer.alloc(32,42)
    const context = {expectedHostSha256:'1'.repeat(64),ownerProcessStartToken:'2'.repeat(64),bootstrapDigest:'3'.repeat(64)}
    try {
      const before = publication.transfer(key,context)
      profile.managedConfig = changed
      profile.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(changed)
      profile.env.HOME = '/substituted-home'
      profile.behaviorSources.push('new-behavior.md')
      profile.sourceAuthSources!.reverse()
      const after = publication.transfer(key,context)
      expect(after).toEqual(before)
      expect(after.preparedProfile.managedConfigJson).toBe(originalJson)
      expect(after.preparedProfile.behaviorSources).toEqual(['AGENTS.md'])
      expect(Object.isFrozen(after.preparedProfile)).toBe(true)
      expect(Object.isFrozen(after.preparedProfile.sourceAuthSources[0])).toBe(true)
    } finally { publication.close(); key.fill(0) }
  }))
  test('restoration revalidates its exported input and never exposes private JSON errors', () => withPreparation(profile => {
    const projection = projectPreparedProfile(profile)
    const restored = restorePreparedProfile(projection)
    expect(restored.managedConfig).toEqual(profile.managedConfig)
    expect(restored.env.OPENCODE_CONFIG_CONTENT).toBe(profile.env.OPENCODE_CONFIG_CONTENT!)
    expect(restored.env).not.toHaveProperty('UNRELATED_SECRET')
    for (const patch of [{managedConfigJson: '{"secret":"'+sentinel+'",'}, {extra:sentinel}]) {
      try {
        restorePreparedProfile({...projection,...patch})
        throw new Error('expected rejection')
      } catch (error) {
        expect((error as Error).message).toBe('opencode_private_profile_rejected')
        expect((error as Error).cause).toBeUndefined()
        expect(String(error)).not.toContain(sentinel)
      }
    }
    expect(()=>canonicalPreparedProfile(new Array(1))).toThrow('opencode_private_profile_rejected')
    expect(()=>canonicalPreparedProfile([undefined])).toThrow('opencode_private_profile_rejected')
  }))
  test('v1 bounds and explicit selection are separate; no downgrade and rejected frames wipe', () => {
    for (const mode of [PRIVATE_PROFILE_AUTH] as const) {
      const f=assembleFixtureV2()
      expect(()=>decodeFramesV2(f.bootstrapFrame,f.authFrame,mode)).toThrow()
      expect(f.authFrame.every(b=>b===0)).toBe(true)
    }
    const f=assembleFixtureV2()
    expect(()=>decodeFramesV2(f.bootstrapFrame,Buffer.alloc(8197),AUTH_V2)).toThrow()
  })
})
