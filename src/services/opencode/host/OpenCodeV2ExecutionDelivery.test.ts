import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { resolveOpenCodeV2ExecutionDelivery } from './OpenCodeV2ExecutionDelivery.js'

const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const workspace = path.resolve(import.meta.dir, '../../../..')

// A hardcoded TS child path or source-only fence makes the actual JS bundle fail.
test('actual Bun JS bundle resolves and hashes both adjacent children without a source tree', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-v2-js-delivery-')))
  try {
    const entry = path.join(root, 'harness.ts'), bundle = path.join(root, 'cli.js')
    await writeFile(entry, `import { resolveOpenCodeV2ExecutionDelivery as resolve } from ${JSON.stringify(path.join(import.meta.dir, 'OpenCodeV2ExecutionDelivery.ts'))};\nconsole.log(JSON.stringify(await Promise.all(['execution', 'run-owner'].map(child => resolve(import.meta.url, child)))));\n`)
    const result = await Bun.build({ entrypoints: [entry], target: 'bun', format: 'esm', minify: true })
    expect(result.success).toBe(true)
    await writeFile(bundle, await result.outputs[0]!.text())
    await rm(entry)
    for (const name of ['opencodeV2ExecutionServer', 'opencodeV2RunOwner']) await writeFile(path.join(root, `${name}.js`), `export const name = '${name}'`)
    const child = Bun.spawn([process.execPath, bundle], { stdout: 'pipe', stderr: 'pipe' })
    const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    expect(error).toBe(''); expect(code).toBe(0)
    const rows = JSON.parse(output) as Awaited<ReturnType<typeof resolveOpenCodeV2ExecutionDelivery>>[]
    expect(rows.map(row => row.runtimeMode)).toEqual(['packaged', 'packaged'])
    expect(rows.map(row => row.root)).toEqual([root, root])
    for (const [index, name] of ['opencodeV2ExecutionServer', 'opencodeV2RunOwner'].entries()) {
      expect(rows[index]!.entryPath).toBe(path.join(root, `${name}.js`))
      expect(rows[index]!.entrySha256).toBe(sha(await readFile(rows[index]!.entryPath)))
    }
    await rm(path.join(root, 'opencodeV2ExecutionServer.js'))
    await mkdir(path.join(root, 'src/entrypoints'), { recursive: true })
    await writeFile(path.join(root, 'src/entrypoints/opencodeV2ExecutionServer.ts'), 'export {}')
    const missing = Bun.spawn([process.execPath, bundle], { stdout: 'pipe', stderr: 'pipe' })
    expect(await missing.exited).not.toBe(0)
    expect(await new Response(missing.stderr).text()).toContain('ENOENT')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('source delivery keeps genuine TypeScript child paths and byte identities', async () => {
  for (const location of [import.meta.url, new URL('./darwin/OpenCodeV2DarwinExecution.ts', import.meta.url).href]) {
  for (const [child, name] of [['execution', 'opencodeV2ExecutionServer'], ['run-owner', 'opencodeV2RunOwner']] as const) {
    const delivery = await resolveOpenCodeV2ExecutionDelivery(location, child)
    expect(delivery.runtimeMode).toBe('source')
    expect(delivery.root).toBe(workspace)
    expect(delivery.entryPath).toBe(path.join(workspace, `src/entrypoints/${name}.ts`))
    expect(delivery.entrySha256).toBe(sha(await readFile(delivery.entryPath)))
  }
  }
})

// Embedded Bun executables cannot be used as a separate JS child interpreter.
test('actual compiled Bun executable refuses embedded delivery before resolving disk children', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-v2-compiled-delivery-')))
  try {
    const entry = path.join(root, 'compiled.ts'), binary = path.join(root, 'compiled')
    await writeFile(entry, `import { resolveOpenCodeV2ExecutionDelivery as resolve } from ${JSON.stringify(path.join(import.meta.dir, 'OpenCodeV2ExecutionDelivery.ts'))};\nawait resolve(import.meta.url, 'execution');\n`)
    const build = Bun.spawn([process.execPath, 'build', entry, '--compile', '--outfile', binary], { stdout: 'ignore', stderr: 'pipe' })
    expect(await build.exited).toBe(0)
    const child = Bun.spawn([binary], { stdout: 'pipe', stderr: 'pipe' })
    expect(await child.exited).not.toBe(0)
    expect(await new Response(child.stderr).text()).toContain('v2_compiled_runtime_unsupported')
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30_000)

// Bun caches named/namespace builtin exports even after syncBuiltinESMExports.
// Native Windows installs its permission-error fallback after these imports.
test('early delivery/profile consumers observe the subsequently installed realpath facade', async () => {
  const script = `
    const {resolveOpenCodeV2ExecutionDelivery}=await import(${JSON.stringify(new URL('./OpenCodeV2ExecutionDelivery.ts', import.meta.url).href)});
    const {canonicalExecutionDirectory}=await import(${JSON.stringify(new URL('./OpenCodeV2ExecutionBinding.ts', import.meta.url).href)});
    const fs=require('node:fs/promises'), original=fs.realpath;
    let observed=0;
    fs.realpath=(...args)=>{observed++;return original(...args)};
    require('node:module').syncBuiltinESMExports();
    try {
      const delivery=await resolveOpenCodeV2ExecutionDelivery(${JSON.stringify(new URL('./OpenCodeV2ExecutionDelivery.ts', import.meta.url).href)},'execution');
      await canonicalExecutionDirectory(delivery.root);
      if(observed!==3)throw Error('TEST realpath facade bypassed');
    } finally { fs.realpath=original;require('node:module').syncBuiltinESMExports(); }
  `
  const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
  const [code, output] = await Promise.all([child.exited, new Response(child.stderr).text()])
  expect({ code, output }).toEqual({ code: 0, output: '' })
})
