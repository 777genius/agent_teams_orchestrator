import { describe, expect, test } from 'bun:test'
import path from 'node:path'

import {
  CLAUDE_MULTIMODEL_CACHE_HOME_ENV,
  CLAUDE_MULTIMODEL_DATA_HOME_ENV,
  resolveClaudeMultimodelPaths,
} from './OpenCodeManagedPaths.js'

describe('OpenCode managed path resolution', () => {
  test('resolves every managed alias from the supplied environment snapshot', () => {
    const home = path.join(path.sep, 'snapshot', 'home')
    const xdgData = path.join(path.sep, 'snapshot', 'data')
    const xdgConfig = path.join(path.sep, 'snapshot', 'config')
    const xdgCache = path.join(path.sep, 'snapshot', 'cache')
    const tmp = path.join(path.sep, 'snapshot', 'tmp')
    const managedData = path.join(path.sep, 'snapshot', 'managed-data')
    const managedCache = path.join(path.sep, 'snapshot', 'managed-cache')
    const resolved = resolveClaudeMultimodelPaths({
      HOME: home,
      USERPROFILE: path.join(path.sep, 'ignored-user-profile'),
      XDG_DATA_HOME: xdgData,
      XDG_CONFIG_HOME: xdgConfig,
      XDG_CACHE_HOME: xdgCache,
      TMPDIR: tmp,
      [CLAUDE_MULTIMODEL_DATA_HOME_ENV]: managedData,
      [CLAUDE_MULTIMODEL_CACHE_HOME_ENV]: managedCache,
    })

    expect(resolved.data).toBe(managedData)
    expect(resolved.cache).toBe(managedCache)
    if (process.platform !== 'win32' && process.platform !== 'darwin') {
      expect(resolved.config).toBe(path.join(xdgConfig, 'claude-multimodel-nodejs'))
      expect(resolved.temp).toBe(path.join(tmp, path.basename(home), 'claude-multimodel-nodejs'))
    }
  })
})
