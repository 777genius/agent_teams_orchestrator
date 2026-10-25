import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { chmod, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { classifyLinuxLauncherProbe, linuxLauncherMeetsFloor, qualifyLinuxLauncher } from './OpenCodeV2ExecutionLauncher.js'

describe('Linux launcher version floor', () => {
  test('only an exact bubblewrap report at or above 0.12.0 passes', () => {
    for (const text of ['bubblewrap 0.12.0', 'bubblewrap 0.13.1', 'bubblewrap 0.100.0', 'bubblewrap 1.0.0', ' bubblewrap 0.13.0\n']) {
      expect(linuxLauncherMeetsFloor(text)).toBe(true)
    }
    // Ubuntu 24.04 ships 0.9.0 with the CVE-2026-87766 backport reverted (USN-8779-2).
    for (const text of ['bubblewrap 0.9.0', 'bubblewrap 0.11.2', 'bubblewrap 0.12', 'bubblewrap 0.13.0-rc1',
      'bwrap 0.13.0', 'bubblewrap 0.13.0 extra', '', 'bubblewrap 00000.13.0']) {
      expect(linuxLauncherMeetsFloor(text)).toBe(false)
    }
  })
})

describe('Linux launcher probe classification', () => {
  const ok = { setupReached: true, escapedToHost: false }
  test('any host-side effect fails closed, even when another case did not reach setup', () => {
    expect(classifyLinuxLauncherProbe([ok, { setupReached: true, escapedToHost: true }, ok])).toBe('execution_containment_launcher_unsafe')
    expect(classifyLinuxLauncherProbe([{ setupReached: false, escapedToHost: true }])).toBe('execution_containment_launcher_unsafe')
  })
  test('every case must reach setup; no cases is no evidence', () => {
    expect(classifyLinuxLauncherProbe([ok, ok, ok])).toBe('qualified')
    expect(classifyLinuxLauncherProbe([ok, { setupReached: false, escapedToHost: false }, ok])).toBe('execution_containment_launcher_denied')
    expect(classifyLinuxLauncherProbe([])).toBe('execution_containment_launcher_denied')
  })
})

// Shell stand-ins for bwrap. They process setup operations in order, as bwrap does, and
// only emulate the effects the probe observes: a fixed launcher creates the control
// directory and dies at the symlinked operation; a vulnerable one follows the /oldroot
// symlink and creates the target on the host. `<kind>-only` is vulnerable for one kind.
const fake = (mode: string) => `#!/bin/sh
PATH=/usr/bin:/bin
mode=${mode}
if [ "$1" = "--version" ]; then
  if [ "$mode" = old ]; then echo "bubblewrap 0.9.0"; else echo "bubblewrap 0.13.1"; fi
  exit 0
fi
[ "$mode" = denied ] && exit 1
root=""
probe() { # <op> <dest>: returns 0 when the stand-in follows the symlink
  case "$1:$2" in
    --dir:/link/*) kind=dir ;; --bind:/link/*) kind=bind ;; --ro-bind:/link/*) kind=file ;; --ro-bind:*) kind=leaf ;; *) kind=other ;;
  esac
  [ "$mode" = vulnerable ] || [ "$mode" = "$kind-only" ] || return 1
  case "$2" in
    /link/*) target="$(readlink "$root/link")/\${2#/link/}" ;;
    *) target=$(readlink "$root$2") ;;
  esac
  target=\${target#/oldroot}
  if [ "$1" = --ro-bind ]; then : > "$target"; else mkdir "$target"; fi
}
while [ $# -gt 0 ]; do
  case "$1" in
    --bind|--ro-bind)
      if [ -z "$root" ] && [ "$3" = "/" ]; then root=$2; else probe "$1" "$3" || exit 1; fi
      shift 3 ;;
    --dir)
      case "$2" in
        /setup-*) mkdir "$root$2"; [ "$mode" = slow ] && exec sleep 10 ;;
        *) probe --dir "$2" || exit 1 ;;
      esac
      shift 2 ;;
    --) break ;;
    *) shift ;;
  esac
done
exit 1
`

describe.skipIf(process.platform === 'win32')('Linux launcher qualification with stand-in launchers', () => {
  let directory = '', previousTmp: string | undefined
  beforeAll(async () => {
    directory = await realpath(await mkdtemp(path.join(tmpdir(), 'TEST-launcher-qualification-')))
    previousTmp = process.env.TMPDIR
    process.env.TMPDIR = directory
  })
  afterAll(async () => {
    if (previousTmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previousTmp
    await rm(directory, { recursive: true, force: true })
  })
  async function launcher(mode: string): Promise<string> {
    const file = path.join(directory, `bwrap-${mode}`)
    await writeFile(file, fake(mode))
    await chmod(file, 0o755)
    return file
  }
  const qualify = async (mode: string) => qualifyLinuxLauncher(await launcher(mode), `TEST-${mode}-${randomUUID()}`)
  const probeLeftovers = async () => (await readdir(directory)).filter(name => name.startsWith('opencode-v2-launcher-'))

  test('a fixed launcher qualifies and leaves no probe directory behind', async () => {
    await expect(qualify('fixed')).resolves.toBeUndefined()
    expect(await probeLeftovers()).toEqual([])
  })
  test('a launcher that follows the symlink while creating a mount point is refused', async () => {
    await expect(qualify('vulnerable')).rejects.toThrow('execution_containment_launcher_unsafe')
    expect(await probeLeftovers()).toEqual([])
  })
  // Each mount point kind is probed on its own: dropping any case lets its stand-in qualify.
  for (const kind of ['dir', 'bind', 'file', 'leaf']) {
    test(`a launcher vulnerable only for the ${kind} mount point is refused`, async () => {
      await expect(qualify(`${kind}-only`)).rejects.toThrow('execution_containment_launcher_unsafe')
    })
  }
  test('a launcher that cannot build the sandbox is refused', async () => {
    await expect(qualify('denied')).rejects.toThrow('execution_containment_launcher_denied')
  })
  test('a probe killed at its deadline fails closed', async () => {
    await expect(qualify('slow')).rejects.toThrow('execution_containment_launcher_denied')
    expect(await probeLeftovers()).toEqual([])
  }, 20_000)
  test('a launcher below the version floor is refused before it is probed', async () => {
    await expect(qualify('old')).rejects.toThrow('execution_containment_launcher_unsupported')
  })
})
