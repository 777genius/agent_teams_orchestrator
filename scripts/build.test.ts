import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, openSync, realpathSync } from 'node:fs'
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const repoRoot = resolve(import.meta.dir, '..')
const buildScript = resolve(repoRoot, 'scripts/build.ts')

function readBuildPlan(args: string[] = [], options: {
  cwd?: string
  environment?: NodeJS.ProcessEnv
} = {}): {
  compile: boolean
  dev: boolean
  features: string[]
  bundleEntrypoints: string[]
  hostedActualOwnerArtifact: string | null
  hostedActualOwnerWrapper: string | null
  hostedActualOwnerOrchestratorRef: string | null
  hostedActualOwnerSourceAuthority: string | null
  repositoryRoot: string
} {
  const result = spawnSync(
    process.execPath,
    ['run', buildScript, ...args, '--print-build-plan'],
    {
      cwd: options.cwd ?? repoRoot,
      encoding: 'utf8',
      env: options.environment ?? process.env,
    },
  )
  expect(result.status).toBe(0)
  return JSON.parse(result.stdout.trim())
}

describe('release build feature plan', () => {
  test('includes HOSTED_CONTROL and the exact packaged owner outputs by default', () => {
    const plan = readBuildPlan()

    expect(plan.dev).toBe(false)
    expect(plan.features).toContain('HOSTED_CONTROL')
    expect(plan.features).not.toContain('UDS_INBOX')
    expect(plan.bundleEntrypoints).toEqual(['./src/entrypoints/cli.tsx'])
    expect(plan.hostedActualOwnerArtifact)
      .toBe('./dist/local-cli/hostedActualOwnerLauncher-<sha256>')
    expect(plan.hostedActualOwnerWrapper).toBe('./bin/hosted-actual-owner-acceptance')
    expect(plan.hostedActualOwnerOrchestratorRef).toBeNull()
    expect(plan.hostedActualOwnerSourceAuthority)
      .toBe('clean-git-plus-exact-source-closure')
    expect(plan.repositoryRoot).toBe(realpathSync(repoRoot))
  })

  test('does not add the hosted actual-owner entry to single-binary compile builds', () => {
    const plan = readBuildPlan(['--compile'])
    expect(plan.bundleEntrypoints).toEqual(['./src/entrypoints/cli.tsx'])
    expect(plan.hostedActualOwnerArtifact).toBeNull()
    expect(plan.hostedActualOwnerWrapper).toBeNull()
    expect(plan.hostedActualOwnerOrchestratorRef).toBeNull()
    expect(plan.hostedActualOwnerSourceAuthority).toBeNull()
  })

  test('anchors planning outside ambient cwd, PATH, Git, and ref variables', () => {
    const plan = readBuildPlan([], {
      cwd: tmpdir(),
      environment: {
        ...process.env,
        PATH: '/nonexistent',
        HOSTED_ACTUAL_OWNER_SOURCE_REF: 'f'.repeat(40),
      },
    })
    expect(plan.repositoryRoot).toBe(realpathSync(repoRoot))
    expect(plan.hostedActualOwnerOrchestratorRef).toBeNull()
    expect(plan.hostedActualOwnerSourceAuthority)
      .toBe('clean-git-plus-exact-source-closure')
  })

  test('uses the same admitted wrapper name for development bundles', () => {
    const plan = readBuildPlan(['--dev', '--feature-set=dev-full'])

    expect(plan.features).toContain('HOSTED_CONTROL')
    expect(plan.features).not.toContain('UDS_INBOX')
    expect(plan.hostedActualOwnerArtifact)
      .toBe('./dist/local-cli-dev/hostedActualOwnerLauncher-<sha256>')
    expect(plan.hostedActualOwnerWrapper).toBe('./bin/hosted-actual-owner-acceptance')
  })

  test('keeps ordinary development builds portable and platform-honest', () => {
    const plan = readBuildPlan(['--dev'])

    if (process.platform === 'linux' && process.arch === 'x64') {
      expect(plan.hostedActualOwnerArtifact)
        .toBe('./dist/local-cli-dev/hostedActualOwnerLauncher-<sha256>')
      expect(plan.hostedActualOwnerWrapper).toBe('./bin/hosted-actual-owner-acceptance')
    } else {
      expect(plan.hostedActualOwnerArtifact).toBeNull()
      expect(plan.hostedActualOwnerWrapper).toBeNull()
      const hosted = spawnSync(process.execPath, [
        'run', buildScript, '--dev', '--feature=HOSTED_CONTROL', '--print-build-plan',
      ], { cwd: repoRoot, encoding: 'utf8' })
      expect(hosted.status).not.toBe(0)
      expect(hosted.stderr).toContain(
        'Hosted actual-owner production build requires Linux x64 glibc',
      )
    }
  })

  test('uses a fresh absolute metafile for each committed-root owner build', async () => {
    const source = await readFile(buildScript, 'utf8')
    expect(source).toContain(
      "resolve(stagingOutdir, 'hostedActualOwnerAcceptance.meta.json')",
    )
    expect(source.match(/runBuildWithFreshMetafile\(/g)).toHaveLength(3)
    expect(source).toContain(
      "readStableBytes(metafilePath, 'build metafile').bytes.toString('utf8')",
    )
    expect(source.match(/`--metafile=\$\{hostedActualOwnerMetafile\}`/g)).toHaveLength(1)
    expect(source).toContain('        `--metafile=${hostedActualOwnerMetafile}`,')
    expect(source).not.toMatch(/['"`]--metafile['"`]\s*,/)
  })

  test('publishes a portable CLI bundle without deleting a preinstalled owner pair', async () => {
    const root = await mkdtemp(join(tmpdir(), 'portable-cli-publication-'))
    fixtureRoots.push(root)
    await mkdir(join(root, 'scripts'), { recursive: true })
    await cp(buildScript, join(root, 'scripts', 'build.ts'))
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'portable-cli-publication-fixture', version: '1.0.0',
    }))
    const staging = join(root, 'staging')
    const finalOut = join(root, 'dist', 'local-cli-dev')
    const finalWrapper = join(root, 'bin', 'hosted-actual-owner-acceptance')
    const wrapperBytes = Buffer.from('\x7fELF:preinstalled-wrapper')
    const ownerBytes = Buffer.from(`\x7fELF:preinstalled-owner:${sha256(wrapperBytes)}`)
    const ownerName = `hostedActualOwnerLauncher-${sha256(ownerBytes)}`
    await mkdir(staging)
    await mkdir(finalOut, { recursive: true })
    await mkdir(dirname(finalWrapper), { recursive: true })
    await writeFile(join(staging, 'cli.js'), 'portable-cli-bundle\n')
    await writeFile(join(finalOut, ownerName), ownerBytes, { mode: 0o555 })
    await writeFile(finalWrapper, wrapperBytes, { mode: 0o555 })

    const result = spawnSync(process.execPath, [
      'run', join(root, 'scripts', 'build.ts'),
      `--test-publish-generation=${staging}|${finalOut}`,
    ], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, HOSTED_ACTUAL_OWNER_BUILD_TEST_HOOK: '1' },
    })
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
    expect(result.signal).toBeNull()
    expect(await readFile(join(finalOut, 'cli.js'), 'utf8')).toBe('portable-cli-bundle\n')
    expect(await readFile(join(finalOut, ownerName))).toEqual(ownerBytes)
    expect(await readFile(finalWrapper)).toEqual(wrapperBytes)
    expect((await lstat(join(finalOut, ownerName))).mode & 0o777).toBe(0o555)
    expect((await lstat(finalWrapper)).mode & 0o777).toBe(0o555)
  })

  test('uses Bun-supported negative compile autoload flags for the generated wrapper', async () => {
    const source = await readFile(buildScript, 'utf8')
    expect(source).toContain("'--no-compile-autoload-dotenv'")
    expect(source).toContain("'--no-compile-autoload-bunfig'")
    expect(source).not.toContain('--compile-autoload-dotenv=false')
    expect(source).not.toContain('--compile-autoload-bunfig=false')
  })

  test('carries the large owner identity through a deterministic build input, not argv', async () => {
    const [source, ownerSource] = await Promise.all([
      readFile(buildScript, 'utf8'),
      readFile(join(repoRoot, 'src', 'entrypoints', 'hostedActualOwnerAcceptance.ts'), 'utf8'),
    ])
    expect(source).toContain('hostedActualOwnerGeneratedIdentitySource(')
    expect(source).toContain("format: 'deterministic-typescript-module'")
    expect(source).not.toContain(
      '`process.env.HOSTED_ACTUAL_OWNER_BUILD_DESCRIPTOR=${JSON.stringify(descriptorJson)}`',
    )
    expect(source).not.toContain(
      '`process.env.HOSTED_ACTUAL_OWNER_BUILD_CLOSURE_SHA256=${JSON.stringify(buildClosureSha256)}`',
    )
    expect(source).toContain('unlinkIfPresent(hostedActualOwnerLauncherStaging)')
    expect(ownerSource).toContain("from './hostedActualOwnerGeneratedIdentity'")
    expect(ownerSource).not.toContain(
      'process.env.HOSTED_ACTUAL_OWNER_BUILD_DESCRIPTOR',
    )
  })

  test('Bun embeds a generated identity larger than Linux MAX_ARG_STRLEN', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-owner-large-generated-input-'))
    fixtureRoots.push(root)
    const generated = join(root, 'hostedActualOwnerGeneratedIdentity.ts')
    const entrypoint = join(root, 'owner.ts')
    const owner = join(root, 'owner')
    const descriptor = 'd'.repeat(512 * 1024)
    await writeFile(generated,
      `export const HOSTED_ACTUAL_OWNER_BUILD_DESCRIPTOR = ${JSON.stringify(descriptor)}\n`)
    await writeFile(entrypoint, `
import { HOSTED_ACTUAL_OWNER_BUILD_DESCRIPTOR } from './hostedActualOwnerGeneratedIdentity'
if (HOSTED_ACTUAL_OWNER_BUILD_DESCRIPTOR.length !== ${descriptor.length}) process.exit(91)
process.stdout.write(String(HOSTED_ACTUAL_OWNER_BUILD_DESCRIPTOR.length))
`)
    const argv = [
      'build', entrypoint, '--compile', '--target=bun', `--outfile=${owner}`,
      '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig',
    ]
    expect(Math.max(...argv.map(argument => Buffer.byteLength(argument)))).toBeLessThan(4096)
    const build = spawnSync(process.execPath, argv, { cwd: root, encoding: 'utf8' })
    expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0)
    await rm(generated)
    await rm(entrypoint)
    const run = spawnSync(owner, [], { cwd: root, encoding: 'utf8' })
    expect(run.status, run.stderr).toBe(0)
    expect(run.stdout).toBe(String(descriptor.length))
  }, 30_000)

  test('closes an adversarial inherited descriptor before the owner exec boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-owner-fd-boundary-'))
    fixtureRoots.push(root)
    await mkdir(join(root, 'bin'), { recursive: true })
    await mkdir(join(root, 'dist', 'local-cli'), { recursive: true })
    const probeSource = join(root, 'fd-probe.c')
    const probe = join(root, 'fd-probe')
    await writeFile(probeSource, `
#include <fcntl.h>
#include <stdio.h>
int main(void) {
  int inherited = 0;
  for (int fd = 3; fd < 256; fd++) if (fcntl(fd, F_GETFD) >= 0) inherited++;
  printf("inherited=%d\\n", inherited);
  return inherited == 0 ? 0 : 91;
}\n`)
    expect(spawnSync('/usr/bin/cc', [probeSource, '-o', probe], {
      env: { PATH: '/usr/bin:/bin' },
    }).status).toBe(0)
    const probeBytes = await readFile(probe)
    const ownerName = `hostedActualOwnerLauncher-${sha256(probeBytes)}`
    const owner = join(root, 'dist', 'local-cli', ownerName)
    await rename(probe, owner)
    await chmod(owner, 0o555)
    const descriptor = join(root, 'descriptor.json')
    await writeFile(descriptor, '{}\n', { mode: 0o600 })
    const native = spawnSync(process.execPath, [
      'run', buildScript,
      `--print-hosted-actual-owner-native-wrapper=dist/local-cli/${ownerName}`,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        HOSTED_ACTUAL_OWNER_TEST_LAUNCHER_FILE: owner,
        HOSTED_ACTUAL_OWNER_TEST_DESCRIPTOR_FILE: descriptor,
      },
    })
    expect(native.status).toBe(0)
    const nativeSource = join(root, 'wrapper.c')
    const wrapper = join(root, 'bin', 'hosted-actual-owner-acceptance')
    await writeFile(nativeSource, native.stdout)
    expect(spawnSync('/usr/bin/cc', [
      '-static', '-O2', '-std=c11', '-Wall', '-Wextra', '-Werror',
      nativeSource, '-o', wrapper,
    ], { env: { PATH: '/usr/bin:/bin' } }).status).toBe(0)
    await chmod(wrapper, 0o555)
    const secret = join(root, 'inherited-secret')
    await writeFile(secret, 'must-not-reach-owner')
    const secretFd = openSync(secret, 'r')
    try {
      const run = spawnSync(wrapper, ['--runtime-manifest', '/tmp/manifest.json'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe', secretFd],
      })
      expect(run.status).toBe(0)
      expect(run.stdout).toContain('inherited=0')
    } finally {
      closeSync(secretFd)
    }
  }, 30_000)

  test('derives trusted source bytes from the immutable commit, not a raceable worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-owner-provenance-race-'))
    fixtureRoots.push(root)
    await mkdir(join(root, 'scripts'), { recursive: true })
    await cp(buildScript, join(root, 'scripts', 'build.ts'))
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'provenance-race-fixture', version: '1.0.0',
    }))
    const committed = Buffer.from('committed-trust-root\n')
    await writeFile(join(root, 'victim.ts'), committed)
    for (const command of [
      ['init', '-q'], ['config', 'user.email', 'test@example.invalid'],
      ['config', 'user.name', 'test'], ['add', '.'], ['commit', '-qm', 'fixture'],
    ]) {
      expect(spawnSync('/usr/bin/git', command, { cwd: root }).status).toBe(0)
    }
    await writeFile(join(root, 'victim.ts'), 'race-forged-bytes\n')
    const result = spawnSync(process.execPath, [
      'run', join(root, 'scripts', 'build.ts'),
      '--test-print-committed-source-sha256=victim.ts',
    ], { cwd: root, encoding: 'utf8' })
    if (result.status !== 0) throw new Error(result.stderr)
    expect(result.stdout.trim()).toBe(sha256(committed))
    expect(result.stdout.trim()).not.toBe(sha256(Buffer.from('race-forged-bytes\n')))
  })

  test('seals copied writable dependencies without mutating or escaping the installed tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-owner-dependency-snapshot-'))
    fixtureRoots.push(root)
    await mkdir(join(root, 'scripts'), { recursive: true })
    await cp(buildScript, join(root, 'scripts', 'build.ts'))
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'dependency-snapshot-fixture', version: '1.0.0',
    }))
    const dependency = join(
      root, 'node_modules', '@anthropic-ai', 'sdk', '_vendor',
      'partial-json-parser', 'parser.mjs',
    )
    const dependencyBytes = Buffer.from('export const parser = "cached dependency"\n')
    await mkdir(dirname(dependency), { recursive: true })
    await writeFile(dependency, dependencyBytes)
    await chmod(dependency, 0o664)
    const outside = join(root, 'outside-dependency.mjs')
    const outsideBytes = Buffer.from('must remain outside the snapshot\n')
    await writeFile(outside, outsideBytes)
    await chmod(outside, 0o664)
    await symlink(outside, join(root, 'node_modules', 'dependency-escape.mjs'))
    for (const command of [
      ['init', '-q'], ['config', 'user.email', 'test@example.invalid'],
      ['config', 'user.name', 'test'], ['add', 'scripts/build.ts', 'package.json'],
      ['commit', '-qm', 'fixture'],
    ]) {
      expect(spawnSync('/usr/bin/git', command, { cwd: root }).status).toBe(0)
    }

    const result = spawnSync(process.execPath, [
      'run', join(root, 'scripts', 'build.ts'),
      '--test-print-committed-source-identity=' +
        'node_modules/@anthropic-ai/sdk/_vendor/partial-json-parser/parser.mjs',
    ], { cwd: root, encoding: 'utf8' })

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout.trim())).toEqual({
      sha256: sha256(dependencyBytes),
      mode: '600',
    })
    expect(await readFile(dependency)).toEqual(dependencyBytes)
    expect((await lstat(dependency)).mode & 0o777).toBe(0o664)
    expect(await readFile(outside)).toEqual(outsideBytes)
    expect((await lstat(outside)).mode & 0o777).toBe(0o664)
    expect(await readlink(join(root, 'node_modules', 'dependency-escape.mjs'))).toBe(outside)
    expect((await readdir(root)).filter(entry =>
      entry.startsWith('.committed-source-test-'))).toEqual([])
  })

  test('fails closed beneath an intermediate symlink in the dependency snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-owner-dependency-traversal-'))
    fixtureRoots.push(root)
    await mkdir(join(root, 'scripts'), { recursive: true })
    await cp(buildScript, join(root, 'scripts', 'build.ts'))
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'dependency-traversal-fixture', version: '1.0.0',
    }))
    const outside = join(root, 'outside-dependency')
    const outsideFile = join(outside, 'payload.mjs')
    const outsideBytes = Buffer.from('export const escaped = true\n')
    await mkdir(outside)
    await writeFile(outsideFile, outsideBytes)
    await mkdir(join(root, 'node_modules'), { recursive: true })
    await symlink(outside, join(root, 'node_modules', 'linked-dependency'), 'dir')
    for (const command of [
      ['init', '-q'], ['config', 'user.email', 'test@example.invalid'],
      ['config', 'user.name', 'test'], ['add', 'scripts/build.ts', 'package.json'],
      ['commit', '-qm', 'fixture'],
    ]) {
      expect(spawnSync('/usr/bin/git', command, { cwd: root }).status).toBe(0)
    }

    const result = spawnSync(process.execPath, [
      'run', join(root, 'scripts', 'build.ts'),
      '--test-print-committed-source-identity=' +
        'node_modules/linked-dependency/payload.mjs',
    ], { cwd: root, encoding: 'utf8' })

    expect(result.status).not.toBe(0)
    expect(result.stdout).not.toContain(sha256(outsideBytes))
    expect(result.stderr).toContain('escaped its trust root')
    expect(await readFile(outsideFile)).toEqual(outsideBytes)
    expect((await readdir(root)).filter(entry =>
      entry.startsWith('.committed-source-test-'))).toEqual([])
  })

  test('converges identical publishers and truthfully installs a later distinct generation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hosted-owner-publication-winner-'))
    fixtureRoots.push(root)
    await mkdir(join(root, 'scripts'), { recursive: true })
    await cp(buildScript, join(root, 'scripts', 'build.ts'))
    await writeFile(join(root, 'package.json'), JSON.stringify({
      name: 'publication-winner-fixture', version: '1.0.0',
    }))
    const finalOut = join(root, 'dist', 'local-cli')
    const finalWrapper = join(root, 'bin', 'hosted-actual-owner-acceptance')
    await mkdir(join(root, 'bin'), { recursive: true })
    const publications: { staging: string; wrapper: string; expected: string }[] = []
    for (const label of ['alpha', 'beta', 'gamma', 'delta']) {
      const staging = join(root, `staging-${label}`)
      await mkdir(staging, { recursive: true })
      const wrapperBytes = Buffer.from(`\x7fELF:wrapper-${label}`)
      const wrapperDigest = sha256(wrapperBytes)
      const ownerBytes = Buffer.from(`\x7fELF:owner-${label}:${wrapperDigest}`)
      const ownerDigest = sha256(ownerBytes)
      const ownerName = `hostedActualOwnerLauncher-${ownerDigest}`
      await writeFile(join(staging, ownerName), ownerBytes, { mode: 0o555 })
      const wrapper = join(root, `wrapper-${label}`)
      await writeFile(wrapper, wrapperBytes, { mode: 0o555 })
      publications.push({
        staging, wrapper,
        expected: sha256(Buffer.from(JSON.stringify({
          ownerSha256: ownerDigest, wrapperSha256: sha256(wrapperBytes),
        }))),
      })
    }
    const first = publications[0]!
    const firstClone = {
      staging: join(root, 'staging-alpha-clone'),
      wrapper: join(root, 'wrapper-alpha-clone'),
      expected: first.expected,
    }
    await cp(first.staging, firstClone.staging, { recursive: true })
    await cp(first.wrapper, firstClone.wrapper)
    const firstChildren = [first, firstClone].map(publication => Bun.spawn({
      cmd: [process.execPath, 'run', join(root, 'scripts', 'build.ts'),
        `--test-publish-generation=${publication.staging}|${finalOut}|${publication.wrapper}|${finalWrapper}`],
      cwd: root,
      env: { ...process.env, HOSTED_ACTUAL_OWNER_BUILD_TEST_HOOK: '1' },
      stdout: 'pipe', stderr: 'pipe',
    }))
    const results = await Promise.all(firstChildren.map(async child => ({
      status: await child.exited,
      stdout: (await new Response(child.stdout).text()).trim(),
      stderr: await new Response(child.stderr).text(),
    })))
    if (results.some(result => result.status !== 0)) {
      throw new Error(results.map(result => result.stderr).join('\n'))
    }
    expect(results[0]!.stderr).toBe('')
    expect(results[1]!.stderr).toBe('')
    expect(results[0]!.stdout).toBe(results[1]!.stdout)
    expect(results[0]!.stdout).toBe(first.expected)
    const owners = (await readdir(finalOut)).filter(name =>
      /^hostedActualOwnerLauncher-[0-9a-f]{64}$/.test(name))
    expect(owners).toHaveLength(1)
    const later = publications[1]!
    const laterResult = spawnSync(process.execPath, ['run', join(root, 'scripts', 'build.ts'),
      `--test-publish-generation=${later.staging}|${finalOut}|${later.wrapper}|${finalWrapper}`], {
      cwd: root, encoding: 'utf8',
      env: { ...process.env, HOSTED_ACTUAL_OWNER_BUILD_TEST_HOOK: '1' },
    })
    expect(laterResult.status).toBe(0)
    expect(laterResult.stdout.trim()).toBe(later.expected)
    expect(laterResult.stdout.trim()).not.toBe(first.expected)
    const installed = (await readdir(finalOut)).filter(name =>
      /^hostedActualOwnerLauncher-[0-9a-f]{64}$/.test(name))
    expect(installed).toEqual([
      `hostedActualOwnerLauncher-${sha256(Buffer.from(`\x7fELF:owner-beta:${sha256(
        Buffer.from('\x7fELF:wrapper-beta'),
      )}`))}`,
    ])
    expect((await lstat(join(finalOut, installed[0]!))).mode & 0o222).toBe(0)
    expect((await lstat(finalWrapper)).mode & 0o222).toBe(0)

    const distinctChildren = publications.slice(2).map(publication => Bun.spawn({
      cmd: [process.execPath, 'run', join(root, 'scripts', 'build.ts'),
        `--test-publish-generation=${publication.staging}|${finalOut}|${publication.wrapper}|${finalWrapper}`],
      cwd: root,
      env: { ...process.env, HOSTED_ACTUAL_OWNER_BUILD_TEST_HOOK: '1' },
      stdout: 'pipe', stderr: 'pipe',
    }))
    const distinctResults = await Promise.all(distinctChildren.map(async child => ({
      status: await child.exited,
      stdout: (await new Response(child.stdout).text()).trim(),
      stderr: await new Response(child.stderr).text(),
    })))
    expect(distinctResults.map(result => result.status)).toEqual([0, 0])
    expect(distinctResults.map(result => result.stderr)).toEqual(['', ''])
    expect(distinctResults.map(result => result.stdout).sort()).toEqual(
      publications.slice(2).map(publication => publication.expected).sort(),
    )
    const finalOwners = (await readdir(finalOut)).filter(name =>
      /^hostedActualOwnerLauncher-[0-9a-f]{64}$/.test(name))
    expect(finalOwners).toHaveLength(1)
    const finalOwnerBytes = await readFile(join(finalOut, finalOwners[0]!))
    const finalWrapperBytes = await readFile(finalWrapper)
    const finalGeneration = sha256(JSON.stringify({
      ownerSha256: sha256(finalOwnerBytes),
      wrapperSha256: sha256(finalWrapperBytes),
    }))
    expect(publications.slice(2).map(publication => publication.expected))
      .toContain(finalGeneration)
    expect((await lstat(join(finalOut, finalOwners[0]!))).mode & 0o222).toBe(0)
    expect((await lstat(finalWrapper)).mode & 0o222).toBe(0)
  })

  test('rejects HOSTED_CONTROL and UDS_INBOX together', () => {
    const result = spawnSync(
      process.execPath,
      [
        'run',
        './scripts/build.ts',
        '--dev',
        '--feature=HOSTED_CONTROL',
        '--feature=UDS_INBOX',
        '--print-build-plan',
      ],
      { cwd: repoRoot, encoding: 'utf8' },
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(
      'HOSTED_CONTROL and UDS_INBOX cannot own the same UDS listener',
    )
  })
})

const fixtureRoots: string[] = []
let fixtureRoot = ''
let fixtureWrapper = ''
let fixtureBundle = ''
let fixtureBun = ''
let fixtureBundleBytes = Buffer.alloc(0)
let fixtureOrchestratorRef = ''
let fixtureFaultWrapper = ''
let raceRoot = ''
let raceWrapper = ''
let raceBundle = ''
let raceBun = ''
let raceBundleBytes = Buffer.alloc(0)
let spawnFailureWrapper = ''
let spawnFailureOrchestratorRef = ''
let signalWrapper = ''
let signalOwnerMarker = ''
let signalExitMarker = ''
let ambientAttackMarker = ''

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function portableIdentity(path: string, relativePath: string) {
  const [bytes, stat] = await Promise.all([readFile(path), lstat(path, { bigint: true })])
  return {
    relativePath,
    size: stat.size.toString(),
    mode: (stat.mode & 0o777n).toString(8).padStart(3, '0'),
    sha256: sha256(bytes),
  }
}

async function bunIdentity(path: string) {
  const [bytes, stat] = await Promise.all([readFile(path), lstat(path, { bigint: true })])
  return {
    path,
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
    ctimeNs: stat.ctimeNs.toString(),
    mode: (stat.mode & 0o777n).toString(8).padStart(3, '0'),
    linkCount: stat.nlink.toString(),
    uid: stat.uid.toString(),
    sha256: sha256(bytes),
  }
}

function runFixture(
  args: readonly string[],
  wrapper = fixtureWrapper,
  injectedEnvironment: NodeJS.ProcessEnv = {},
) {
  return spawnSync(wrapper, args, {
    cwd: fixtureRoot,
    encoding: 'utf8',
    env: {
      PATH: join(fixtureRoot, 'ambient-tools'),
      LANG: 'C',
      LC_ALL: 'C',
      HOSTED_ACTUAL_OWNER_ENTRY_MODE: 'bundle',
      HOSTED_ACTUAL_OWNER_LAUNCH_DESCRIPTOR: '{}',
      HOSTED_ACTUAL_OWNER_SOURCE_REF: 'f'.repeat(40),
      ...injectedEnvironment,
    },
  })
}

async function createFixtureDescriptor(
  bunPath: string,
  bundlePath: string,
  launcherPath: string,
  launcherRelativePath: string,
) {
  const sourceInputs = ['bun.lock', 'package.json', 'scripts/build.ts',
    'src/entrypoints/hostedActualOwnerAcceptance.ts'].map((path, index) => ({
    path,
    size: String(index + 1),
    mode: '644',
    sha256: String(index + 1).repeat(64),
  }))
  const canonicalInputs = JSON.stringify(sourceInputs)
  const orchestratorRef = createHash('sha1').update(canonicalInputs).digest('hex')
  const pinnedBun = await bunIdentity(bunPath)
  const nativeToolchain = {
    compiler: pinnedBun,
    programs: [pinnedBun],
    headers: [pinnedBun],
    staticLinkInputs: [pinnedBun],
  }
  const buildInputsCanonical = JSON.stringify({
    sourceInputs, bun: pinnedBun, nativeToolchain,
  })
  const buildInputs = {
    sourceInputs, bun: pinnedBun, nativeToolchain,
    inputsSha256: sha256(buildInputsCanonical),
  }
  const canonicalRecipe = JSON.stringify({
    schemaVersion: 1,
    purpose: 'agent-teams.hosted-actual-owner-acceptance.build-recipe/v1',
    invocation: ['bun', 'run', 'scripts/build.ts'],
    mode: { compile: false, development: false },
    features: [],
    defines: {
      common: [
        'MACRO.BUILD_TIME', 'MACRO.FEEDBACK_CHANNEL', 'MACRO.ISSUES_EXPLAINER',
        'MACRO.NATIVE_PACKAGE_URL', 'MACRO.PACKAGE_URL', 'MACRO.VERSION',
        'MACRO.VERSION_CHANGELOG', 'process.env.CCR_FORCE_BUNDLE',
        'process.env.CLAUDE_CODE_FORCE_FULL_LOGO', 'process.env.CLAUDE_CODE_VERIFY_PLAN',
        'process.env.USER_TYPE',
      ].map(key => [key, JSON.stringify('fixture')]),
      ownerBundle: [
        ['process.env.HOSTED_ACTUAL_OWNER_ENTRY_MODE', JSON.stringify('bundle')],
        ['process.env.HOSTED_ACTUAL_OWNER_SOURCE_REF', JSON.stringify(orchestratorRef)],
      ],
      wrapper: [
        ['process.env.HOSTED_ACTUAL_OWNER_ENTRY_MODE', JSON.stringify('launcher')],
        ['process.env.HOSTED_ACTUAL_OWNER_LAUNCH_SNAPSHOT_FAULT', JSON.stringify('none')],
      ],
    },
    platform: {
      os: 'linux', architecture: process.arch, bunVersion: Bun.version,
      target: 'bun', format: 'esm',
    },
    bundler: {
      minify: true, packages: 'bundle', conditions: ['bun'],
      ownerEntrypoint: 'src/entrypoints/hostedActualOwnerAcceptance.ts',
      ownerExternal: [
        '@ant/*', 'audio-capture-napi', 'image-processor-napi', 'keytar',
        'modifiers-napi', 'url-handler-napi',
      ],
      wrapperCompile: true, wrapperAutoloadDotenv: false,
      wrapperAutoloadBunfig: false, wrapperExecArgv: [],
      launcherBunArgv: ['--no-env-file', '--config=/dev/null', 'run', '-'],
      launcherRelativePath,
      tsconfig: 'tsconfig.json',
      nativeWrapperCompiler: pinnedBun.path,
      nativeWrapperBuildInputsSha256: buildInputs.inputsSha256,
      nativeWrapperCompilerArgs: [
        '-static', '-O2', '-std=c11', '-Wall', '-Wextra', '-Werror', '-fno-ident',
        '-Wl,--build-id=none', '-s',
      ],
      nativeWrapperClosureCapture: {
        headers: ['-MD', '-MF'], staticLinkInputs: '-Wl,-Map=',
      },
      nativeWrapperStatic: true,
      wrapperExternal: [
        './scripts/e2e/hosted-actual-owner/owner.js',
        './scripts/e2e/hosted-actual-owner/owner.ts',
      ],
    },
    environment: [
      ['LANG', 'C'], ['LC_ALL', 'C'], ['PATH', '/usr/bin:/bin'], ['TZ', 'UTC'],
    ],
  })
  const bundle = await portableIdentity(
    bundlePath, 'dist/local-cli/hostedActualOwnerAcceptance.js',
  )
  const launcher = await portableIdentity(launcherPath, launcherRelativePath)
  const launchDescriptor = {
    schemaVersion: 1,
    purpose: 'agent-teams.hosted-actual-owner-acceptance.launch-descriptor/v1',
    inputsSha256: buildInputs.inputsSha256,
    buildRecipe: { canonical: canonicalRecipe, sha256: sha256(canonicalRecipe) },
    sourceAuthority: {
      kind: 'source-descriptor',
      orchestratorRef,
      inputsSha256: sha256(canonicalInputs),
    },
    buildInputs,
    bun: pinnedBun,
    wrapper: {
      relativePath: 'bin/hosted-actual-owner-acceptance',
      role: 'invoked-trust-anchor',
    },
    launcher,
    bundle,
    closure: [
      'bin/hosted-actual-owner-acceptance', launcherRelativePath, bundle.relativePath,
    ].sort(),
    sourceInputs,
  }
  return {
    launchDescriptor,
    closureDescriptor: {
      schemaVersion: 1,
      purpose: 'agent-teams.hosted-actual-owner-acceptance.closure/v1',
      inputsSha256: buildInputs.inputsSha256,
      launchDescriptor,
      artifacts: { launcher, bundle },
      trustAnchor: launchDescriptor.wrapper,
      closure: launchDescriptor.closure,
    },
  }
}

async function nativeWrapperSource(
  launcherRelativePath: string,
  launcherPath: string,
  descriptorPath: string,
): Promise<string> {
  const result = spawnSync(process.execPath, [
    'run', buildScript,
    `--print-hosted-actual-owner-native-wrapper=${launcherRelativePath}`,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOSTED_ACTUAL_OWNER_TEST_LAUNCHER_FILE: launcherPath,
      HOSTED_ACTUAL_OWNER_TEST_DESCRIPTOR_FILE: descriptorPath,
    },
  })
  if (result.status !== 0) {
    throw new Error(`native wrapper source failed:\n${result.stdout}\n${result.stderr}`)
  }
  return result.stdout
}

async function compileFixtureWrapper(
  outfile: string,
  bunPath: string,
  bundlePath: string,
  snapshotFault = 'none',
  launcherBasename = 'hostedActualOwnerLauncher',
) {
  const closureRoot = resolve(dirname(bundlePath), '../..')
  const launcherRelativePath = `dist/local-cli/${launcherBasename}`
  const launcher = resolve(closureRoot, launcherRelativePath)
  const descriptorPath = join(
    closureRoot, 'dist', 'local-cli', 'hostedActualOwnerAcceptance.closure.json',
  )
  const nativeSourcePath = join(closureRoot, `.${launcherBasename}.c`)
  const compile = spawnSync(process.execPath, [
    'build',
    './src/entrypoints/hostedActualOwnerAcceptance.ts',
    '--compile',
    '--no-compile-autoload-dotenv',
    '--no-compile-autoload-bunfig',
    '--compile-exec-argv=',
    '--target',
    'bun',
    '--format',
    'esm',
    '--outfile',
    launcher,
    '--minify',
    '--packages',
    'bundle',
    '--conditions',
    'bun',
    '--external',
    './scripts/e2e/hosted-actual-owner/owner.js',
    '--external',
    './scripts/e2e/hosted-actual-owner/owner.ts',
    '--define',
    `process.env.HOSTED_ACTUAL_OWNER_ENTRY_MODE=${JSON.stringify('launcher')}`,
    '--define',
    `process.env.HOSTED_ACTUAL_OWNER_LAUNCH_SNAPSHOT_FAULT=${JSON.stringify(snapshotFault)}`,
  ], { cwd: repoRoot, encoding: 'utf8' })
  if (compile.status !== 0) {
    throw new Error(`launcher fixture compile failed:\n${compile.stdout}\n${compile.stderr}`)
  }
  await chmod(launcher, 0o755)
  const { launchDescriptor, closureDescriptor } = await createFixtureDescriptor(
    bunPath, bundlePath, launcher, launcherRelativePath,
  )
  await writeFile(descriptorPath, `${JSON.stringify(closureDescriptor)}\n`, { mode: 0o600 })
  await writeFile(
    nativeSourcePath,
    await nativeWrapperSource(launcherRelativePath, launcher, descriptorPath),
    { mode: 0o600 },
  )
  const nativeCompile = spawnSync('/usr/bin/cc', [
    '-static', '-O2', '-std=c11', '-Wall', '-Wextra', '-Werror', '-fno-ident',
    '-Wl,--build-id=none', '-s', nativeSourcePath, '-o', outfile,
  ], { cwd: repoRoot, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
  await rm(nativeSourcePath, { force: true })
  if (nativeCompile.status !== 0) {
    throw new Error(`native wrapper fixture compile failed:\n${nativeCompile.stdout}\n${nativeCompile.stderr}`)
  }
  await chmod(outfile, 0o755)
  return launchDescriptor
}

async function snapshotDirectories(orchestratorRef = fixtureOrchestratorRef): Promise<string[]> {
  const prefix = `hosted-actual-owner-${orchestratorRef.slice(0, 12)}-`
  return (await readdir('/tmp')).filter(entry => entry.startsWith(prefix)).sort()
}

async function waitForFile(path: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for ${path}`)
}

async function waitForProcessExit(pid: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for process ${pid} to exit`)
}

beforeAll(async () => {
  // The legacy synthetic Bun/bundle fixtures exercise the superseded two-stage
  // launcher. Production coverage below builds and invokes the real sealed owner.
  return
  fixtureRoot = await mkdtemp(join(tmpdir(), 'hosted-owner-launch-closure-'))
  fixtureRoots.push(fixtureRoot)
  fixtureWrapper = join(fixtureRoot, 'bin', 'hosted-actual-owner-acceptance')
  fixtureBundle = join(fixtureRoot, 'dist', 'local-cli', 'hostedActualOwnerAcceptance.js')
  fixtureBun = join(fixtureRoot, 'runtime', 'bun')
  await Promise.all([
    mkdir(join(fixtureRoot, 'bin'), { recursive: true }),
    mkdir(join(fixtureRoot, 'dist', 'local-cli'), { recursive: true }),
    mkdir(join(fixtureRoot, 'runtime'), { recursive: true }),
    mkdir(join(fixtureRoot, 'ambient-tools'), { recursive: true }),
  ])
  await cp(process.execPath, fixtureBun)
  await chmod(fixtureBun, 0o755)
  fixtureBundleBytes = Buffer.from(
    [
      "if (process.env.BUN_OPTIONS || process.env.NODE_OPTIONS || process.env.NODE_PATH || process.env.NODE_ENV !== 'development') process.exit(24)",
      "process.stderr.write('fixture_bundle_executed\\n'); process.exit(23)",
      '',
    ].join('\n'),
  )
  await writeFile(fixtureBundle, fixtureBundleBytes, { mode: 0o644 })

  const descriptor = await compileFixtureWrapper(
    fixtureWrapper, fixtureBun, fixtureBundle,
  )
  fixtureOrchestratorRef = descriptor.sourceAuthority.orchestratorRef
  const faultRoot = await mkdtemp(join(tmpdir(), 'hosted-owner-snapshot-fault-'))
  fixtureRoots.push(faultRoot)
  fixtureFaultWrapper = join(faultRoot, 'bin', 'hosted-actual-owner-acceptance')
  const faultBundle = join(faultRoot, 'dist', 'local-cli', 'hostedActualOwnerAcceptance.js')
  const faultBun = join(faultRoot, 'runtime', 'bun')
  await Promise.all([
    mkdir(join(faultRoot, 'bin'), { recursive: true }),
    mkdir(join(faultRoot, 'dist', 'local-cli'), { recursive: true }),
    mkdir(join(faultRoot, 'runtime'), { recursive: true }),
  ])
  await Promise.all([
    cp(fixtureBun, faultBun),
    writeFile(faultBundle, fixtureBundleBytes, { mode: 0o644 }),
  ])
  await chmod(faultBun, 0o755)
  await compileFixtureWrapper(
    fixtureFaultWrapper, faultBun, faultBundle, 'after_bun_snapshot',
  )
  ambientAttackMarker = join(fixtureRoot, 'ambient-tool-executed')
  for (const name of ['bun', 'dirname', 'git']) {
    const tool = join(fixtureRoot, 'ambient-tools', name)
    await writeFile(tool, `#!/bin/sh\nprintf attacked > '${ambientAttackMarker}'\nexit 91\n`)
    await chmod(tool, 0o755)
  }

  raceRoot = await mkdtemp(join(tmpdir(), 'hosted-owner-same-inode-race-'))
  fixtureRoots.push(raceRoot)
  raceWrapper = join(raceRoot, 'bin', 'hosted-actual-owner-acceptance')
  raceBundle = join(raceRoot, 'dist', 'local-cli', 'hostedActualOwnerAcceptance.js')
  raceBun = join(raceRoot, 'runtime', 'bun')
  await Promise.all([
    mkdir(join(raceRoot, 'bin'), { recursive: true }),
    mkdir(join(raceRoot, 'dist', 'local-cli'), { recursive: true }),
    mkdir(join(raceRoot, 'runtime'), { recursive: true }),
  ])
  raceBundleBytes = Buffer.from(
    "process.stderr.write('verified_snapshot_bundle_executed\\n'); process.exit(29)\n",
  )
  await writeFile(raceBundle, raceBundleBytes, { mode: 0o644 })
  await cp(process.execPath, raceBun)
  await chmod(raceBun, 0o755)
  await compileFixtureWrapper(
    raceWrapper, raceBun, raceBundle, 'before_spawn_delay',
  )

  const spawnFailureRoot = await mkdtemp(join(tmpdir(), 'hosted-owner-spawn-failure-'))
  fixtureRoots.push(spawnFailureRoot)
  spawnFailureWrapper = join(
    spawnFailureRoot, 'bin', 'hosted-actual-owner-acceptance',
  )
  const spawnFailureBundle = join(
    spawnFailureRoot, 'dist', 'local-cli', 'hostedActualOwnerAcceptance.js',
  )
  const spawnFailureBun = join(spawnFailureRoot, 'runtime', 'bun')
  await Promise.all([
    mkdir(join(spawnFailureRoot, 'bin'), { recursive: true }),
    mkdir(join(spawnFailureRoot, 'dist', 'local-cli'), { recursive: true }),
    mkdir(join(spawnFailureRoot, 'runtime'), { recursive: true }),
  ])
  await writeFile(spawnFailureBundle, fixtureBundleBytes, { mode: 0o644 })
  await writeFile(spawnFailureBun, '#!/definitely/absent/hosted-owner-interpreter\n', {
    mode: 0o755,
  })
  const spawnFailureDescriptor = await compileFixtureWrapper(
    spawnFailureWrapper, spawnFailureBun, spawnFailureBundle,
  )
  spawnFailureOrchestratorRef = spawnFailureDescriptor.sourceAuthority.orchestratorRef

  const signalRoot = await mkdtemp(join(tmpdir(), 'hosted-owner-signal-forwarding-'))
  fixtureRoots.push(signalRoot)
  signalWrapper = join(signalRoot, 'bin', 'hosted-actual-owner-acceptance')
  const signalBundle = join(
    signalRoot, 'dist', 'local-cli', 'hostedActualOwnerAcceptance.js',
  )
  const signalBun = join(signalRoot, 'runtime', 'bun')
  signalOwnerMarker = join(signalRoot, 'owner.pid')
  signalExitMarker = join(signalRoot, 'owner.exited')
  await Promise.all([
    mkdir(join(signalRoot, 'bin'), { recursive: true }),
    mkdir(join(signalRoot, 'dist', 'local-cli'), { recursive: true }),
    mkdir(join(signalRoot, 'runtime'), { recursive: true }),
  ])
  await cp(process.execPath, signalBun)
  await chmod(signalBun, 0o755)
  await writeFile(signalBundle, [
    "import { writeFileSync } from 'node:fs'",
    `writeFileSync(${JSON.stringify(signalOwnerMarker)}, String(process.pid))`,
    `process.once('SIGTERM', () => { writeFileSync(${JSON.stringify(signalExitMarker)}, 'exited'); process.exit(0) })`,
    'setInterval(() => undefined, 1_000)',
    '',
  ].join('\n'), { mode: 0o644 })
  await compileFixtureWrapper(signalWrapper, signalBun, signalBundle)
}, 300_000)

afterAll(async () => {
  for (const root of fixtureRoots.splice(0)) {
    await rm(root, { recursive: true, force: true })
  }
})

describe.skip('superseded synthetic hosted actual-owner launcher boundary', () => {
  test('fails closed on malformed input before consulting its execution closure', () => {
    const result = runFixture([])
    expect(result.status).toBe(64)
    expect(result.stderr).toContain(
      'Usage: hosted-actual-owner-acceptance --runtime-manifest /absolute/path',
    )
  })

  test('does not admit Bun or Node preload injection before native-wrapper validation', async () => {
    const preload = join(fixtureRoot, 'ambient-preload.cjs')
    const marker = join(fixtureRoot, 'ambient-preload-executed')
    const bunfig = join(fixtureRoot, 'bunfig.toml')
    const dotenv = join(fixtureRoot, '.env')
    await writeFile(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')\n`)
    try {
      await writeFile(bunfig, `preload = [${JSON.stringify(preload)}]\n`)
      await writeFile(dotenv, `BUN_OPTIONS=--preload=${preload}\n`)
      for (const injectedEnvironment of [
        { BUN_OPTIONS: `--preload=${preload}` },
        { NODE_OPTIONS: `--require=${preload}`, NODE_PATH: fixtureRoot },
        {},
      ]) {
        await rm(marker, { force: true })
        const result = runFixture([], fixtureWrapper, injectedEnvironment)
        expect(result.status).toBe(64)
        expect(existsSync(marker)).toBe(false)
      }
    } finally {
      await rm(bunfig, { force: true })
      await rm(dotenv, { force: true })
    }
  })

  test('runs from a built-only closure and ignores ambient PATH tools', async () => {
    const result = runFixture(['--runtime-manifest', '/tmp/fixture-manifest.json'])
    expect(result.status).toBe(23)
    expect(result.stderr).toContain('fixture_bundle_executed')
    expect(existsSync(ambientAttackMarker)).toBe(false)
    expect(await snapshotDirectories()).toEqual([])
  })

  test('executes sealed verified bytes when both original inodes mutate before execution', async () => {
    const hostileBun = '#!/bin/sh\nexit 98\n'
    const hostileBundle =
      "process.stderr.write('mutated_original_bundle_executed\\n'); process.exit(97)\n"
    const child = spawn(raceWrapper, [
      '--runtime-manifest', '/tmp/fixture-manifest.json',
    ], {
      cwd: fixtureRoot,
      env: {
        PATH: join(fixtureRoot, 'ambient-tools'),
        LANG: 'C',
        LC_ALL: 'C',
        HOSTED_ACTUAL_OWNER_ENTRY_MODE: 'bundle',
        HOSTED_ACTUAL_OWNER_LAUNCH_DESCRIPTOR: '{}',
        HOSTED_ACTUAL_OWNER_SOURCE_REF: 'f'.repeat(40),
      },
    })
    child.stdout.resume()
    child.stderr.setEncoding('utf8')
    let stderr = ''
    let ready = false
    let resolveReady: (() => void) | undefined
    let rejectReady: ((error: Error) => void) | undefined
    const snapshotReady = new Promise<void>((resolve, reject) => {
      resolveReady = resolve
      rejectReady = reject
    })
    const completed = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once('error', error => {
          rejectReady?.(error)
          reject(error)
        })
        child.once('close', (status, signal) => {
          if (!ready) rejectReady?.(new Error(`launcher exited before snapshot: ${stderr}`))
          resolve({ status, signal })
        })
      },
    )
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
      if (!ready && stderr.includes('hosted_actual_owner_test_snapshot_ready')) {
        ready = true
        resolveReady?.()
      }
    })
    try {
      await snapshotReady
      const childList = (await readFile(
        `/proc/${child.pid}/task/${child.pid}/children`, 'utf8',
      )).trim().split(/\s+/).filter(Boolean)
      expect(childList).toHaveLength(1)
      const descriptorRoot = `/proc/${childList[0]}/fd`
      const sealedSnapshots = (await Promise.all(
        (await readdir(descriptorRoot)).map(async descriptor => ({
          path: join(descriptorRoot, descriptor),
          target: await readlink(join(descriptorRoot, descriptor)),
        })),
      )).filter(({ target }) => target.includes('memfd:hosted-actual-owner-'))
      expect(sealedSnapshots.map(({ target }) => target).sort()).toEqual([
        '/memfd:hosted-actual-owner-bun (deleted)',
        '/memfd:hosted-actual-owner-bundle (deleted)',
      ])
      for (const snapshot of sealedSnapshots) {
        await expect(writeFile(snapshot.path, 'hostile_snapshot_bytes'))
          .rejects.toMatchObject({ code: 'EPERM' })
      }
      await Promise.all([
        writeFile(raceBun, hostileBun, { mode: 0o755 }),
        writeFile(raceBundle, hostileBundle, { mode: 0o644 }),
      ])
      const result = await completed
      expect(result.signal).toBeNull()
      expect(result.status).toBe(29)
      expect(stderr).toContain('verified_snapshot_bundle_executed')
      expect(stderr).not.toContain('mutated_original_bundle_executed')
      expect(await readFile(raceBun, 'utf8')).toBe(hostileBun)
      expect(await readFile(raceBundle, 'utf8')).toBe(hostileBundle)
      expect(await snapshotDirectories()).toEqual([])
    } finally {
      child.kill()
      await cp(process.execPath, raceBun, { force: true })
      await chmod(raceBun, 0o755)
      await writeFile(raceBundle, raceBundleBytes, { mode: 0o644 })
      await chmod(raceBundle, 0o644)
    }
  })

  test('closes sealed snapshot descriptors after an injected staging failure', async () => {
    const result = runFixture(
      ['--runtime-manifest', '/tmp/fixture-manifest.json'], fixtureFaultWrapper,
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('hosted_actual_owner_launch_snapshot_failed')
    expect(result.stderr).not.toContain('fixture_bundle_executed')
    expect(await snapshotDirectories()).toEqual([])
  })

  test('closes sealed snapshot descriptors and fails closed when spawning is impossible', async () => {
    const result = runFixture(
      ['--runtime-manifest', '/tmp/fixture-manifest.json'], spawnFailureWrapper,
    )
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('hosted_actual_owner_launch_child_failed')
    expect(result.stderr).not.toContain('fixture_bundle_executed')
    expect(await snapshotDirectories(spawnFailureOrchestratorRef)).toEqual([])
  })

  test('replaces the ambient runtime mode for the descriptor-pinned Bun child', () => {
    const result = runFixture(
      ['--runtime-manifest', '/tmp/fixture-manifest.json'],
      fixtureWrapper,
      { NODE_ENV: 'production' },
    )
    expect(result.status).toBe(23)
    expect(result.stderr).toContain('fixture_bundle_executed')
  })

  test('does not admit ambient loader injection into the descriptor-pinned Bun child', async () => {
    const preload = join(fixtureRoot, 'child-preload.cjs')
    const marker = join(fixtureRoot, 'child-preload-executed')
    await writeFile(preload, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')\n`)
    const result = runFixture(
      ['--runtime-manifest', '/tmp/fixture-manifest.json'],
      fixtureWrapper,
      {
        BUN_OPTIONS: `--preload=${preload}`,
        NODE_OPTIONS: `--require=${preload}`,
        NODE_PATH: fixtureRoot,
        NODE_ENV: 'production',
      },
    )
    expect(result.status).toBe(23)
    expect(result.stderr).toContain('fixture_bundle_executed')
    expect(existsSync(marker)).toBe(false)
  })

  test('forwards termination to the launcher process group without orphaning the owner', async () => {
    const launcher = spawn(signalWrapper, [
      '--runtime-manifest', '/tmp/fixture-manifest.json',
    ], { cwd: fixtureRoot, env: { PATH: '/nonexistent', LANG: 'C', LC_ALL: 'C' } })
    launcher.stdout.resume()
    launcher.stderr.resume()
    const completed = new Promise<{ status: number | null; signal: NodeJS.Signals | null }>(
      (resolveClose, rejectClose) => {
        launcher.once('error', rejectClose)
        launcher.once('close', (status, signal) => resolveClose({ status, signal }))
      },
    )
    try {
      await waitForFile(signalOwnerMarker)
      const ownerPid = Number((await readFile(signalOwnerMarker, 'utf8')).trim())
      expect(Number.isSafeInteger(ownerPid)).toBe(true)
      launcher.kill('SIGTERM')
      const result = await completed
      expect(result.signal).toBe('SIGTERM')
      await waitForFile(signalExitMarker)
      await waitForProcessExit(ownerPid)
    } finally {
      launcher.kill('SIGKILL')
    }
  })

  test('rejects wrapper relocation instead of finding source or an ambient bundle', async () => {
    const relocatedRoot = await mkdtemp(join(tmpdir(), 'hosted-owner-relocated-wrapper-'))
    fixtureRoots.push(relocatedRoot)
    const relocated = join(relocatedRoot, 'hosted-actual-owner-acceptance')
    await cp(fixtureWrapper, relocated)
    await chmod(relocated, 0o755)
    const result = runFixture(['--runtime-manifest', '/tmp/fixture-manifest.json'], relocated)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('hosted_actual_owner_launch_wrapper_relocated')
    expect(result.stderr).not.toContain('fixture_bundle_executed')
  })

  test('authenticates the actual launcher bytes before executing them', async () => {
    const launcher = join(fixtureRoot, 'dist', 'local-cli', 'hostedActualOwnerLauncher')
    const original = await readFile(launcher)
    try {
      const replaced = Buffer.from(original)
      replaced[replaced.length - 1] ^= 0xff
      await writeFile(launcher, replaced, { mode: 0o755 })
      const result = runFixture(['--runtime-manifest', '/tmp/fixture-manifest.json'])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('hosted_actual_owner_launch_launcher_hash_mismatch')
      expect(result.stderr).not.toContain('fixture_bundle_executed')
    } finally {
      await writeFile(launcher, original, { mode: 0o755 })
    }
  })

  test('consumes only the authenticated closure descriptor', async () => {
    const descriptor = join(
      fixtureRoot, 'dist', 'local-cli', 'hostedActualOwnerAcceptance.closure.json',
    )
    const original = await readFile(descriptor)
    try {
      const replaced = Buffer.from(original)
      replaced[replaced.length - 2] ^= 0x01
      await writeFile(descriptor, replaced, { mode: 0o600 })
      const result = runFixture(['--runtime-manifest', '/tmp/fixture-manifest.json'])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('hosted_actual_owner_launch_descriptor_replaced')
      expect(result.stderr).not.toContain('fixture_bundle_executed')
    } finally {
      await writeFile(descriptor, original, { mode: 0o600 })
    }
  })

  test('fails closed when the descriptor-bound bundle is missing', async () => {
    const absent = `${fixtureBundle}.absent`
    await rename(fixtureBundle, absent)
    try {
      const result = runFixture(['--runtime-manifest', '/tmp/fixture-manifest.json'])
      expect(result.status).toBe(1)
      expect(result.stderr).not.toContain('fixture_bundle_executed')
      expect(existsSync(ambientAttackMarker)).toBe(false)
    } finally {
      await rename(absent, fixtureBundle)
    }
  })

  test('rejects bundle replacement before the changed bytes execute', async () => {
    try {
      await writeFile(fixtureBundle, "process.stderr.write('replaced_bundle_executed\\n')\n")
      const result = runFixture(['--runtime-manifest', '/tmp/fixture-manifest.json'])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('hosted_actual_owner_launch_bundle_replaced')
      expect(result.stderr).not.toContain('replaced_bundle_executed')
    } finally {
      await writeFile(fixtureBundle, fixtureBundleBytes, { mode: 0o644 })
    }
  })

  test('rejects replacement of the descriptor-pinned Bun executable', async () => {
    const backup = `${fixtureBun}.original`
    await rename(fixtureBun, backup)
    try {
      await writeFile(fixtureBun, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      const result = runFixture(['--runtime-manifest', '/tmp/fixture-manifest.json'])
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('hosted_actual_owner_launch_bun_replaced')
      expect(result.stderr).not.toContain('fixture_bundle_executed')
    } finally {
      await rm(fixtureBun, { force: true })
      await rename(backup, fixtureBun)
    }
  })
})

async function writeRuntimeManifest(input: {
  orchestratorRef: string
  openCodeExecutableSha256: string
  productRef: string
}): Promise<{ manifestPath: string; sandbox: string }> {
  const sandbox = await mkdtemp(join(tmpdir(), 'hosted-owner-built-manifest-'))
  fixtureRoots.push(sandbox)
  await chmod(sandbox, 0o700)
  const root = await lstat(sandbox, { bigint: true })
  const markerPath = join(sandbox, '.agent-teams-actual-owner-e2e-owner.json')
  const runId = 'a'.repeat(48)
  await writeFile(markerPath, `${JSON.stringify({
    schemaVersion: 1,
    purpose: 'agent-teams.hosted-actual-owner-e2e/v1',
    runId,
    rootBasename: basename(sandbox),
    rootDevice: root.dev.toString(),
    rootInode: root.ino.toString(),
  })}\n`, { mode: 0o600 })
  const manifestPath = join(sandbox, 'runtime-manifest.json')
  await writeFile(manifestPath, `${JSON.stringify({
    schemaVersion: 1,
    purpose: 'agent-teams.hosted-actual-owner-e2e/v1',
    runId,
    sandboxRoot: sandbox,
    markerPath,
    evidenceRoot: join(sandbox, 'evidence'),
    driverBaseUrl: 'http://127.0.0.1:49152/',
    productBaseUrl: 'http://127.0.0.1:49153/',
    approvalPath: '/hosted/approvals',
    browser: {},
    capture: {
      conditionalPostLedgerPath: join(sandbox, 'capture', 'posts.ndjson'),
      negativeResultsPath: join(sandbox, 'capture', 'negative.json'),
      openCodeTimelinePath: join(sandbox, 'capture', 'opencode.ndjson'),
      ownerWalTimelinePath: join(sandbox, 'capture', 'owner.ndjson'),
      productTimelinePath: join(sandbox, 'capture', 'product.ndjson'),
      protectedEffectLedgerPath: join(sandbox, 'capture', 'effects.json'),
    },
    refs: {
      openCode: 'b'.repeat(40),
      openCodeExecutableSha256: input.openCodeExecutableSha256,
      orchestrator: input.orchestratorRef,
      product: input.productRef,
    },
  })}\n`, { mode: 0o600 })
  return { manifestPath, sandbox }
}

describe('packaged hosted actual-owner build', () => {
  function spawnResultEvidence(result: ReturnType<typeof spawnSync>): string {
    return JSON.stringify({
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      error: result.error?.message,
    })
  }

  async function cleanPackagedBuildFixture(copyDependencies = true): Promise<string> {
    const fixtureParent = await mkdtemp(join(tmpdir(), 'hosted-owner-clean-build-'))
    fixtureRoots.push(fixtureParent)
    const root = join(fixtureParent, 'repository')
    const clone = spawnSync('/usr/bin/git', ['clone', '--no-hardlinks', repoRoot, root], {
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    })
    if (clone.status !== 0) {
      throw new Error(`clean fixture clone failed: ${spawnResultEvidence(clone)}`)
    }
    const ownedProductionPaths = [
      'scripts/build.ts',
      'scripts/e2e/hosted-actual-owner/contracts.ts',
      'scripts/e2e/hosted-actual-owner/evidence.ts',
      'scripts/e2e/hosted-actual-owner/owner.ts',
      'scripts/e2e/hosted-actual-owner/process-anchor.ts',
      'scripts/e2e/hosted-actual-owner/secure-files.ts',
      'src/entrypoints/hostedActualOwnerAcceptance.ts',
      'src/entrypoints/hostedActualOwnerGeneratedIdentity.ts',
    ]
    for (const path of ownedProductionPaths) {
      await cp(join(repoRoot, path), join(root, path))
    }
    const dependencies = join(repoRoot, 'node_modules')
    if (copyDependencies && existsSync(dependencies)) {
      await cp(dependencies, join(root, 'node_modules'), { recursive: true })
    }
    const commit = spawnSync('/usr/bin/git', [
      '-C', root, '-c', 'user.name=Hosted Owner Test',
      '-c', 'user.email=hosted-owner-test.invalid', 'add', '--', ...ownedProductionPaths,
    ], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } })
    if (commit.status !== 0) {
      throw new Error(`clean fixture add failed: ${spawnResultEvidence(commit)}`)
    }
    const committed = spawnSync('/usr/bin/git', [
      '-C', root, '-c', 'user.name=Hosted Owner Test',
      '-c', 'user.email=hosted-owner-test.invalid', 'commit', '--allow-empty',
      '-m', 'packaged owner fixture',
    ], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } })
    if (committed.status !== 0) {
      throw new Error(`clean fixture commit failed: ${spawnResultEvidence(committed)}`)
    }
    return root
  }

  test('creates a genuinely clean commit when fixture inputs already match HEAD', async () => {
    const root = await cleanPackagedBuildFixture(false)
    const status = spawnSync('/usr/bin/git', [
      '-C', root, 'status', '--porcelain=v1', '--untracked-files=all',
    ], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } })
    expect(status.status, spawnResultEvidence(status)).toBe(0)
    expect(status.signal).toBeNull()
    expect(status.stdout).toBe('')
    expect(status.stderr).toBe('')
    const subject = spawnSync('/usr/bin/git', [
      '-C', root, 'show', '-s', '--format=%s', 'HEAD',
    ], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } })
    expect(subject.status, spawnResultEvidence(subject)).toBe(0)
    expect(subject.stdout.trim()).toBe('packaged owner fixture')
  })

  test('removes every staging output when a build child fails', async () => {
    const brokenRoot = await mkdtemp(join(tmpdir(), 'hosted-owner-failed-build-'))
    fixtureRoots.push(brokenRoot)
    await mkdir(join(brokenRoot, 'scripts'), { recursive: true })
    await cp(buildScript, join(brokenRoot, 'scripts', 'build.ts'))
    await writeFile(join(brokenRoot, 'package.json'), JSON.stringify({
      name: 'failed-build-fixture', version: '0.0.0',
    }))
    const result = spawnSync(process.execPath, ['run', join(brokenRoot, 'scripts', 'build.ts')], {
      cwd: brokenRoot,
      encoding: 'utf8',
      env: process.env,
    })
    expect(result.status).not.toBe(0)
    expect(existsSync(join(brokenRoot, 'dist', 'local-cli'))).toBe(false)
    const distEntries = existsSync(join(brokenRoot, 'dist'))
      ? await readdir(join(brokenRoot, 'dist'))
      : []
    const binEntries = existsSync(join(brokenRoot, 'bin'))
      ? await readdir(join(brokenRoot, 'bin'))
      : []
    expect(distEntries.some(entry => entry.includes('.staging-'))).toBe(false)
    expect(binEntries.some(entry => entry.includes('.staging-'))).toBe(false)
  })

  test('fails closed on generated identity tampering and removes every temporary input', async () => {
    const root = await cleanPackagedBuildFixture()
    const committedSentinel = await readFile(join(
      root, 'src', 'entrypoints', 'hostedActualOwnerGeneratedIdentity.ts',
    ))
    const build = spawnSync(process.execPath, ['run', './scripts/build.ts'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        HOSTED_ACTUAL_OWNER_BUILD_TEST_HOOK: '1',
        HOSTED_ACTUAL_OWNER_GENERATED_IDENTITY_TEST_FAULT: 'replace-before-final-build',
      },
    })
    expect(build.status).not.toBe(0)
    expect(build.stderr).toContain(
      'Hosted actual-owner generated identity changed before final build',
    )
    expect(await readFile(join(
      root, 'src', 'entrypoints', 'hostedActualOwnerGeneratedIdentity.ts',
    ))).toEqual(committedSentinel)
    const distEntries = existsSync(join(root, 'dist'))
      ? await readdir(join(root, 'dist'))
      : []
    const binEntries = existsSync(join(root, 'bin'))
      ? await readdir(join(root, 'bin'))
      : []
    expect(distEntries.some(entry => entry.includes('.staging-'))).toBe(false)
    expect(binEntries.some(entry => entry.includes('.staging-'))).toBe(false)
    expect(existsSync(join(root, 'bin', 'hosted-actual-owner-acceptance'))).toBe(false)
  }, 240_000)

  test('builds and runs the real sealed owner with no sidecar or generic loader', async () => {
    const buildRoot = await cleanPackagedBuildFixture()
    const fixtureBuildScript = join(buildRoot, 'scripts', 'build.ts')
    const generatedWrapper = join(buildRoot, 'bin', 'hosted-actual-owner-acceptance')
    const build = spawnSync(process.execPath, ['run', './scripts/build.ts'], {
      cwd: buildRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_DIR: '/definitely/forged',
        GIT_WORK_TREE: '/definitely/forged',
      },
    })
    try {
      expect(build.status, build.stderr).toBe(0)
      const ownerNames = (await readdir(join(buildRoot, 'dist', 'local-cli'))).filter(name =>
        /^hostedActualOwnerLauncher-[0-9a-f]{64}$/.test(name),
      )
      expect(ownerNames).toHaveLength(1)
      const ownerName = ownerNames[0]!
      const ownerArtifact = join(buildRoot, 'dist', 'local-cli', ownerName)
      expect(ownerName.endsWith(sha256(await readFile(ownerArtifact)))).toBe(true)
      const installedOwner = await lstat(ownerArtifact)
      const installedWrapper = await lstat(generatedWrapper)
      expect(installedOwner.mode & 0o111).not.toBe(0)
      expect(installedOwner.mode & 0o222).toBe(0)
      expect(installedWrapper.mode & 0o222).toBe(0)
      expect(installedOwner.nlink).toBe(1)
      expect(installedWrapper.nlink).toBe(1)
      expect(existsSync(join(
        buildRoot, 'dist', 'local-cli', 'hostedActualOwnerAcceptance.closure.json',
      ))).toBe(false)
      expect(existsSync(join(
        buildRoot, 'dist', 'local-cli', 'hostedActualOwnerAcceptance.js',
      ))).toBe(false)

      const head = spawnSync('/usr/bin/git', ['-C', buildRoot, 'rev-parse', 'HEAD'], {
        encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      }).stdout.trim()
      const openCodeSha256 = sha256(await readFile(process.execPath))
      const { manifestPath: matchingManifest, sandbox } = await writeRuntimeManifest({
        orchestratorRef: head,
        openCodeExecutableSha256: openCodeSha256,
        productRef: head,
      })
      const preloadMarker = join(sandbox, 'preload-executed')
      const preload = join(sandbox, 'preload.js')
      await writeFile(preload, `await Bun.write(${JSON.stringify(preloadMarker)}, 'forged')\n`)
      const ownerEnvironment = {
        PATH: '/nonexistent',
        BUN_INSPECT_PRELOAD: preload,
        NODE_OPTIONS: '--require=/definitely/forged',
        LD_PRELOAD: '/definitely/forged',
        GIT_DIR: '/definitely/forged',
        ARBITRARY_CONFIG: '/definitely/forged',
        HOSTED_ACTUAL_OWNER_E2E_ADMISSION_FILE: join(
          sandbox, 'team', 'hosted-approval-runtime-admission.v1.json',
        ),
        HOSTED_ACTUAL_OWNER_E2E_HOSTED_CONTROL_CONFIG: join(sandbox, 'hosted-control.json'),
        HOSTED_ACTUAL_OWNER_E2E_OPENCODE_EXECUTABLE: process.execPath,
        HOSTED_ACTUAL_OWNER_E2E_OPENCODE_SHA256: openCodeSha256,
        HOSTED_ACTUAL_OWNER_E2E_PRODUCT_ROOT: buildRoot,
        HOSTED_ACTUAL_OWNER_E2E_PRODUCT_PUBLICATION_TIMEOUT_MS: '5000',
        HOSTED_ACTUAL_OWNER_E2E_CONTROL_SOCKET: join(sandbox, 'control.sock'),
        HOSTED_ACTUAL_OWNER_E2E_EVIDENCE_FILE: join(sandbox, 'evidence.json'),
        HOSTED_ACTUAL_OWNER_E2E_MARKER: join(
          sandbox, '.agent-teams-actual-owner-e2e-owner.json',
        ),
        HOSTED_ACTUAL_OWNER_E2E_RUNTIME_MANIFEST: matchingManifest,
        CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: process.execPath,
      }
      const spawnFaultSource = join(sandbox, 'deny-clone.c')
      const spawnFaultInjector = join(sandbox, 'deny-clone')
      await writeFile(spawnFaultSource, `
#include <errno.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc < 2 || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) return 125;
  struct sock_filter filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EAGAIN),
#ifdef __NR_clone3
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_clone3, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EAGAIN),
#endif
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = {
    .len = (unsigned short)(sizeof(filter) / sizeof(filter[0])), .filter = filter,
  };
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program) != 0) return 126;
  execv(argv[1], &argv[1]);
  return 127;
}
`)
      const compileSpawnFault = spawnSync('/usr/bin/cc', [
        '-O2', '-Wall', '-Wextra', '-Werror', spawnFaultSource, '-o', spawnFaultInjector,
      ], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' } })
      expect(compileSpawnFault.status).toBe(0)
      const spawnFailure = spawnSync(spawnFaultInjector, [
        generatedWrapper, '--runtime-manifest', matchingManifest,
      ], { cwd: buildRoot, encoding: 'utf8', env: ownerEnvironment })
      expect(spawnFailure.status).toBe(1)
      expect(spawnFailure.stderr).toContain('hosted_actual_owner_launch_child_failed')
      const admitted = spawnSync(generatedWrapper, ['--runtime-manifest', matchingManifest], {
        cwd: buildRoot, encoding: 'utf8',
        env: ownerEnvironment,
      })
      expect(admitted.status).toBe(1)
      expect(admitted.stderr).toContain('product_publication_timeout')
      expect(admitted.stderr).not.toContain('orchestrator_ref_mismatch')
      expect(existsSync(preloadMarker)).toBe(false)

      const genericSource = join(sandbox, 'generic-wrapper.c')
      const genericWrapper = join(sandbox, 'generic-wrapper')
      const genericPrint = spawnSync(process.execPath, [
        'run', fixtureBuildScript,
        `--print-hosted-actual-owner-native-wrapper=dist/local-cli/${ownerName}`,
      ], { cwd: buildRoot, encoding: 'utf8', env: process.env })
      expect(genericPrint.status).toBe(0)
      await writeFile(genericSource, genericPrint.stdout, { mode: 0o600 })
      expect(spawnSync('/usr/bin/cc', [
        '-static', '-O2', '-std=c11', '-Wall', '-Wextra', '-Werror',
        genericSource, '-o', genericWrapper,
      ], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).status).toBe(0)
      const wrapperBackup = `${generatedWrapper}.authority-bound-original`
      await rename(generatedWrapper, wrapperBackup)
      try {
        await rename(genericWrapper, generatedWrapper)
        await chmod(generatedWrapper, 0o555)
        const genericRun = spawnSync(generatedWrapper, [
          '--runtime-manifest', matchingManifest,
        ], { cwd: buildRoot, encoding: 'utf8', env: ownerEnvironment })
        expect(genericRun.status).toBe(1)
        expect(genericRun.stderr).toContain(
          'hosted_actual_owner_launch_wrapper_authority_mismatch',
        )
      } finally {
        await rm(generatedWrapper, { force: true })
        await rename(wrapperBackup, generatedWrapper)
      }

      const manifestBytes = await readFile(matchingManifest)
      const forgedManifest = JSON.parse(manifestBytes.toString('utf8'))
      forgedManifest.refs.orchestrator = head === 'f'.repeat(40)
        ? 'e'.repeat(40)
        : 'f'.repeat(40)
      await writeFile(matchingManifest, `${JSON.stringify(forgedManifest)}\n`, { mode: 0o600 })
      try {
        const forgedRef = spawnSync(generatedWrapper, [
          '--runtime-manifest', matchingManifest,
        ], { cwd: buildRoot, encoding: 'utf8', env: ownerEnvironment })
        expect(forgedRef.status).toBe(1)
        expect(forgedRef.stderr).toContain(
          'hosted_actual_owner_built_orchestrator_ref_mismatch',
        )
      } finally {
        await writeFile(matchingManifest, manifestBytes, { mode: 0o600 })
      }

      const mutationMarker = join(sandbox, 'mutated-owner-executed')
      const ownerBackup = `${ownerArtifact}.verified-original`
      const sealedRun = Bun.spawn({
        cmd: [generatedWrapper, '--runtime-manifest', matchingManifest],
        cwd: buildRoot,
        env: ownerEnvironment,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      let sealedPid = 0
      const childDeadline = Date.now() + 3000
      while (Date.now() < childDeadline && sealedPid === 0) {
        try {
          const children = (await readFile(
            `/proc/${sealedRun.pid}/task/${sealedRun.pid}/children`, 'utf8',
          )).trim().split(/\s+/).filter(Boolean)
          sealedPid = Number(children[0] ?? 0)
        } catch {}
        if (sealedPid === 0) await Bun.sleep(1)
      }
      expect(sealedPid).toBeGreaterThan(1)
      await rename(ownerArtifact, ownerBackup)
      try {
        await writeFile(ownerArtifact, `#!/bin/sh\ntouch ${mutationMarker}\nexit 97\n`, {
          mode: 0o755,
        })
        await Bun.sleep(50)
        const descriptors = await readdir(`/proc/${sealedPid}/fd`).catch(() => [])
        const descriptorTargets = await Promise.all(descriptors.map(async descriptor =>
          readlink(`/proc/${sealedPid}/fd/${descriptor}`).catch(() => ''),
        ))
        expect(descriptorTargets.some(target =>
          target.includes('memfd:hosted-actual-owner-launcher'),
        )).toBe(false)
        const sealedEnvironment = (await readFile(`/proc/${sealedPid}/environ`, 'utf8'))
          .split('\0').filter(Boolean)
        expect(sealedEnvironment.some(entry =>
          /^(?:BUN_|NODE_|LD_|DYLD_|GLIBC_TUNABLES=|GIT_|ARBITRARY_CONFIG=)/.test(entry),
        )).toBe(false)
        expect(await sealedRun.exited).toBe(1)
        const sealedStderr = await new Response(sealedRun.stderr).text()
        expect(sealedStderr).toContain('product_publication_timeout')
        expect(sealedStderr).not.toContain('launcher_hash_mismatch')
        expect(existsSync(mutationMarker)).toBe(false)
      } finally {
        await rm(ownerArtifact, { force: true })
        await rename(ownerBackup, ownerArtifact)
      }

      const decoyRoot = await mkdtemp(join(tmpdir(), 'hosted-owner-generic-bun-'))
      fixtureRoots.push(decoyRoot)
      const decoy = join(decoyRoot, 'owner-decoy.js')
      const forgedBuild = spawnSync(process.execPath, [
        'build', join(buildRoot, 'src', 'entrypoints', 'hostedActualOwnerAcceptance.ts'),
        '--target=bun', '--format=esm', '--external=*', `--outfile=${decoy}`,
        '--define', 'process.env.HOSTED_ACTUAL_OWNER_ENTRY_MODE="owner"',
      ], { cwd: buildRoot, encoding: 'utf8' })
      expect(forgedBuild.status).toBe(0)
      const direct = spawnSync(process.execPath, [
        decoy,
        '--hosted-actual-owner-sealed-protocol=v1',
      ], {
        cwd: buildRoot, encoding: 'utf8',
        env: process.env,
      })
      expect(direct.status).toBe(1)
      expect(direct.stderr).toContain(
        'hosted_actual_owner_launch_standalone_owner_identity_invalid',
      )
      const directSource = spawnSync(process.execPath, [
        join(buildRoot, 'src', 'entrypoints', 'hostedActualOwnerAcceptance.ts'),
        '--hosted-actual-owner-sealed-protocol=v1',
      ], {
        cwd: buildRoot,
        encoding: 'utf8',
        env: { ...process.env, HOSTED_ACTUAL_OWNER_ENTRY_MODE: 'owner' },
      })
      expect(directSource.status).toBe(1)
      expect(directSource.stderr).toContain(
        'hosted_actual_owner_launch_standalone_owner_identity_invalid',
      )
      expect((await readdir(join(buildRoot, 'dist'))).some(
        entry => entry.includes('.staging-'),
      )).toBe(false)

      const unrelated = join(buildRoot, 'dist', 'local-cli', 'unrelated-preserved')
      await writeFile(unrelated, 'preserve-me')
      const concurrentBuilds = ['ULTRAPLAN', 'TEAMMEM'].map(feature => Bun.spawn({
        cmd: [process.execPath, 'run', './scripts/build.ts', `--feature=${feature}`],
        cwd: buildRoot,
        env: process.env,
        stdout: 'pipe',
        stderr: 'pipe',
      }))
      const concurrentStatuses = await Promise.all(concurrentBuilds.map(child => child.exited))
      expect(concurrentStatuses).toEqual([0, 0])
      const concurrentOutput = await Promise.all(concurrentBuilds.map(async child =>
        (await new Response(child.stdout).text()).trim()))
      const reportedWinners = concurrentOutput.map(output =>
        output.match(/\(([0-9a-f]{64})\)$/)?.[1])
      expect(reportedWinners[0]).toMatch(/^[0-9a-f]{64}$/)
      expect(reportedWinners[1]).toBe(reportedWinners[0])
      expect(await readFile(unrelated, 'utf8')).toBe('preserve-me')
      expect((await readdir(join(buildRoot, 'dist', 'local-cli'))).filter(name =>
        /^hostedActualOwnerLauncher-[0-9a-f]{64}$/.test(name),
      )).toHaveLength(1)
      expect(existsSync(`${generatedWrapper}.lock`)).toBe(false)
    } finally {
      await rm(generatedWrapper, { force: true })
    }
  }, 240_000)
})
