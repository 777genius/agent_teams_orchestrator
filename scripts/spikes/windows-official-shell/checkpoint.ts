import path from 'node:path'
import { readFile, writeFile } from 'node:fs/promises'
import { Context, Effect, Layer } from 'effect'
import { commandLayer, type CommandReceipt } from './spawner.ts'
import { attemptWindowsAclEscape } from '../opencode-v2-windows-native.ts'

// Resolve every internal module from its selected server, preserving floor's
// physical dependency graph and the single pinned Effect identity.
async function graph(alias: string) {
  const entry = Bun.resolveSync(`${alias}/routes`, import.meta.dir)
  const load = (specifier: string) => import(Bun.resolveSync(specifier, path.dirname(entry)))
  return {
    routes: await import(entry) as typeof import('@opencode/server/routes'),
    cross: await load('@opencode/util/cross-spawn-spawner') as typeof import('@opencode/util/cross-spawn-spawner'),
    locations: await load('@opencode/core/location-service-map') as typeof import('@opencode/core/location-service-map'),
    location: await load('@opencode/core/location') as typeof import('@opencode/core/location'),
    shell: await load('@opencode/core/shell') as typeof import('@opencode/core/shell'),
    schema: await load('@opencode/schema/schema') as typeof import('@opencode/schema/schema'),
    http: await load('@effect/platform-node/NodeHttpServer') as typeof import('@effect/platform-node/NodeHttpServer'),
    entry,
  }
}
export async function runOfficialShellCheckpoint(base: string, resolveGraph: typeof graph = graph) {
  const pins: Record<string, unknown>[] = []
  for (const [pin, alias] of [['2.0.0', '@opencode/server-v2-floor'], ['2.0.21', '@opencode/server']] as const) {
    const receipts: CommandReceipt[] = [], record: Record<string, unknown> = { pin, receipts }
    pins.push(record)
    try {
      const official = await resolveGraph(alias)
      const work = path.join(base, 'work'), shell = path.join(process.env.SystemRoot!, 'System32', 'cmd.exe')
      const edited = path.join(work, `official-${pin}-edited.txt`), marker = path.join(work, `official-${pin}-descendant.json`)
      const commandFile = path.join(work, `official-${pin}-command.js`), cancelFile = path.join(work, `official-${pin}-cancel.js`)
      await writeFile(commandFile, `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(edited)},'official-edited');if(fs.readFileSync(${JSON.stringify(edited)},'utf8')!=='official-edited')process.exit(3);console.log('OFFICIAL_TEST_PASS');console.error('OFFICIAL_STDERR_PASS')`)
      await writeFile(cancelFile, `const fs=require('node:fs');const child=Bun.spawn([process.execPath,'-e','setInterval(()=>{},1000)'],{stdio:['inherit','inherit','inherit'],env:{...process.env}});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify({parentPID:process.pid,descendantPID:child.pid}));setInterval(()=>{},1000)`)
      const routes = official.routes.createRoutes({ database: { path: path.join(work, `official-${pin}.db`) }, config: { directory: path.join(work, `config-${pin}`), project: false }, models: { fetch: false, snapshot: false }, fs: { filewatcher: false, fff: false }, events: { persist: false } }, () => [], [official.cross.node.replace(commandLayer(path.join(work, `stdio-${pin}`), receipts))])
      await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const services = yield* Layer.build(routes.pipe(Layer.provideMerge(official.http.layerHttpServices)))
        const locations = Context.get(services, official.locations.Service)
        const context = yield* locations.contextEffect(official.location.Ref.make({ directory: official.schema.AbsolutePath.make(work) }))
        const service = Context.get(context, official.shell.Service)
        let beforeCalled = false
        const first = yield* service.create({ command: `"${process.execPath}" "${commandFile}"`, cwd: work, shell }, () => Effect.sync(() => { beforeCalled = true }))
        const result = yield* service.result(first)
        record.command = { status: result.info.status, exit: result.info.exit, output: result.capture?.output, beforeCalled, pid: result.info.pid }
        const cancelled = yield* service.create({ command: `"${process.execPath}" "${cancelFile}"`, cwd: work, shell })
        let descendant: { parentPID: number; descendantPID: number } | undefined
        const deadline = Date.now() + 10000
        while (!descendant && Date.now() < deadline) {
          descendant = yield* Effect.promise(() => readFile(marker, 'utf8').then(text => JSON.parse(text) as typeof descendant).catch(() => undefined))
          if (!descendant) yield* Effect.sleep(20)
        }
        if (!descendant) return yield* Effect.die(new Error('official descendant did not start'))
        record.descendant = descendant
        yield* service.timeout(cancelled.id, 1)
        const final = yield* service.wait(cancelled.id)
        record.cancel = { status: final.status, pid: final.pid }
        const closeDeadline = Date.now() + 5000
        while (receipts.some(receipt => !receipt.closed) && Date.now() < closeDeadline) yield* Effect.sleep(20)
      })).pipe(Effect.timeout('45 seconds')))
      record.editedFile = await readFile(edited, 'utf8') === 'official-edited'
      record.officialInputAclDenied = attemptWindowsAclEscape(official.entry) === 5
      try { await writeFile(official.entry, 'escape'); record.officialInputWriteDenied = false } catch (error) { record.officialInputWriteDenied = ['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '') }
      const command = record.command as { status: string; exit: number; output: string; beforeCalled: boolean }, cancel = record.cancel as { status: string }
      record.passed = command.status === 'exited' && command.exit === 0 && command.output.includes('OFFICIAL_TEST_PASS') && command.output.includes('OFFICIAL_STDERR_PASS') && command.beforeCalled && record.editedFile && cancel.status === 'timeout' && receipts.length === 2 && receipts.every(receipt => receipt.assignedBeforeResume && receipt.exactOuterJob && receipt.closed && receipt.activeAfterClose === 0 && receipt.heldExited) && Number(receipts[1]?.activeBeforeCancel) >= 3 && record.officialInputAclDenied && record.officialInputWriteDenied
    } catch (error) { record.error = String(error); record.passed = false }
  }
  return { purpose: 'TEST-official-Shell-spawner-seam', permissionToolQualified: false, passed: pins.every(pin => pin.passed === true), pins }
}
