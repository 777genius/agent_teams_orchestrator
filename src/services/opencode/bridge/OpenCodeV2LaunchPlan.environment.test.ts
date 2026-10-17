import { test, expect } from 'bun:test'
import path from 'node:path'
import { assertOpenCodeV2SupervisorEnvironment, createOpenCodeV2OwnedProfileEnvironment,
  createOpenCodeV2SupervisorEnvironment } from './OpenCodeV2LaunchPlan.js'
import { privateOpenCodeReadEnvironment } from '../profile/OpenCodeV2ManagedConfig.js'

test('native-owned catalog and execution profiles meet planner loader fence while shared read environment stays unchanged', () => {
  const root = '/TEST/private-native-profile'
  expect(privateOpenCodeReadEnvironment(root).NODE_ENV).toBe('production')
  const env = createOpenCodeV2OwnedProfileEnvironment(root)
  expect(Object.keys(env).filter(key => /^(?:NODE_.*|BUN_.*|LD_.*|DYLD_.*|BASH_ENV|ENV|SHELLOPTS|ZDOTDIR)$/i.test(key))).toEqual([])
  expect(env.HOME).toBe(root + '/home'); expect(env.USERPROFILE).toBe(root + '/home')
  expect(env.XDG_CONFIG_HOME).toBe(root + '/config'); expect(env.XDG_DATA_HOME).toBe(root + '/data')
  expect(env.XDG_CACHE_HOME).toBe(root + '/cache'); expect(env.XDG_STATE_HOME).toBe(root + '/state')
  expect(env.TMPDIR).toBe(root + '/tmp'); expect(env.APPDATA).toBe(root + '/appdata')
  expect(env.LOCALAPPDATA).toBe(root + '/localappdata'); expect(env.NO_COLOR).toBe('1')
  expect(env.OPENSSL_CONF).toBe(process.platform === 'darwin' ? '/dev/null' : undefined)
  expect(env.PATH).toBe([path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter))
})

test('Windows supervisor replacement retains only case-deduplicated trusted native broker paths', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    const env = createOpenCodeV2SupervisorEnvironment({
      PATH: 'C:\\Program Files\\nodejs', Path: 'C:\\Program Files\\nodejs',
      HOME: '/TEST/home', USER: 'tester', LOGNAME: 'tester', TMPDIR: '/TEST/tmp', LANG: 'C', LC_ALL: 'C',
      LocalAppData: 'C:\\Users\\tester\\AppData\\Local', LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
      SystemRoot: 'C:\\Windows', SYSTEMROOT: 'C:\\Windows', WINDIR: 'C:\\Windows',
      NODE_OPTIONS: '--require /TEST/inject.js', BUN_OPTIONS: '--preload /TEST/inject.js',
      UNTRUSTED_WINDOWS_VALUE: 'C:\\TEST\\foreign',
    })
    expect(env).toEqual({
      PATH: 'C:\\Program Files\\nodejs', HOME: '/TEST/home', USER: 'tester', LOGNAME: 'tester',
      TMPDIR: '/TEST/tmp', LANG: 'C', LC_ALL: 'C', LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
      SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows',
    })
    expect(env.NODE_OPTIONS).toBeUndefined(); expect(env.BUN_OPTIONS).toBeUndefined()
    expect(env.UNTRUSTED_WINDOWS_VALUE).toBeUndefined()
    for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'BUN_OPTIONS', 'BUN_CONFIG_VERBOSE_FETCH'])
      expect(() => assertOpenCodeV2SupervisorEnvironment({ ...env, [key]: '/TEST/injected' }))
        .toThrow('run_environment_injection')
    expect(() => createOpenCodeV2SupervisorEnvironment({ LOCALAPPDATA: 'C:relative\\AppData\\Local' }))
      .toThrow('run_environment_path_invalid')
    expect(() => createOpenCodeV2SupervisorEnvironment({ SystemRoot: 'C:\\Windows', SYSTEMROOT: 'D:\\Windows' }))
      .toThrow('run_environment_alias')
  } finally { Object.defineProperty(process, 'platform', platform) }
})

test('Unix supervisor replacement preserves exact case-sensitive environment names without promoting aliases', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  try {
    for (const value of ['linux', 'darwin']) {
      Object.defineProperty(process, 'platform', { ...platform, value })
      expect(createOpenCodeV2SupervisorEnvironment({
        PATH: '/TEST/bin', Path: '/TEST/foreign', HOME: '/TEST/home', home: '/TEST/foreign',
        USER: 'tester', LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
        SYSTEMROOT: 'C:\\Windows', WINDIR: 'C:\\Windows',
      })).toEqual({ PATH: '/TEST/bin', HOME: '/TEST/home', USER: 'tester' })
      expect(createOpenCodeV2SupervisorEnvironment({ Path: '/TEST/foreign', home: '/TEST/foreign' })).toEqual({})
    }
  } finally { Object.defineProperty(process, 'platform', platform) }
})
