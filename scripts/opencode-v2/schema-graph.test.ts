import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'

const workspace = path.resolve(import.meta.dir, '../..')
const graphRoot = path.join(workspace, 'dist/local-cli')

// Requires the normal production build. A parent-only schema creates its AST
// with a second physical Effect instance and breaks even empty model decoding.
test('actual bundled model mapper uses staged schema and the same physical Effect graph', async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-v2-schema-graph-')))
  try {
    const entry = path.join(root, 'harness.ts')
    await writeFile(entry, `import { mapSelectedOpenCodeV2Model } from ${JSON.stringify(path.join(workspace, 'src/services/opencode/profile/OpenCodeV2ExecutionConfig.ts'))};\nconsole.log(JSON.stringify(Object.keys(mapSelectedOpenCodeV2Model('TEST-model', {}))));\n`)
    const build = await Bun.build({ entrypoints: [entry], target: 'bun', format: 'esm', minify: true,
      external: ['@opencode/*', 'effect', 'effect/*'] })
    expect(build.success).toBe(true)
    const bundled = await build.outputs[0]!.text()
    const split = path.join(root, 'split'), unified = path.join(root, 'unified')
    await mkdir(path.join(split, 'node_modules/@opencode'), { recursive: true })
    await mkdir(unified)
    await writeFile(path.join(split, 'cli.js'), bundled)
    await writeFile(path.join(unified, 'cli.js'), bundled)
    // Reproduce the original deployed layout without editing either installed graph.
    await symlink(await realpath(path.join(graphRoot, 'node_modules/effect')), path.join(split, 'node_modules/effect'))
    await symlink(await realpath(path.join(workspace, 'node_modules/@opencode/schema')), path.join(split, 'node_modules/@opencode/schema'))
    const broken = Bun.spawn([process.execPath, path.join(split, 'cli.js')], { stdout: 'pipe', stderr: 'pipe' })
    expect(await broken.exited).not.toBe(0)
    expect(await new Response(broken.stderr).text()).toContain('Sync adapter can only throw schema errors')

    const schema = await realpath(Bun.resolveSync('@opencode/schema/config/provider', graphRoot))
    const model = await realpath(Bun.resolveSync('@opencode/schema/model', graphRoot))
    expect(schema.startsWith(graphRoot + path.sep)).toBe(true)
    expect(model.startsWith(graphRoot + path.sep)).toBe(true)
    const metadata = JSON.parse(await readFile(path.join(graphRoot, 'node_modules/@opencode/schema/package.json'), 'utf8'))
    expect(metadata).toMatchObject({ name: '@opencode/schema', version: '2.0.21' })
    const effect = await realpath(Bun.resolveSync('effect', graphRoot))
    expect(await realpath(Bun.resolveSync('effect', path.dirname(schema)))).toBe(effect)
    expect(await realpath(Bun.resolveSync('effect', path.dirname(model)))).toBe(effect)
    await symlink(path.join(graphRoot, 'node_modules'), path.join(unified, 'node_modules'))
    const working = Bun.spawn([process.execPath, path.join(unified, 'cli.js')], { stdout: 'pipe', stderr: 'pipe' })
    const [output, error, code] = await Promise.all([new Response(working.stdout).text(), new Response(working.stderr).text(), working.exited])
    expect(error).toBe(''); expect(code).toBe(0)
    expect(JSON.parse(output)).toEqual(['TEST-model'])
  } finally { await rm(root, { recursive: true, force: true }) }
})
