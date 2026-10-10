import { test, expect } from 'bun:test'
import path from 'node:path'
import { createOpenCodeV2OwnedProfileEnvironment } from './OpenCodeV2LaunchPlan.js'
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
  expect(env.PATH).toBe([path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter))
})
