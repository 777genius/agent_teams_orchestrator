import { lstat, mkdtemp, mkdir, readFile, readlink, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { afterEach, beforeEach, describe, expect, mock, setDefaultTimeout, spyOn, test } from 'bun:test'

import {
  buildCursorAgentPreloadRequireOption,
  buildCursorAgentPreloadScript,
  buildManagedConfig,
  buildManagedConfigFingerprint,
  collectProjectBehaviorMetadata,
  ensureOpenCodeCursorPluginAuthCredential,
  ensureOpenCodeKiroPluginAuthCredential,
  ensureOpenCodeNativeCliCredentialBridge,
  applyCursorManagedExecutionEnvironment,
  buildCursorHostGeneration,
  CURSOR_PRELOAD_DISABLED_ENV,
  ensureOpenCodeNativePluginAuthCredentials,
  isKiroCliWhoamiAuthenticated,
  OpenCodeProfileManager,
  orderOpenCodeAuthSyncSources,
  resolveOpenCodeProfileScope,
  ensureSelectedOpenCodeModelInImportedConfig,
} from './OpenCodeProfileManager.js'
import {
  PROCESS_ATTRIBUTION_DIRECTORY_ENV,
  PROCESS_ATTRIBUTION_ID_ENV,
  mintProcessAttributionId,
  readAttributionRecords,
} from './OpenCodeProcessAttributionStore.js'
import { buildCursorAgentResourceExhaustedPreloadScript } from './OpenCodeCursorResourceExhaustedPatch.js'
import { resolveOpenCodeAppMcpLaunchConfig } from './OpenCodeMcpManager.js'
import { applyOpenCodeAutoUpdatePolicy } from './OpenCodeAutoUpdatePolicy.js'
import {
  readOpenCodeAuthCredential,
  upsertOpenCodeAuthCredential,
} from './OpenCodeAuthStore.js'
import {
  setOpenCodeManagedDefaultModel,
  setOpenCodeManagedGlobalDefaultModel,
  setOpenCodeManagedModelLimits,
} from './OpenCodeManagedPreferences.js'
import {
  CLAUDE_MULTIMODEL_CACHE_HOME_ENV,
  CLAUDE_MULTIMODEL_DATA_HOME_ENV,
} from './OpenCodeManagedPaths.js'

setDefaultTimeout(30_000)

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/')
}

async function runBunScript(
  scriptPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`script exited with code ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    })
  })
}

async function runCommandCapture(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) {
        resolve(stdout)
        return
      }
      reject(new Error(`command exited with code ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`))
    })
  })
}

describe('OpenCodeProfileManager project behavior contract', () => {
  let tempDir: string
  const isolatedEnvKeys = [
    'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME',
    'PATH', 'CURSOR_ACP_HOME_DIR',
    CLAUDE_MULTIMODEL_DATA_HOME_ENV, CLAUDE_MULTIMODEL_CACHE_HOME_ENV,
    'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND',
    'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON',
    'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON',
    'CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL',
  ] as const
  const originalEnv = Object.fromEntries(isolatedEnvKeys.map(key => [key, process.env[key]]))

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), 'opencode-profile-'))
    process.env.HOME = path.join(tempDir, 'home')
    process.env.USERPROFILE = process.env.HOME
    process.env.XDG_CONFIG_HOME = path.join(tempDir, 'xdg-config')
    process.env.XDG_DATA_HOME = path.join(tempDir, 'xdg-data')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = path.join(tempDir, 'app-data')
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = path.join(tempDir, 'app-cache')
    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND = process.execPath
    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON = JSON.stringify([
      '-e', 'process.stdin.resume()',
    ])
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
    for (const key of isolatedEnvKeys) {
      const value = originalEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  test('isolates scoped profile roots by normalized project, purpose, provider, and config', async () => {
    const manager = new OpenCodeProfileManager()
    const projectPath = path.join(tempDir, 'project')
    await mkdir(projectPath, { recursive: true })
    const prepare = async (
      purpose: 'catalog' | 'execution_probe' | 'launch_runtime',
      providerId: string,
      configFingerprint: string,
    ) => {
      const profileScope = await resolveOpenCodeProfileScope({
        projectPath,
        purpose,
        selectedModel: `${providerId}/model`,
        env: {
          ...process.env,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({
            provider: { [providerId.toLowerCase()]: { options: {
              route: configFingerprint,
              apiKey: `${providerId.toLowerCase()}-static-key`,
            } } },
          }),
        },
      })
      return manager.prepareProfile(path.join(projectPath, '.'), {
        profileScope,
      })
    }

    const catalog = await prepare('catalog', 'DeepInfra', 'config-a')
    const sameCatalog = await prepare('catalog', 'deepinfra', 'config-a')
    const probe = await prepare('execution_probe', 'deepinfra', 'config-a')
    const provider = await prepare('catalog', 'openrouter', 'config-a')
    const config = await prepare('catalog', 'deepinfra', 'config-b')
    await expect(prepare('launch_runtime', 'kiro', 'config-a'))
      .rejects.toThrow('does not support extension-bound provider kiro')
    await expect(prepare('execution_probe', 'cursor-acp', 'config-a'))
      .rejects.toThrow('does not support extension-bound provider cursor-acp')
    const customCatalog = await prepare('catalog', 'custom-provider', 'config-a')
    const legacy = await manager.prepareProfile(projectPath, {
      includeAppMcp: false,
      includeManagedSubscriptionPlugins: false,
    })

    expect(sameCatalog.profileRootPath).toBe(catalog.profileRootPath)
    expect(new Set([
      catalog.profileRootPath,
      probe.profileRootPath,
      provider.profileRootPath,
      config.profileRootPath,
      customCatalog.profileRootPath,
      legacy.profileRootPath,
    ]).size).toBe(6)
  })

  test('prepares and retries an existing workspace despite Windows mkdir EEXIST', async () => {
    const fs = await import('node:fs/promises')
    const projectPath = await realpath(await mkdtemp(path.join(tempDir, 'existing-project-')))
    const markerPath = path.join(projectPath, 'keep.txt')
    await writeFile(markerPath, 'existing project content')
    const originalMkdir = fs.mkdir
    const mkdirSpy = spyOn(fs, 'mkdir').mockImplementation((async (...args: Parameters<typeof fs.mkdir>) => {
      const [directory, options] = args
      if (String(directory) === projectPath) {
        throw Object.assign(new Error('Windows ReadOnly directory'), {
          code: 'EEXIST', syscall: 'mkdir', path: projectPath,
        })
      }
      return originalMkdir(directory, options)
    }) as typeof fs.mkdir)
    try {
      const manager = new OpenCodeProfileManager()
      for (let attempt = 0; attempt < 2; attempt++) {
        const profile = await manager.prepareProfile(projectPath, {
          includeAppMcp: false,
          includeManagedSubscriptionPlugins: false,
        })
        expect(profile.workingDirectoryPath).toBe(projectPath)
      }
      expect(await readFile(markerPath, 'utf8')).toBe('existing project content')
      expect(mkdirSpy.mock.calls.some(([directory]) => String(directory) === projectPath)).toBe(false)
    } finally {
      mkdirSpy.mockRestore()
    }
  })

  test('reports fixed preparation substeps and closes each step exactly once', async () => {
    const labels: string[] = []
    const closed: string[] = []
    let active: string | null = null
    const progress = {
      enterStep(label: string) {
        expect(active).toBeNull()
        active = label
        labels.push(label)
        return () => {
          expect(active).toBe(label)
          closed.push(label)
          active = null
        }
      },
    }
    await new OpenCodeProfileManager().prepareProfile(path.join(tempDir, 'progress-project'), {
      includeAppMcp: false,
      includeManagedSubscriptionPlugins: false,
      progress,
    })
    expect(labels).toEqual([
      'resolve project and scope',
      'wait for profile preparation lock',
      'fingerprint project behavior',
      'read preferences and build config',
      'fingerprint auth sources',
      'create profile directories',
      'coordinate shared node_modules',
      'wait for node_modules symlink lock',
      'reconcile managed auth stores',
      'verify auth and finalize environment',
    ].map(label => `prepare managed OpenCode profile: ${label}`))
    expect(closed).toEqual(labels)
    expect(active).toBeNull()

    const controller = new AbortController()
    controller.abort(new Error('test preparation deadline'))
    await expect(new OpenCodeProfileManager().prepareProfile(tempDir, {
      abortSignal: controller.signal,
      progress,
    })).rejects.toThrow('test preparation deadline')
    expect(closed).toEqual(labels)
    expect(active).toBeNull()
  })

  for (const providerId of ['cursor-acp', 'kiro'] as const) {
    test(`does not treat an aborted ${providerId} probe as logout or update credentials`, async () => {
      const authPath = path.join(tempDir, 'cancelled-auth.json')
      const credential = providerId === 'kiro'
        ? { type: 'oauth', access: 'authenticated', refresh: '', expires: 1 }
        : { type: 'api', key: 'cursor-agent', expires: 1 }
      await upsertOpenCodeAuthCredential({ authPath, providerId, credential })
      const controller = new AbortController()
      const reason = new Error('inventory deadline expired')
      const probe = async (_executable: string, _platform: NodeJS.Platform, signal?: AbortSignal) => {
        expect(signal).toBe(controller.signal)
        controller.abort(reason)
        return false
      }
      const input = {
        globalAuthPath: authPath,
        managedAuthPath: authPath,
        abortSignal: controller.signal,
        probe,
      }
      const result = providerId === 'kiro'
        ? ensureOpenCodeKiroPluginAuthCredential({ ...input, kiroCliExecutablePath: 'unused' })
        : ensureOpenCodeCursorPluginAuthCredential({ ...input, cursorAgentExecutablePath: 'unused' })
      await expect(result).rejects.toBe(reason)
      expect(await readOpenCodeAuthCredential({ authPath, providerId })).toEqual(credential)
    })
  }

  test('fingerprints effective selected-provider endpoints without secret material', async () => {
    const projectPath = path.join(tempDir, 'fingerprint-project')
    await mkdir(projectPath, { recursive: true })
    const scope = (baseURL: string, apiKey: string) => resolveOpenCodeProfileScope({
      projectPath,
      purpose: 'catalog',
      selectedModel: 'custom/model',
      env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: { custom: { options: { baseURL, apiKey } } },
      }) },
    })
    const first = await scope('https://one.example/v1', 'secret-one')
    const secretChanged = await scope('https://one.example/v1', 'secret-two')
    const endpointChanged = await scope('https://two.example/v1', 'secret-one')

    expect(secretChanged.configFingerprint).not.toBe(first.configFingerprint)
    expect(endpointChanged.configFingerprint).not.toBe(first.configFingerprint)
    const manager = new OpenCodeProfileManager()
    const [firstProfile, secretProfile, endpointProfile] = await Promise.all([
      manager.prepareProfile(projectPath, { profileScope: first }),
      manager.prepareProfile(projectPath, { profileScope: secretChanged }),
      manager.prepareProfile(projectPath, { profileScope: endpointChanged }),
    ])
    expect(secretProfile.profileRootPath).not.toBe(firstProfile.profileRootPath)
    expect(endpointProfile.profileRootPath).not.toBe(firstProfile.profileRootPath)
  })

  test('keeps selected-provider scope stable across processes and unrelated credential rotation', async () => {
    const projectPath = path.join(tempDir, 'cross-process-project')
    await mkdir(projectPath, { recursive: true })
    const authPath = path.join(process.env.XDG_DATA_HOME!, 'opencode', 'auth.json')
    await mkdir(path.dirname(authPath), { recursive: true })
    const moduleUrl = pathToFileURL(path.join(
      process.cwd(), 'src/services/opencode/OpenCodeProfileManager.ts',
    )).href
    const script = [
      `const {resolveOpenCodeProfileScope:r}=await import(${JSON.stringify(moduleUrl)});`,
      'const s=await r({projectPath:process.argv[1],purpose:"launch_runtime",',
      'selectedModel:process.argv[2],env:{...process.env,OPENCODE_CONFIG_CONTENT:process.argv[3]}});',
      'console.log(JSON.stringify({config:s.configFingerprint,auth:s.selectedAuthIdentity,scope:s.scopeToken}))',
    ].join('')
    const run = async (
      provider: string,
      secret: unknown,
      effectiveEnv: NodeJS.ProcessEnv = {},
    ) => JSON.parse(
      await runCommandCapture(process.execPath, [
        '-e', script, projectPath, `${provider}/model`, JSON.stringify({
          provider: { [provider]: { options: { apiKey: secret } } },
        }),
      ], { ...process.env, ...effectiveEnv }),
    ) as { config: string; auth: string; scope: string }
    await writeFile(authPath, JSON.stringify({
      deepinfra: { type: 'api', key: 'selected-auth-secret' },
    }))
    const first = await run('deepinfra', 'config-secret')
    const second = await run('deepinfra', 'config-secret')
    const valueChanged = await run('deepinfra', 'other-config-secret')
    const typeChanged = await run('deepinfra', 7)
    const providerChanged = await run('custom', 'config-secret')
    await writeFile(authPath, JSON.stringify({
      deepinfra: { type: 'api', key: 'changed-auth-secret' },
    }))
    const authChanged = await run('deepinfra', 'config-secret')
    const envName = ['PROFILE', 'IDENTITY', 'A'].join('_')
    const envReference = `{env:${envName}}`
    const envValue = randomBytes(32).toString('hex')
    const envFirst = await run('deepinfra', envReference, { [envName]: envValue })
    const envSecond = await run('deepinfra', envReference, { [envName]: envValue })
    const rotatedEnvValue = randomBytes(32).toString('hex')
    const envRotated = await run('deepinfra', envReference, {
      [envName]: rotatedEnvValue,
    })
    const unrelatedCredentialFirst = await run('deepinfra', 'config-secret', {
      OPENAI_API_KEY: randomBytes(32).toString('hex'),
    })
    const unrelatedCredentialRotated = await run('deepinfra', 'config-secret', {
      OPENAI_API_KEY: randomBytes(32).toString('hex'),
    })
    const selectedCredentialFirst = await run('deepinfra', 'config-secret', {
      DEEPINFRA_API_KEY: randomBytes(32).toString('hex'),
    })
    const selectedCredentialRotated = await run('deepinfra', 'config-secret', {
      DEEPINFRA_API_KEY: randomBytes(32).toString('hex'),
    })

    expect(second).toEqual(first)
    expect(valueChanged.config).not.toBe(first.config)
    expect(valueChanged.scope).not.toBe(first.scope)
    expect(typeChanged.config).not.toBe(first.config)
    expect(providerChanged.config).not.toBe(first.config)
    expect(providerChanged.auth).not.toBe(first.auth)
    expect(authChanged.auth).not.toBe(first.auth)
    expect(authChanged.scope).not.toBe(first.scope)
    expect(envSecond.config).toBe(envFirst.config)
    expect(envRotated.config).not.toBe(envFirst.config)
    expect(unrelatedCredentialRotated.config).toBe(unrelatedCredentialFirst.config)
    expect(unrelatedCredentialRotated.scope).toBe(unrelatedCredentialFirst.scope)
    expect(selectedCredentialRotated.config).not.toBe(selectedCredentialFirst.config)
    expect(selectedCredentialRotated.scope).not.toBe(selectedCredentialFirst.scope)
    const output = JSON.stringify([
      first, second, valueChanged, typeChanged, providerChanged, authChanged,
      envFirst, envSecond, envRotated, unrelatedCredentialFirst, unrelatedCredentialRotated,
      selectedCredentialFirst, selectedCredentialRotated,
    ])
    expect(output).not.toContain('secret')
    expect(output).not.toContain(envName)
    expect(output).not.toContain(envValue)
    expect(output).not.toContain(rotatedEnvValue)
  }, 60_000)

  test('binds semantic config identity to effective secret environment references', async () => {
    const projectPath = path.join(tempDir, 'env-secret-identity-project')
    await mkdir(projectPath, { recursive: true })
    const resolve = (
      reference: string,
      env: NodeJS.ProcessEnv,
      providerId = 'deepinfra',
      credentialPath: 'apiKey' | 'authorization' = 'apiKey',
    ) => resolveOpenCodeProfileScope({
      projectPath,
      purpose: 'launch_runtime',
      selectedModel: `${providerId}/model`,
      env: {
        ...process.env,
        ...env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          provider: { [providerId]: { options: credentialPath === 'apiKey'
            ? { apiKey: reference }
            : { authorization: reference } } },
        }),
      },
    })
    const envName = ['PROFILE', 'IDENTITY', 'A'].join('_')
    const otherEnvName = ['PROFILE', 'IDENTITY', 'B'].join('_')
    const value = randomBytes(32).toString('hex')
    const rotatedValue = randomBytes(32).toString('hex')
    const reference = `{env:${envName}}`
    const first = await resolve(reference, { [envName]: value })
    const same = await resolve(reference, { [envName]: value })
    const rotated = await resolve(reference, { [envName]: rotatedValue })
    const renamed = await resolve(`{env:${otherEnvName}}`, { [otherEnvName]: value })
    const shellSyntax = await resolve(`\${${envName}}`, { [envName]: value })
    const literal = await resolve(value, {})
    const providerChanged = await resolve(reference, { [envName]: value }, 'custom')
    const pathChanged = await resolve(reference, { [envName]: value }, 'deepinfra', 'authorization')
    await expect(resolve(reference, {}))
      .rejects.toThrow('strict profile authority source is unavailable')
    await expect(resolve(reference, { [envName]: '' }))
      .rejects.toThrow('strict profile authority source is unavailable')

    expect(same.configFingerprint).toBe(first.configFingerprint)
    for (const changed of [
      rotated, renamed, shellSyntax, literal, providerChanged, pathChanged,
    ]) {
      expect(changed.configFingerprint).not.toBe(first.configFingerprint)
    }
    await writeFile(path.join(projectPath, 'opencode.json'), JSON.stringify({
      provider: { deepinfra: { options: { apiKey: reference } } },
    }))
    const errorEnv = new Proxy<NodeJS.ProcessEnv>({}, {
      get: (_target, key) => {
        if (key === envName) throw new Error('lookup failed')
        return undefined
      },
    })
    const missingBehavior = await collectProjectBehaviorMetadata(projectPath, {})
    const errorBehavior = await collectProjectBehaviorMetadata(projectPath, errorEnv)
    expect(errorBehavior.projectBehaviorFingerprint).not.toBe(missingBehavior.projectBehaviorFingerprint)
    const output = JSON.stringify([
      first, same, rotated, renamed, shellSyntax, literal, providerChanged, pathChanged,
      missingBehavior, errorBehavior,
    ])
    expect(output).not.toContain(envName)
    expect(output).not.toContain(otherEnvName)
    expect(output).not.toContain(value)
    expect(output).not.toContain(rotatedValue)
  })

  test('content-fingerprints credential files for catalog identity but never strict authority', async () => {
    const projectPath = path.join(tempDir, 'credential-file-project')
    const credentialPath = path.join(tempDir, 'selected-credential.json')
    const envName = 'SELECTED_PROVIDER_CREDENTIAL_FILE'
    await mkdir(projectPath, { recursive: true })
    const resolve = (purpose: 'catalog' | 'execution_probe' | 'launch_runtime') => resolveOpenCodeProfileScope({
      projectPath,
      purpose,
      selectedModel: 'custom/model',
      env: {
        [envName]: credentialPath,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          provider: { custom: { options: { transport: { credentialFile: `{env:${envName}}` } } } },
        }),
      },
    })
    await writeFile(credentialPath, JSON.stringify({ token: 'file-secret-one' }))
    const first = await resolve('catalog')
    const same = await resolve('catalog')
    await expect(resolve('execution_probe'))
      .rejects.toThrow('strict profile authority source is unavailable')
    await expect(resolve('launch_runtime'))
      .rejects.toThrow('strict profile authority source is unavailable')
    await writeFile(credentialPath, JSON.stringify({ token: 'file-secret-two' }))
    const rotated = await resolve('catalog')
    await rm(credentialPath)

    expect(same).toEqual(first)
    expect(rotated.configFingerprint).not.toBe(first.configFingerprint)
    expect(rotated.scopeToken).not.toBe(first.scopeToken)
    await expect(resolve('launch_runtime')).rejects.toThrow('strict profile authority source is unavailable')
    await writeFile(credentialPath, Buffer.alloc(1024 * 1024 + 1))
    await expect(resolve('launch_runtime')).rejects.toThrow('strict profile authority source is unavailable')
    const output = JSON.stringify([first, rotated])
    expect(output).not.toContain(credentialPath)
    expect(output).not.toContain('file-secret')
  })

  test('fails strict ambient providers closed without explicit bound credentials', async () => {
    const projectPath = path.join(tempDir, 'ambient-provider-project')
    const googlePath = path.join(tempDir, 'google.json')
    await mkdir(projectPath, { recursive: true })
    const resolve = (providerId: string, env: NodeJS.ProcessEnv, purpose = 'launch_runtime' as const) =>
      resolveOpenCodeProfileScope({
        projectPath,
        purpose,
        selectedModel: `${providerId}/model`,
        env: {
          ...process.env,
          ...env,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { [providerId]: {} } }),
        },
      })

    await expect(resolve('amazon-bedrock', {}))
      .rejects.toThrow('requires explicit selected authentication')
    const selectedAuthPath = path.join(process.env.XDG_DATA_HOME!, 'opencode', 'auth.json')
    await mkdir(path.dirname(selectedAuthPath), { recursive: true })
    await writeFile(selectedAuthPath, JSON.stringify({
      'amazon-bedrock': { type: 'api', key: 'selected-store-key' },
    }))
    const selectedAuth = await resolveOpenCodeProfileScope({
      projectPath, purpose: 'launch_runtime', selectedModel: 'amazon-bedrock/model',
      env: {
        ...process.env,
        XDG_DATA_HOME: process.env.XDG_DATA_HOME,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { 'amazon-bedrock': {} } }),
      },
    })
    expect(selectedAuth.selectedAuthIdentity).toStartWith('known:')
    await rm(selectedAuthPath)
    const aws = await resolve('amazon-bedrock', {
      AWS_ACCESS_KEY_ID: 'access-key-one',
      AWS_SECRET_ACCESS_KEY: 'secret-key-one',
    })
    const awsRotated = await resolve('amazon-bedrock', {
      AWS_ACCESS_KEY_ID: 'access-key-one',
      AWS_SECRET_ACCESS_KEY: 'secret-key-two',
    })
    expect(awsRotated.scopeToken).not.toBe(aws.scopeToken)
    const awsConfigTuple = await resolveOpenCodeProfileScope({
      projectPath, purpose: 'execution_probe', selectedModel: 'amazon-bedrock/model',
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: { 'amazon-bedrock': { options: {
          accessKeyId: 'config-access-key', secretAccessKey: 'config-secret-key',
        } } },
      }) },
    })
    expect(awsConfigTuple.scopeToken).toMatch(/^[a-f0-9]{64}$/)

    await writeFile(googlePath, JSON.stringify({ type: 'authorized_user', refresh_token: 'secret' }))
    await expect(resolve('google-vertex', { GOOGLE_APPLICATION_CREDENTIALS: googlePath }))
      .rejects.toThrow('strict profile authority source is unavailable')
    await writeFile(googlePath, JSON.stringify({ type: 'service_account', private_key: 'secret' }))
    await expect(resolve('google-vertex', { GOOGLE_APPLICATION_CREDENTIALS: googlePath }))
      .rejects.toThrow('strict profile authority source is unavailable')
    await expect(resolveOpenCodeProfileScope({
      projectPath, purpose: 'execution_probe', selectedModel: 'google-vertex/model',
      env: {
        GOOGLE_CONFIG_FILE: googlePath,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: {
          'google-vertex': { options: { credentialsFile: '{env:GOOGLE_CONFIG_FILE}' } },
        } }),
      },
    })).rejects.toThrow('strict profile authority source is unavailable')

    const azure = await resolve('azure', { AZURE_API_KEY: 'azure-key-one' })
    expect(azure.scopeToken).toMatch(/^[a-f0-9]{64}$/)
    const catalog = await resolveOpenCodeProfileScope({
      projectPath, purpose: 'catalog', selectedModel: 'amazon-bedrock/model', env: {},
    })
    expect(catalog.selectedAuthIdentity).toBe('absent')
    expect(JSON.stringify([
      selectedAuth, aws, awsRotated, awsConfigTuple, azure, catalog,
    ])).not.toContain('secret')
    expect(JSON.stringify([azure])).not.toContain(googlePath)
  })

  test('binds explicit exact-model authority for built-in-free and configured authless routes', async () => {
    const projectPath = path.join(tempDir, 'strict-authless-authority-project')
    await mkdir(projectPath, { recursive: true })
    const resolve = (
      selectedModel: string,
      purpose: 'execution_probe' | 'launch_runtime',
      config: Record<string, unknown> = {},
    ) => resolveOpenCodeProfileScope({
      projectPath,
      purpose,
      selectedModel,
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
      },
    })

    const builtin = await resolve('opencode/big-pickle', 'execution_probe')
    const builtinSame = await resolve('opencode/big-pickle', 'execution_probe')
    const builtinLaunch = await resolve('opencode/big-pickle', 'launch_runtime')
    const currentBuiltinLaunch = await resolve(
      'opencode/nemotron-3.5-lightning-free',
      'launch_runtime',
    )
    await expect(resolve('opencode/BIG-PICKLE', 'execution_probe'))
      .rejects.toThrow('requires explicit selected authentication')
    await expect(resolve('opencode/BIG-PICKLE', 'launch_runtime'))
      .rejects.toThrow('requires explicit selected authentication')
    const ollama = await resolve('ollama/qwen3:8b', 'execution_probe')
    const ollamaOtherModel = await resolve('ollama/llama3.2:3b', 'execution_probe')
    const loopback = await resolve('custom-local/exact-model', 'execution_probe', {
      provider: {
        'custom-local': {
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: 'http://127.0.0.1:11434/v1' },
        },
      },
    })
    const authPath = path.join(process.env.XDG_DATA_HOME!, 'opencode', 'auth.json')
    await mkdir(path.dirname(authPath), { recursive: true })
    await writeFile(authPath, JSON.stringify({
      opencode: { type: 'api', key: 'selected-built-in-key' },
    }))
    const credentialBacked = await resolve('opencode/big-pickle', 'execution_probe')

    expect(builtinSame).toEqual(builtin)
    expect(builtin.selectedAuthIdentity).toBe('absent')
    expect(currentBuiltinLaunch.selectedAuthIdentity).toBe('absent')
    expect(ollama.selectedAuthIdentity).toBe('absent')
    expect(loopback.selectedAuthIdentity).toBe('absent')
    expect(ollamaOtherModel.configFingerprint).not.toBe(ollama.configFingerprint)
    expect(ollamaOtherModel.scopeToken).not.toBe(ollama.scopeToken)
    expect(credentialBacked.selectedAuthIdentity).toMatch(/^known:[a-f0-9]{64}$/)
    expect(credentialBacked.configFingerprint).not.toBe(builtin.configFingerprint)
    expect(credentialBacked.scopeToken).not.toBe(builtin.scopeToken)
    expect(builtinLaunch.scopeToken).not.toBe(builtin.scopeToken)
  })

  test('does not let authless authority mask authenticated missing, invalid, or error auth state', async () => {
    const projectPath = path.join(tempDir, 'strict-authless-fail-closed-project')
    const authPath = path.join(process.env.XDG_DATA_HOME!, 'opencode', 'auth.json')
    await Promise.all([
      mkdir(projectPath, { recursive: true }),
      mkdir(path.dirname(authPath), { recursive: true }),
    ])
    const resolve = (selectedModel: string) => resolveOpenCodeProfileScope({
      projectPath,
      purpose: 'execution_probe',
      selectedModel,
      env: { ...process.env },
    })

    await expect(resolve('deepinfra/model'))
      .rejects.toThrow('requires explicit selected authentication')
    await expect(resolve('opencode/not-a-catalog-model-free'))
      .rejects.toThrow('requires explicit selected authentication')
    await writeFile(authPath, JSON.stringify({
      opencode: { type: 'api', key: '' },
      deepinfra: { type: 'oauth', access: '', refresh: '', token: '' },
    }))
    await expect(resolve('opencode/big-pickle'))
      .rejects.toThrow('requires explicit selected authentication')
    await expect(resolve('deepinfra/model'))
      .rejects.toThrow('requires explicit selected authentication')

    await rm(authPath)
    await mkdir(authPath)
    await expect(resolve('opencode/big-pickle'))
      .rejects.toThrow('selected authentication is unavailable')
  })

  test('rejects both extension-bound providers for both strict purposes despite near-marker credentials', async () => {
    const projectPath = path.join(tempDir, 'strict-authority-allowlist-project')
    const authPath = path.join(process.env.XDG_DATA_HOME!, 'opencode', 'auth.json')
    await Promise.all([mkdir(projectPath, { recursive: true }), mkdir(path.dirname(authPath), { recursive: true })])
    await writeFile(authPath, JSON.stringify({
      kiro: {
        type: 'oauth', access: 'authenticated', refresh: 'near-marker-refresh',
        expires: Date.now() + 60_000,
      },
      'cursor-acp': {
        type: 'api', key: 'cursor-agent-near-marker', expires: Date.now() + 60_000,
      },
    }))
    const strict = (providerId: string, purpose: 'execution_probe' | 'launch_runtime', env = {}) =>
      resolveOpenCodeProfileScope({
        projectPath,
        purpose,
        selectedModel: `${providerId}/model`,
        env: { ...process.env, ...env },
      })

    for (const providerId of ['kiro', 'cursor-acp']) {
      for (const purpose of ['execution_probe', 'launch_runtime'] as const) {
        await expect(strict(providerId, purpose))
          .rejects.toThrow(`does not support extension-bound provider ${providerId}`)
      }
    }
    await expect(strict('deepinfra', 'launch_runtime'))
      .rejects.toThrow('requires explicit selected authentication')

    const genericEnv = await strict('deepinfra', 'execution_probe', {
      DEEPINFRA_API_KEY: 'snapshot-generic-key',
    })
    const genericConfig = await resolveOpenCodeProfileScope({
      projectPath,
      purpose: 'launch_runtime',
      selectedModel: 'deepinfra/model',
      env: {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          provider: { deepinfra: { options: { authorization: 'snapshot-config-token' } } },
        }),
      },
    })
    expect(genericEnv.scopeToken).toMatch(/^[a-f0-9]{64}$/)
    expect(genericConfig.scopeToken).toMatch(/^[a-f0-9]{64}$/)
  })

  test('rejects regular, symlinked, and atomically replaced file paths as strict credentials', async () => {
    const projectPath = path.join(tempDir, 'file-authority-project')
    const credentialPath = path.join(tempDir, 'credential-value')
    const replacementPath = path.join(tempDir, 'credential-replacement')
    const symlinkPath = path.join(tempDir, 'credential-link')
    await mkdir(projectPath, { recursive: true })
    await writeFile(credentialPath, 'credential-one')
    await symlink(credentialPath, symlinkPath)
    const resolve = (value: string) => resolveOpenCodeProfileScope({
      projectPath,
      purpose: 'launch_runtime',
      selectedModel: 'azure/model',
      env: {
        AZURE_API_KEY: value,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { azure: {} } }),
      },
    })

    await expect(resolve(credentialPath))
      .rejects.toThrow('strict profile authority source is unavailable')
    await expect(resolve(symlinkPath))
      .rejects.toThrow('strict profile authority source is unavailable')
    await expect(resolveOpenCodeProfileScope({
      projectPath,
      purpose: 'launch_runtime',
      selectedModel: 'azure/model',
      env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({
        provider: { azure: { options: { apiKey: credentialPath } } },
      }) },
    })).rejects.toThrow('strict profile authority source is unavailable')
    await writeFile(replacementPath, 'credential-two')
    await rename(replacementPath, credentialPath)
    await expect(resolve(credentialPath))
      .rejects.toThrow('strict profile authority source is unavailable')
  })

  test('authorizes only exact runtime-consumed provider credential locations', async () => {
    const projectPath = path.join(tempDir, 'exact-provider-authority-project')
    await mkdir(projectPath, { recursive: true })
    const resolveBedrock = (providerId: string, provider: Record<string, unknown>, env = {}) =>
      resolveOpenCodeProfileScope({
        projectPath,
        purpose: 'launch_runtime',
        selectedModel: `${providerId}/model`,
        env: {
          ...process.env,
          ...env,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { [providerId]: provider } }),
        },
      })

    await expect(resolveBedrock('bedrock', {
      options: { nested: { apiKey: 'not-consumed' }, accessKeyId: 'incomplete' },
      metadata: { secretAccessKey: 'not-consumed' },
    })).rejects.toThrow('requires explicit selected authentication')
    await expect(resolveBedrock('aws-bedrock', {
      options: { nested: { accessKeyId: 'not-consumed', secretAccessKey: 'not-consumed' } },
    })).rejects.toThrow('requires explicit selected authentication')
    await expect(resolveBedrock('azure', {
      options: { nested: { apiKey: 'not-consumed' } },
    })).rejects.toThrow('requires explicit selected authentication')

    for (const providerId of ['amazon-bedrock', 'aws-bedrock', 'bedrock']) {
      const direct = await resolveBedrock(providerId, {}, {
        AWS_ACCESS_KEY_ID: 'direct-access',
        AWS_SECRET_ACCESS_KEY: 'direct-secret',
      })
      expect(direct.scopeToken).toMatch(/^[a-f0-9]{64}$/)
    }
    for (const providerId of ['azure', 'azure-openai']) {
      const direct = await resolveOpenCodeProfileScope({
        projectPath,
        purpose: 'launch_runtime',
        selectedModel: `${providerId}/model`,
        env: {
          ...process.env,
          AZURE_OPENAI_API_KEY: 'direct-azure-key',
          OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { [providerId]: {} } }),
        },
      })
      expect(direct.scopeToken).toMatch(/^[a-f0-9]{64}$/)
      const exactOptions = await resolveOpenCodeProfileScope({
        projectPath,
        purpose: 'execution_probe',
        selectedModel: `${providerId}/model`,
        env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({
          provider: { [providerId]: { options: { apiKey: 'test-fixture-literal' } } },
        }) },
      })
      expect(exactOptions.scopeToken).toMatch(/^[a-f0-9]{64}$/)
    }
    for (const providerId of ['google-vertex', 'vertex']) {
      await expect(resolveBedrock(providerId, {
        options: { apiKey: 'fixture-fixture-literal' },
      })).rejects.toThrow('requires explicit selected authentication')
    }
  })

  test('fingerprints but never authorizes arbitrary nested credential-named env references', async () => {
    const projectPath = path.join(tempDir, 'nested-provider-env-project')
    await mkdir(projectPath, { recursive: true })
    const resolve = (purpose: 'catalog' | 'launch_runtime', value: string) =>
      resolveOpenCodeProfileScope({
        projectPath,
        purpose,
        selectedModel: 'bedrock/model',
        env: {
          NESTED_PROVIDER_VALUE: value,
          OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { bedrock: {
            options: { nested: {
              apiKey: '{env:NESTED_PROVIDER_VALUE}',
              accessKeyId: '{env:NESTED_PROVIDER_VALUE}',
              secretAccessKey: '{env:NESTED_PROVIDER_VALUE}',
            } },
          } } }),
        },
      })

    await expect(resolve('launch_runtime', 'nested-value'))
      .rejects.toThrow('requires explicit selected authentication')
    const first = await resolve('catalog', 'nested-value')
    const rotated = await resolve('catalog', 'rotated-nested-value')
    expect(rotated.configFingerprint).not.toBe(first.configFingerprint)
    expect(JSON.stringify([first, rotated])).not.toContain('nested-value')
  })

  test('uses one immutable environment snapshot for authority and prepared runtime', async () => {
    const projectPath = path.join(tempDir, 'environment-snapshot-project')
    await mkdir(projectPath, { recursive: true })
    let reads = 0
    const changingEnv = {
      ...process.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { azure: {} } }),
    } as NodeJS.ProcessEnv
    Object.defineProperty(changingEnv, 'AZURE_API_KEY', {
      enumerable: true,
      get: () => ++reads === 1 ? 'snapshot-key' : undefined,
    })

    const scope = await resolveOpenCodeProfileScope({
      projectPath,
      purpose: 'launch_runtime',
      selectedModel: 'azure/model',
      env: changingEnv,
    })
    const prepared = await new OpenCodeProfileManager().prepareProfile(projectPath, {
      profileScope: scope,
      includeAppMcp: false,
    })

    expect(reads).toBe(1)
    expect(prepared.env.AZURE_API_KEY).toBe('snapshot-key')
    expect(prepared.profileScope?.scopeToken).toBe(scope.scopeToken)
  })

  test('freezes App MCP command, environment, and remote URL at launch scope resolution', async () => {
    const projectPath = path.join(tempDir, 'mcp-environment-snapshot-project')
    await mkdir(projectPath, { recursive: true })
    const baseEnv = {
      ...process.env,
      DEEPINFRA_API_KEY: 'snapshot-provider-key',
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: '/snapshot/mcp-node',
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON: JSON.stringify(['-e', 'snapshot-command']),
      CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON: JSON.stringify({ MCP_ROUTE: 'snapshot-route' }),
    }
    const localScope = await resolveOpenCodeProfileScope({
      projectPath, purpose: 'launch_runtime', selectedModel: 'deepinfra/model', env: baseEnv,
    })

    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND = '/mutated/mcp-node'
    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON = JSON.stringify(['-e', 'mutated-command'])
    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON = JSON.stringify({ MCP_ROUTE: 'mutated-route' })
    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL = 'https://mutated.example/mcp'
    const localProfile = await new OpenCodeProfileManager().prepareProfile(projectPath, {
      profileScope: localScope,
    })
    const localMcp = (localProfile.managedConfig.mcp as Record<string, Record<string, unknown>>)
      ['agent-teams']!
    expect(localProfile.appMcpLaunchSource).toBe('env-override')
    expect(localMcp.type).toBe('local')
    expect(localMcp.command).toEqual([
      '/snapshot/mcp-node', '-e', path.resolve('snapshot-command'),
    ])
    expect(localMcp.environment).toMatchObject({ MCP_ROUTE: 'snapshot-route' })

    const remoteScope = await resolveOpenCodeProfileScope({
      projectPath,
      purpose: 'launch_runtime',
      selectedModel: 'deepinfra/model',
      env: {
        ...baseEnv,
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'https://snapshot.example/mcp',
      },
    })
    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL = 'https://second-mutation.example/mcp'
    const remoteProfile = await new OpenCodeProfileManager().prepareProfile(projectPath, {
      profileScope: remoteScope,
    })
    const remoteMcp = (remoteProfile.managedConfig.mcp as Record<string, Record<string, unknown>>)
      ['agent-teams']!
    expect(remoteMcp).toMatchObject({ type: 'remote', url: 'https://snapshot.example/mcp' })
    expect(remoteScope.configFingerprint).not.toBe(localScope.configFingerprint)
    expect(remoteScope.scopeToken).not.toBe(localScope.scopeToken)
  })

  test('keeps catalog and execution-probe scoped profiles free of App MCP config', async () => {
    const projectPath = path.join(tempDir, 'scope-without-app-mcp-project')
    await mkdir(projectPath, { recursive: true })
    for (const purpose of ['catalog', 'execution_probe'] as const) {
      const scope = await resolveOpenCodeProfileScope({
        projectPath,
        purpose,
        selectedModel: 'deepinfra/model',
        env: {
          ...process.env,
          DEEPINFRA_API_KEY: 'scope-provider-key',
          CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'https://must-not-appear.example/mcp',
        },
      })
      const prepared = await new OpenCodeProfileManager().prepareProfile(projectPath, {
        profileScope: scope,
      })
      expect(prepared.managedConfig.mcp).toBeUndefined()
      expect(prepared.appMcpLaunchSource).toBeNull()
    }
  })

  test('binds resolved managed path identity into config and scope tokens', async () => {
    const projectPath = path.join(tempDir, 'managed-path-identity-project')
    await mkdir(projectPath, { recursive: true })
    const resolve = (suffix: string) => resolveOpenCodeProfileScope({
      projectPath,
      purpose: 'catalog',
      selectedModel: 'deepinfra/model',
      env: {
        ...process.env,
        [CLAUDE_MULTIMODEL_DATA_HOME_ENV]: path.join(tempDir, `data-${suffix}`),
        [CLAUDE_MULTIMODEL_CACHE_HOME_ENV]: path.join(tempDir, `cache-${suffix}`),
      },
    })
    const first = await resolve('one')
    const second = await resolve('two')
    expect(second.configFingerprint).not.toBe(first.configFingerprint)
    expect(second.scopeToken).not.toBe(first.scopeToken)
  })

  test('keeps scoped managed paths, PATH, home, and auth frozen after resolution', async () => {
    const projectPath = path.join(tempDir, 'frozen-path-project')
    const snapshotHome = path.join(tempDir, 'snapshot-home')
    const snapshotXdgData = path.join(tempDir, 'snapshot-xdg-data')
    const snapshotManagedData = path.join(tempDir, 'snapshot-managed-data')
    const snapshotManagedCache = path.join(tempDir, 'snapshot-managed-cache')
    const snapshotPath = path.join(tempDir, 'snapshot-bin')
    const snapshotCursorHome = path.join(tempDir, 'snapshot-cursor-home')
    const authPath = path.join(snapshotXdgData, 'opencode', 'auth.json')
    const snapshotConfigDir = path.join(snapshotHome, '.config', 'opencode')
    await Promise.all([
      mkdir(projectPath, { recursive: true }),
      mkdir(path.dirname(authPath), { recursive: true }),
      mkdir(snapshotConfigDir, { recursive: true }),
    ])
    await writeFile(authPath, JSON.stringify({
      deepinfra: { type: 'api', key: 'real-snapshot-provider-key' },
    }))
    await writeFile(path.join(snapshotConfigDir, 'opencode.json'), JSON.stringify({
      provider: { deepinfra: { options: { route: 'snapshot-home-route' } } },
    }))
    const scope = await resolveOpenCodeProfileScope({
      projectPath,
      purpose: 'launch_runtime',
      selectedModel: 'deepinfra/model',
      env: {
        ...process.env,
        HOME: snapshotHome,
        USERPROFILE: snapshotHome,
        XDG_DATA_HOME: snapshotXdgData,
        PATH: snapshotPath,
        CURSOR_ACP_HOME_DIR: snapshotCursorHome,
        [CLAUDE_MULTIMODEL_DATA_HOME_ENV]: snapshotManagedData,
        [CLAUDE_MULTIMODEL_CACHE_HOME_ENV]: snapshotManagedCache,
      },
    })

    process.env.HOME = path.join(tempDir, 'mutated-home')
    process.env.USERPROFILE = process.env.HOME
    process.env.XDG_DATA_HOME = path.join(tempDir, 'mutated-xdg-data')
    process.env.PATH = path.join(tempDir, 'mutated-bin')
    process.env.CURSOR_ACP_HOME_DIR = path.join(tempDir, 'mutated-cursor-home')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = path.join(tempDir, 'mutated-managed-data')
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = path.join(tempDir, 'mutated-managed-cache')

    const prepared = await new OpenCodeProfileManager().prepareProfile(projectPath, {
      profileScope: scope,
      includeAppMcp: false,
    })
    expect(prepared.profileRootPath).toStartWith(snapshotManagedData)
    expect(prepared.xdgCacheHome).toStartWith(snapshotManagedCache)
    expect(prepared.globalAuthPath).toBe(path.join(snapshotManagedData, 'opencode', 'auth.json'))
    expect(prepared.env.PATH?.split(path.delimiter)).toContain(snapshotPath)
    expect(prepared.env.PATH).not.toContain('mutated-bin')
    expect(prepared.env.CURSOR_ACP_HOME_DIR).toBe(snapshotCursorHome)
    expect(prepared.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]).toBe(snapshotManagedData)
    expect(prepared.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]).toBe(snapshotManagedCache)
    expect(prepared.managedConfig).toMatchObject({
      provider: { deepinfra: { options: { route: 'snapshot-home-route' } } },
    })
    expect(await readOpenCodeAuthCredential({
      authPath: prepared.managedAuthPath,
      providerId: 'deepinfra',
    })).toMatchObject({ key: 'real-snapshot-provider-key' })
  })

  test('fingerprints query, limit, header, and non-secret env behavior while redacting credentials', async () => {
    const projectPath = path.join(tempDir, 'identity-project')
    await mkdir(projectPath, { recursive: true })
    const scope = (input: {
      baseURL?: string
      limit?: number
      route?: string
      authorization?: string
      cookie?: string
      apiKey?: string
      env?: NodeJS.ProcessEnv
    }) => resolveOpenCodeProfileScope({
      projectPath,
      purpose: 'catalog',
      selectedModel: 'custom/model',
      env: {
        ...input.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          provider: {
            custom: {
              options: {
                baseURL: input.baseURL ?? '{env:CUSTOM_BASE_URL}',
                headers: {
                  'X-Route': input.route ?? 'blue',
                  Authorization: input.authorization ?? 'Bearer one',
                  Cookie: input.cookie ?? 'session=one',
                },
                apiKey: input.apiKey ?? 'key-one',
              },
              models: { model: { limit: { context: input.limit ?? 1000, output: 100 } } },
            },
          },
        }),
      },
    })
    const base = await scope({ env: { CUSTOM_BASE_URL: 'https://example.test/v1?region=one&api_key=one' } })
    const credentialOnly = await scope({
      authorization: 'Bearer two', cookie: 'session=two', apiKey: 'key-two',
      env: { CUSTOM_BASE_URL: 'https://example.test/v1?api_key=two&region=one' },
    })
    const query = await scope({ env: { CUSTOM_BASE_URL: 'https://example.test/v1?region=two&api_key=one' } })
    const limit = await scope({ limit: 2000, env: { CUSTOM_BASE_URL: 'https://example.test/v1?region=one' } })
    const header = await scope({ route: 'green', env: { CUSTOM_BASE_URL: 'https://example.test/v1?region=one' } })

    expect(credentialOnly.configFingerprint).not.toBe(base.configFingerprint)
    expect(query.configFingerprint).not.toBe(base.configFingerprint)
    expect(limit.configFingerprint).not.toBe(base.configFingerprint)
    expect(header.configFingerprint).not.toBe(base.configFingerprint)
  })

  test('prepares the immutable effective-config snapshot in its matching root', async () => {
    const projectPath = path.join(tempDir, 'snapshot-project')
    await mkdir(projectPath, { recursive: true })
    const configPath = path.join(projectPath, 'opencode.json')
    await writeFile(configPath, JSON.stringify({
      provider: { custom: { options: { baseURL: 'https://one.test/v1?route=one' } } },
    }))
    const firstScope = await resolveOpenCodeProfileScope({
      projectPath, purpose: 'catalog', selectedModel: 'custom/model',
    })
    await writeFile(configPath, JSON.stringify({
      provider: { custom: { options: { baseURL: 'https://two.test/v1?route=two' } } },
    }))
    const manager = new OpenCodeProfileManager()
    const firstProfile = await manager.prepareProfile(projectPath, { profileScope: firstScope })
    expect(firstProfile.managedConfig).toMatchObject({
      provider: { custom: { options: { baseURL: 'https://one.test/v1?route=one' } } },
    })
    const secondScope = await resolveOpenCodeProfileScope({
      projectPath, purpose: 'catalog', selectedModel: 'custom/model',
    })
    const secondProfile = await manager.prepareProfile(projectPath, { profileScope: secondScope })
    expect(secondProfile.profileRootPath).not.toBe(firstProfile.profileRootPath)
  })

  test('materializes only the selected catalog credential with app-global API precedence', async () => {
    const projectPath = path.join(tempDir, 'selected-auth-project')
    await mkdir(projectPath, { recursive: true })
    const manager = new OpenCodeProfileManager()
    const globalAuthPath = manager.getGlobalAuthPath()
    const sourceAuthPath = path.join(process.env.XDG_DATA_HOME!, 'opencode', 'auth.json')
    await Promise.all([
      mkdir(path.dirname(globalAuthPath), { recursive: true }),
      mkdir(path.dirname(sourceAuthPath), { recursive: true }),
    ])
    await writeFile(globalAuthPath, JSON.stringify({
      custom: { type: 'api', key: 'global-selected' },
      unrelated: { type: 'api', key: 'global-unrelated' },
    }))
    await writeFile(sourceAuthPath, JSON.stringify({
      custom: { type: 'api', key: 'local-selected' },
      another: { type: 'oauth', access: 'local-unrelated' },
    }))
    const profileScope = await resolveOpenCodeProfileScope({
      projectPath, purpose: 'catalog', selectedModel: 'custom/model',
    })
    await writeFile(sourceAuthPath, JSON.stringify({
      custom: { type: 'api', key: 'changed-after-resolve' },
    }))
    const profile = await manager.prepareProfile(projectPath, { profileScope })
    expect(JSON.parse(await readFile(profile.managedAuthPath, 'utf8'))).toEqual({
      custom: { type: 'api', key: 'global-selected' },
    })
    expect(profile.selectedSourceAuthIdentity).toStartWith('known:')
    expect(profile.selectedManagedAuthIdentity).toBe(profile.selectedSourceAuthIdentity)
    expect(profile.profileRootPath).toContain(profile.profileRootKey)
    const changedScope = await resolveOpenCodeProfileScope({
      projectPath, purpose: 'catalog', selectedModel: 'custom/model',
    })
    const changedProfile = await manager.prepareProfile(projectPath, { profileScope: changedScope })
    expect(changedProfile.profileRootPath).toBe(profile.profileRootPath)
    expect(JSON.parse(await readFile(changedProfile.managedAuthPath, 'utf8'))).toEqual({
      custom: { type: 'api', key: 'global-selected' },
    })
  })

  test('canonicalizes symlink retargets into distinct profile roots', async () => {
    if (process.platform === 'win32') return
    const projectA = path.join(tempDir, 'project-a')
    const projectB = path.join(tempDir, 'project-b')
    const projectLink = path.join(tempDir, 'project-link')
    await Promise.all([mkdir(projectA), mkdir(projectB)])
    await symlink(projectA, projectLink, 'dir')
    const manager = new OpenCodeProfileManager()
    const firstScope = await resolveOpenCodeProfileScope({
      projectPath: projectLink, purpose: 'catalog', selectedModel: 'custom/model',
    })
    const first = await manager.prepareProfile(projectLink, { profileScope: firstScope })
    await rm(projectLink)
    await symlink(projectB, projectLink, 'dir')
    await expect(manager.prepareProfile(projectLink, { profileScope: firstScope }))
      .rejects.toThrow('canonical project path changed')
    const secondScope = await resolveOpenCodeProfileScope({
      projectPath: projectLink, purpose: 'catalog', selectedModel: 'custom/model',
    })
    const second = await manager.prepareProfile(projectLink, { profileScope: secondScope })
    expect(first.projectPath).toBe(await realpath(projectA))
    expect(second.projectPath).toBe(await realpath(projectB))
    expect(second.profileRootPath).not.toBe(first.profileRootPath)
  })

  test('fails closed for a scoped preparation without its resolver-issued snapshot', async () => {
    const projectPath = path.join(tempDir, 'forged-scope-project')
    await mkdir(projectPath)
    await expect(new OpenCodeProfileManager().prepareProfile(projectPath, {
      profileScope: {
        purpose: 'catalog',
        providerId: 'custom',
        configFingerprint: 'forged',
        selectedAuthIdentity: 'absent',
        scopeToken: 'forged',
      },
    })).rejects.toThrow('exact resolver-issued snapshot')
  })

  test('parses the first balanced Kiro whoami JSON object before its Profile trailer', () => {
    expect(isKiroCliWhoamiAuthenticated({
      stdout: '{"accountType":"IamIdentityCenter","email":"user@example.com"}\n\nProfile:\nKiroProfile',
    })).toBe(true)
  })

  test('treats logged-out and malformed Kiro whoami payloads as unauthenticated', () => {
    expect(isKiroCliWhoamiAuthenticated({ stdout: '{"account":null}' })).toBe(false)
    expect(isKiroCliWhoamiAuthenticated({ stdout: '{not valid json' })).toBe(false)
    expect(isKiroCliWhoamiAuthenticated({ stdout: '{"accountType":"   "}' })).toBe(false)
  })

  test('accepts authenticated Kiro whoami JSON from stderr despite a non-zero exit', () => {
    expect(isKiroCliWhoamiAuthenticated({
      error: Object.assign(new Error('exit 1'), { code: 1 }),
      stdout: '',
      stderr: '{"accountType":"BuilderId"}',
    })).toBe(true)
  })

  test('tracks project plugin sources without shadowing plugin config in managed overrides', async () => {
    await mkdir(path.join(tempDir, '.opencode', 'plugins'), { recursive: true })
    await writeFile(
      path.join(tempDir, 'opencode.json'),
      JSON.stringify({ plugin: ['opencode-helicone-session'] }),
      'utf8',
    )
    await writeFile(
      path.join(tempDir, '.opencode', 'package.json'),
      JSON.stringify({ dependencies: { shescape: '^2.1.0' } }),
      'utf8',
    )
    await writeFile(
      path.join(tempDir, '.opencode', 'plugins', 'team-hooks.ts'),
      'export const TeamHooks = async () => ({})\n',
      'utf8',
    )

    const first = await collectProjectBehaviorMetadata(tempDir)
    await writeFile(
      path.join(tempDir, '.opencode', 'plugins', 'team-hooks.ts'),
      'export const TeamHooks = async () => ({ "session.updated": async () => {} })\n',
      'utf8',
    )
    const second = await collectProjectBehaviorMetadata(tempDir)
    const managedConfig = buildManagedConfig()

    expect(first.behaviorSources.map(normalizePath)).toEqual([
      '.opencode/package.json',
      '.opencode/plugins/team-hooks.ts',
      'opencode.json',
    ])
    expect(second.projectBehaviorFingerprint).not.toBe(first.projectBehaviorFingerprint)
    expect('plugin' in managedConfig).toBe(false)
    expect(managedConfig).toMatchObject({
      default_agent: 'teammate',
      share: 'disabled',
      autoupdate: false,
      snapshot: true,
      agent: {
        teammate: {
          permission: {
            '*': 'deny',
            read: 'allow',
            glob: 'allow',
            grep: 'allow',
            list: 'allow',
            lsp: 'allow',
            todoread: 'allow',
            todowrite: 'allow',
            edit: 'allow',
            bash: 'allow',
            'agent-teams_*': 'allow',
            'agent_teams_*': 'allow',
            'mcp__agent-teams__*': 'allow',
            'mcp__agent_teams__*': 'allow',
          },
        },
        'teammate-bootstrap': {
          tools: {
            '*': false,
            'agent-teams_*': true,
            'agent_teams_*': true,
            'mcp__agent-teams__*': true,
            'mcp__agent_teams__*': true,
          },
          permission: {
            '*': 'deny',
            'agent-teams_*': 'allow',
            'agent_teams_*': 'allow',
            'mcp__agent-teams__*': 'allow',
            'mcp__agent_teams__*': 'allow',
          },
        },
        'teammate-model-probe': {
          tools: {
            '*': false,
          },
          permission: {
            '*': 'deny',
          },
        },
      },
    })
  })

  test('can build a manual approval teammate profile while keeping app MCP allowed', () => {
    const managedConfig = buildManagedConfig(null, { toolApprovalMode: 'manual' })

    expect(managedConfig).toMatchObject({
      agent: {
        teammate: {
          permission: {
            '*': 'ask',
            task: {
              '*': 'deny',
            },
            external_directory: 'deny',
            doom_loop: 'deny',
            'agent-teams_*': 'allow',
            'agent_teams_*': 'allow',
            'mcp__agent-teams__*': 'allow',
            'mcp__agent_teams__*': 'allow',
          },
        },
      },
    })
  })

  test('can embed the app-owned MCP server without shadowing plugins', () => {
    const managedConfig = buildManagedConfig({
      type: 'local',
      command: ['node', '/tmp/agent-teams-mcp.js'],
      environment: {
        HOME: '/tmp/profile-home',
      },
      enabled: true,
      timeout: 8000,
    })

    expect('plugin' in managedConfig).toBe(false)
    expect(managedConfig.mcp).toEqual({
      'agent-teams': {
        type: 'local',
        command: ['node', '/tmp/agent-teams-mcp.js'],
        environment: {
          HOME: '/tmp/profile-home',
        },
        enabled: true,
        timeout: 8000,
      },
    })
  })

  test('seeds Z.AI Coding Plan independently of remote catalog hydration', () => {
    const managedConfig = buildManagedConfig()

    expect(managedConfig.provider).toMatchObject({
      'zai-coding-plan': {
        npm: '@ai-sdk/openai-compatible',
        options: {
          baseURL: 'https://api.z.ai/api/coding/paas/v4',
        },
        models: {
          'glm-5.2': {
            reasoning: true,
            tool_call: true,
            interleaved: { field: 'reasoning_content' },
          },
          'glm-5.1': {
            reasoning: true,
            tool_call: true,
            interleaved: { field: 'reasoning_content' },
          },
          'glm-5': {
            reasoning: true,
            tool_call: true,
          },
          'glm-5-turbo': {
            reasoning: true,
            tool_call: true,
          },
        },
      },
    })
  })

  test('keeps Copilot discoverable for explicit-model capability diagnostics', () => {
    const managedConfig = buildManagedConfig()

    expect(managedConfig.provider).toMatchObject({
      'github-copilot': {
        name: 'GitHub Copilot',
        npm: '@ai-sdk/github-copilot',
        api: 'https://api.githubcopilot.com',
        models: {
          'gpt-5.6-luna': {
            name: 'GPT-5.6 Luna',
            family: 'gpt-5.6-luna',
            attachment: true,
            modalities: { input: ['text', 'image'], output: ['text'] },
            reasoning: true,
            tool_call: true,
            structured_output: true,
            limit: {
              context: 1_050_000,
              input: 922_000,
              output: 128_000,
            },
          },
        },
      },
    })
  })

  test('preserves an explicit Copilot model selection when seeding Luna', () => {
    const managedConfig = buildManagedConfig(undefined, {
      defaultModelId: 'github-copilot/gpt-5-mini',
    })

    expect(managedConfig.model).toBe('github-copilot/gpt-5-mini')
  })

  test('seeds Xiaomi MiMo Token Plan OpenCode providers for regional Token Plan endpoints', () => {
    const managedConfig = buildManagedConfig()

    expect(managedConfig.provider).toMatchObject({
      'xiaomi-token-plan-ams': {
        npm: '@ai-sdk/openai-compatible',
        name: 'Xiaomi MiMo Token Plan - Europe',
        options: {
          baseURL: 'https://token-plan-ams.xiaomimimo.com/v1',
        },
        models: {
          'mimo-v2.5-pro': {
            name: 'mimo-v2.5-pro',
            limit: {
              context: 1_048_576,
              output: 131_072,
            },
            modalities: {
              input: ['text'],
              output: ['text'],
            },
          },
          'mimo-v2.5': {
            modalities: {
              input: ['text', 'image', 'audio', 'video'],
              output: ['text'],
            },
          },
        },
      },
      'xiaomi-token-plan-sgp': {
        options: {
          baseURL: 'https://token-plan-sgp.xiaomimimo.com/v1',
        },
      },
      'xiaomi-token-plan-cn': {
        options: {
          baseURL: 'https://token-plan-cn.xiaomimimo.com/v1',
        },
      },
    })
  })

  test('seeds the official Kimi Code membership endpoint and stable model ids', () => {
    const managedConfig = buildManagedConfig()

    expect(managedConfig.provider).toMatchObject({
      'kimi-for-coding': {
        npm: '@ai-sdk/openai-compatible',
        name: 'Kimi Code Membership',
        options: {
          baseURL: 'https://api.kimi.com/coding/v1',
        },
        models: {
          k3: {
            name: 'Kimi K3',
            reasoning: true,
            tool_call: true,
            variants: {
              low: { reasoningEffort: 'low' },
              medium: { disabled: true },
              high: { reasoningEffort: 'high' },
              max: { reasoningEffort: 'max' },
            },
            limit: {
              context: 262_144,
              output: 32_768,
            },
            modalities: {
              input: ['text', 'image', 'video'],
              output: ['text'],
            },
          },
          'kimi-for-coding': {
            name: 'Kimi Code',
            reasoning: true,
            tool_call: true,
            limit: {
              context: 262_144,
              output: 32_768,
            },
            modalities: {
              input: ['text', 'image', 'video'],
              output: ['text'],
            },
          },
          'kimi-for-coding-highspeed': {
            name: 'Kimi Code HighSpeed',
          },
        },
      },
    })
  })

  test('refreshes imported K3 variant definitions with the managed catalog', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const previousConfigContent = process.env.OPENCODE_CONFIG_CONTENT
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = path.join(tempDir, 'app-data-k3-refresh')
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = path.join(tempDir, 'app-cache-k3-refresh')
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      provider: {
        'kimi-for-coding': {
          models: {
            k3: {
              variants: {
                medium: { reasoningEffort: 'medium' },
                max: { reasoningEffort: 'stale-max' },
                custom: { reasoningEffort: 'custom' },
              },
            },
          },
        },
      },
    })

    try {
      const projectPath = path.join(tempDir, 'project-k3-refresh')
      await mkdir(projectPath, { recursive: true })
      const profile = await new OpenCodeProfileManager().prepareProfile(
        projectPath,
        { includeAppMcp: false },
      )
      expect(profile.managedConfig).toMatchObject({
        provider: {
          'kimi-for-coding': {
            models: {
              k3: {
                variants: {
                  low: { reasoningEffort: 'low' },
                  medium: { disabled: true },
                  high: { reasoningEffort: 'high' },
                  max: { reasoningEffort: 'max' },
                  custom: { reasoningEffort: 'custom' },
                },
              },
            },
          },
        },
      })
    } finally {
      if (previousDataHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      }
      if (previousCacheHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      }
      if (previousConfigContent === undefined) {
        delete process.env.OPENCODE_CONFIG_CONTENT
      } else {
        process.env.OPENCODE_CONFIG_CONTENT = previousConfigContent
      }
    }
  })

  test('seeds plugin-backed Cursor and Kiro providers even when models.dev lags', () => {
    const managedConfig = buildManagedConfig()

    expect(managedConfig.provider).toMatchObject({
      kiro: {
        name: 'Amazon Q Developer / Kiro',
        npm:
          'kiro-acp-ai-provider@https://github.com/777genius/kiro-acp-ai-provider/releases/download/agent-teams-mcp-readiness-v12/kiro-acp-ai-provider-3.0.0.tgz',
        models: {
          auto: {
            name: 'Auto',
            tool_call: true,
            limit: { context: 262_144, output: 32_768 },
          },
        },
      },
      'cursor-acp': {
        name: 'Cursor ACP',
        npm: '@ai-sdk/openai-compatible',
        options: {
          baseURL: 'http://127.0.0.1:32124/v1',
        },
        models: {
          auto: {
            name: 'Auto',
            tool_call: true,
            limit: { context: 262_144, output: 32_768 },
          },
        },
      },
    })
  })

  test('keeps OpenCode isolated while native subscription CLIs reuse the host login home', async () => {
    if (process.platform === 'win32') return

    const hostHomePath = path.join(tempDir, "host user's home")
    const hostBinPath = path.join(tempDir, 'host-bin')
    const profileRootPath = path.join(tempDir, 'profile-root')
    await mkdir(hostBinPath, { recursive: true })
    await writeFile(
      path.join(hostBinPath, 'cursor-agent'),
      '#!/bin/sh\nprintf "cursor:%s" "$HOME"\n',
      { encoding: 'utf8', mode: 0o700 },
    )
    await writeFile(
      path.join(hostBinPath, 'kiro-cli'),
      '#!/bin/sh\nprintf "kiro:%s" "$HOME"\n',
      { encoding: 'utf8', mode: 0o700 },
    )

    const bridge = await ensureOpenCodeNativeCliCredentialBridge(
      profileRootPath,
      {
        HOME: hostHomePath,
        PATH: hostBinPath,
      },
      process.platform,
    )
    const managedEnv = {
      HOME: path.join(profileRootPath, 'home'),
      USERPROFILE: path.join(profileRootPath, 'home'),
      PATH: `${bridge.binPath}${path.delimiter}${hostBinPath}`,
    }

    expect(await runCommandCapture(bridge.cursorAgentExecutablePath, [], managedEnv))
      .toBe(`cursor:${hostHomePath}`)
    expect(await runCommandCapture(path.join(bridge.binPath, 'kiro-cli'), [], managedEnv))
      .toBe(`kiro:${hostHomePath}`)
    const cursorBridgeSource = await readFile(bridge.cursorAgentExecutablePath, 'utf8')
    expect(cursorBridgeSource).toContain('AGENT_TEAMS_CURSOR_ORIGINAL_NODE_OPTIONS')
    expect(cursorBridgeSource).toContain('cursor-agent-preload.cjs')
    // The preload records attribution as well as classification, so the shim
    // injects it unconditionally and the kill switch moved into the preload.
    expect(cursorBridgeSource).not.toContain('AGENT_TEAMS_CURSOR_RESOURCE_EXHAUSTED_PATCH_DISABLED')
    const preloadSource = await readFile(
      path.join(bridge.binPath, 'cursor-agent-preload.cjs'),
      'utf8',
    )
    expect(preloadSource).toContain('RESOURCE_EXHAUSTED')
    expect(preloadSource).toContain('AGENT_TEAMS_CURSOR_RESOURCE_EXHAUSTED_PATCH_DISABLED')
    expect(preloadSource).toContain('AGENT_TEAMS_PROCESS_ATTRIBUTION_DIR')
  })

  test('guards the preload on both shim branches and honours the operator escape hatch', async () => {
    const profileRootPath = path.join(tempDir, 'profile-root')
    const hostEnv = {
      HOME: tempDir,
      USERPROFILE: 'C:\\Users\\Test User',
      PATH: tempDir,
      CURSOR_AGENT_EXECUTABLE: 'C:\\Cursor Tools\\cursor-agent.cmd',
      AGENT_TEAMS_CURSOR_RESOURCE_EXHAUSTED_PATCH_DISABLED: '1',
    }

    const windows = await ensureOpenCodeNativeCliCredentialBridge(
      profileRootPath, hostEnv, 'win32',
    )
    const posix = await ensureOpenCodeNativeCliCredentialBridge(
      path.join(tempDir, 'posix-profile-root'), hostEnv, 'linux',
    )

    const windowsSource = await readFile(windows.cursorAgentExecutablePath, 'utf8')
    const posixSource = await readFile(posix.cursorAgentExecutablePath, 'utf8')
    // cmd.exe reads the file through the console OEM code page, so the Windows
    // shim never spells the profile path into NODE_OPTIONS: it resolves the
    // preload beside itself, with the forward slashes node's own parser keeps,
    // and injects only a file that exists.
    expect(windowsSource).toContain('set "AGENT_TEAMS_CURSOR_PRELOAD=%~dp0cursor-agent-preload.cjs"')
    expect(windowsSource).toContain('set "AGENT_TEAMS_CURSOR_PRELOAD=%AGENT_TEAMS_CURSOR_PRELOAD:\\=/%"')
    expect(windowsSource).toContain(
      'if "%AGENT_TEAMS_CURSOR_PRELOAD_DISABLED%"=="1" set "AGENT_TEAMS_CURSOR_PRELOAD="',
    )
    expect(windowsSource).toContain(
      'if not exist "%AGENT_TEAMS_CURSOR_PRELOAD%" set "AGENT_TEAMS_CURSOR_PRELOAD="',
    )
    expect(windowsSource).toContain(
      'if defined AGENT_TEAMS_CURSOR_PRELOAD set "NODE_OPTIONS=--require="%AGENT_TEAMS_CURSOR_PRELOAD%" %NODE_OPTIONS%"',
    )
    expect(windowsSource).not.toContain(buildCursorAgentPreloadRequireOption(
      path.join(windows.binPath, 'cursor-agent-preload.cjs'), 'win32',
    ))
    // The POSIX shim can spell the path, and still injects only a readable file.
    expect(posixSource).toContain('if [ "${AGENT_TEAMS_CURSOR_PRELOAD_DISABLED:-}" != "1" ] && [ -r ')
    expect(posixSource).toContain(buildCursorAgentPreloadRequireOption(
      path.join(posix.binPath, 'cursor-agent-preload.cjs'), 'linux',
    ))
    for (const source of [windowsSource, posixSource]) {
      expect(source).toContain('AGENT_TEAMS_CURSOR_ORIGINAL_NODE_OPTIONS')
      expect(source).toContain(CURSOR_PRELOAD_DISABLED_ENV)
      // The classification kill switch lives in the preload, not in the shim.
      expect(source).not.toContain('AGENT_TEAMS_CURSOR_RESOURCE_EXHAUSTED_PATCH_DISABLED')
    }
  })

  test('quotes the Windows preload require in the only form node can resolve', () => {
    // Node parses NODE_OPTIONS itself and drops backslashes inside quotes, so a
    // quoted Windows path would arrive as an unresolvable module specifier.
    expect(buildCursorAgentPreloadRequireOption(
      'C:\\Users\\Test User\\bin\\cursor-agent-preload.cjs', 'win32',
    )).toBe('--require="C:/Users/Test User/bin/cursor-agent-preload.cjs"')
    expect(buildCursorAgentPreloadRequireOption(
      '/home/test user/bin/cursor-agent-preload.cjs', 'linux',
    )).toBe('--require="/home/test user/bin/cursor-agent-preload.cjs"')
  })

  test('publishes one preload with a single strict-mode directive at its head', async () => {
    const source = buildCursorAgentPreloadScript()
    // Only the first statement of a file is a directive: a second copy further
    // down is a plain string expression, and the block after it would run in
    // sloppy mode without anything saying so.
    expect(source.startsWith("'use strict'\n")).toBe(true)
    expect(source.match(/'use strict'/g)).toHaveLength(1)
    expect(buildCursorAgentResourceExhaustedPreloadScript()).not.toContain('use strict')

    const bridge = await ensureOpenCodeNativeCliCredentialBridge(
      path.join(tempDir, 'profile-root'),
      {
        USERPROFILE: tempDir,
        PATH: tempDir,
        CURSOR_AGENT_EXECUTABLE: path.join(tempDir, 'cursor-agent.cmd'),
      },
      'win32',
    )
    expect(await readFile(path.join(bridge.binPath, 'cursor-agent-preload.cjs'), 'utf8'))
      .toBe(source)
  })

  test('applies the Cursor preload by default, with the classification kill switch and the preload escape hatch', async () => {
    if (process.platform === 'win32') return

    const nodePath = Bun.which('node')
    expect(nodePath).toBeTruthy()
    if (!nodePath) return
    const hostBinPath = path.join(tempDir, 'host-bin')
    const profileRootPath = path.join(tempDir, 'profile-root')
    const fixturePath = path.join(tempDir, 'cursor-agent-fixture.js')
    const cursorAgentOverridePath = path.join(tempDir, 'custom cursor-agent')
    await mkdir(hostBinPath, { recursive: true })
    await writeFile(
      fixturePath,
      [
        "const c={yM:{FREE_USER_USAGE_LIMIT:'free',GENERIC_RATE_LIMIT_EXCEEDED:'generic',RESOURCE_EXHAUSTED:'resource'}};",
        'R=new Set([c.yM.FREE_USER_USAGE_LIMIT,c.yM.GENERIC_RATE_LIMIT_EXCEEDED]);',
        // The preload clears AGENT_TEAMS_PROCESS_ATTRIBUTION_* once it has
        // written, so the fixture reads the store through copies of the names.
        "const attributionDirectory=require('node:path').join(",
        '  process.env.ATTRIBUTION_FIXTURE_DIR,',
        "  'v1','agents',process.env.ATTRIBUTION_FIXTURE_ID);",
        "let attributed=[];try{attributed=require('node:fs').readdirSync(attributionDirectory)}catch(error){}",
        'process.stdout.write(JSON.stringify({patched:R.has(c.yM.RESOURCE_EXHAUSTED),',
        'nodeOptions:process.env.NODE_OPTIONS||null,attributed:attributed.length}))',
      ].join(''),
      'utf8',
    )
    const shellQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`
    await writeFile(
      path.join(hostBinPath, 'cursor-agent'),
      '#!/bin/sh\nprintf "wrong cursor-agent target"\n',
      { encoding: 'utf8', mode: 0o700 },
    )
    await writeFile(
      cursorAgentOverridePath,
      `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(fixturePath)} "$@"\n`,
      { encoding: 'utf8', mode: 0o700 },
    )
    await writeFile(
      path.join(hostBinPath, 'kiro-cli'),
      '#!/bin/sh\nexit 0\n',
      { encoding: 'utf8', mode: 0o700 },
    )
    const bridge = await ensureOpenCodeNativeCliCredentialBridge(
      profileRootPath,
      {
        HOME: tempDir,
        PATH: hostBinPath,
        CURSOR_AGENT_EXECUTABLE: cursorAgentOverridePath,
      },
      process.platform,
    )
    const attributionDirectory = path.join(tempDir, 'process-attribution')
    const attributionId = mintProcessAttributionId()
    const baseEnv = {
      HOME: path.join(profileRootPath, 'home'),
      PATH: `${bridge.binPath}${path.delimiter}${hostBinPath}`,
      [PROCESS_ATTRIBUTION_DIRECTORY_ENV]: attributionDirectory,
      [PROCESS_ATTRIBUTION_ID_ENV]: attributionId,
      ATTRIBUTION_FIXTURE_DIR: attributionDirectory,
      ATTRIBUTION_FIXTURE_ID: attributionId,
    }
    // The agent invocation both spawners produce: the preload records only a
    // process that carries --workspace.
    const agentArgs = ['--workspace', tempDir]

    expect(JSON.parse(await runCommandCapture(
      bridge.cursorAgentExecutablePath,
      agentArgs,
      baseEnv,
    ))).toEqual({ patched: true, nodeOptions: null, attributed: 1 })
    // The kill switch stops the classification patch only: attribution is not
    // an override of Cursor behaviour, it is a record of what was spawned.
    expect(JSON.parse(await runCommandCapture(
      bridge.cursorAgentExecutablePath,
      agentArgs,
      {
        ...baseEnv,
        AGENT_TEAMS_CURSOR_RESOURCE_EXHAUSTED_PATCH_DISABLED: '1',
      },
    ))).toEqual({ patched: false, nodeOptions: null, attributed: 1 })
    // The escape hatch stops the shim from injecting anything, and the agent
    // still runs.
    expect(JSON.parse(await runCommandCapture(
      bridge.cursorAgentExecutablePath,
      agentArgs,
      {
        ...baseEnv,
        [CURSOR_PRELOAD_DISABLED_ENV]: '1',
      },
    ))).toEqual({ patched: false, nodeOptions: null, attributed: 0 })
    // Every run so far exited normally, so no record outlived its process.
    expect(await readAttributionRecords(attributionDirectory)).toMatchObject({ agents: [] })

    // A preload that is gone is not injected either: node aborts a process
    // whose --require cannot be resolved, and no record is a smaller loss than
    // no agent.
    await rm(path.join(bridge.binPath, 'cursor-agent-preload.cjs'))
    expect(JSON.parse(await runCommandCapture(
      bridge.cursorAgentExecutablePath,
      agentArgs,
      baseEnv,
    ))).toEqual({ patched: false, nodeOptions: null, attributed: 0 })
  })

  test('writes cmd-safe Cursor preload and preserves an explicit Windows executable', async () => {
    const profileRootPath = path.join(tempDir, 'profile-root')
    const cursorAgentExecutable = 'C:\\Cursor Tools\\cursor-agent.cmd'
    const bridge = await ensureOpenCodeNativeCliCredentialBridge(
      profileRootPath,
      {
        USERPROFILE: 'C:\\Users\\Test User',
        PATH: 'C:\\Windows\\System32',
        CURSOR_AGENT_EXECUTABLE: cursorAgentExecutable,
      },
      'win32',
    )

    const cursorBridgeSource = await readFile(bridge.cursorAgentExecutablePath, 'utf8')
    expect(cursorBridgeSource).toContain('NODE_OPTIONS=--require="')
    expect(cursorBridgeSource).not.toContain('NODE_OPTIONS=--require=\\"')
    expect(cursorBridgeSource).toContain(`call "${cursorAgentExecutable}" %*`)
  })

  test('prepares only Kiro native credentials for a Kiro-scoped profile', async () => {
    const calls: string[] = []
    await ensureOpenCodeNativePluginAuthCredentials({
      selectedProviderId: 'kiro',
      prepareKiro: async () => {
        calls.push('kiro')
      },
      prepareCursor: async () => {
        calls.push('cursor-mutated')
        throw new Error('poisoned unrelated Cursor auth path')
      },
    })

    expect(calls).toEqual(['kiro'])
  })

  test('prepares only Cursor native credentials for a Cursor-scoped profile', async () => {
    const calls: string[] = []
    await ensureOpenCodeNativePluginAuthCredentials({
      selectedProviderId: 'cursor-acp',
      prepareCursor: async () => {
        calls.push('cursor')
      },
      prepareKiro: async () => {
        calls.push('kiro-mutated')
        throw new Error('poisoned unrelated Kiro auth path')
      },
    })

    expect(calls).toEqual(['cursor'])
  })

  test('seeds the Cursor plugin marker after the official CLI reports authenticated', async () => {
    const globalAuthPath = path.join(tempDir, 'cursor-global-auth.json')
    const managedAuthPath = path.join(tempDir, 'cursor-managed-auth.json')
    const probe = mock(async () => true)

    expect(await ensureOpenCodeCursorPluginAuthCredential({
      globalAuthPath,
      managedAuthPath,
      cursorAgentExecutablePath: '/test/cursor-agent',
      platform: 'linux',
      probe,
    })).toBe(true)

    for (const authPath of [globalAuthPath, managedAuthPath]) {
      expect(JSON.parse(await readFile(authPath, 'utf8'))).toMatchObject({
        'cursor-acp': { type: 'api', key: 'cursor-agent' },
      })
    }
    expect(probe).toHaveBeenCalledTimes(1)
  })

  test('removes only the managed Cursor marker after the official CLI logs out', async () => {
    const globalAuthPath = path.join(tempDir, 'cursor-logged-out-global.json')
    const managedAuthPath = path.join(tempDir, 'cursor-logged-out-managed.json')
    const store = JSON.stringify({
      'cursor-acp': { type: 'api', key: 'cursor-agent' },
      openai: { type: 'oauth', access: 'keep-me' },
    })
    await Promise.all([
      writeFile(globalAuthPath, store),
      writeFile(managedAuthPath, store),
    ])

    expect(await ensureOpenCodeCursorPluginAuthCredential({
      globalAuthPath,
      managedAuthPath,
      cursorAgentExecutablePath: '/test/cursor-agent',
      probe: async () => false,
    })).toBe(false)

    for (const authPath of [globalAuthPath, managedAuthPath]) {
      expect(JSON.parse(await readFile(authPath, 'utf8'))).toEqual({
        openai: { type: 'oauth', access: 'keep-me' },
      })
    }
  })

  test('reuses a fresh Cursor marker without repeatedly probing the official CLI', async () => {
    const globalAuthPath = path.join(tempDir, 'cursor-fresh-global.json')
    const managedAuthPath = path.join(tempDir, 'cursor-fresh-managed.json')
    const credential = {
      type: 'api',
      key: 'cursor-agent',
      expires: 20 * 60 * 1000,
    }
    await writeFile(globalAuthPath, JSON.stringify({ 'cursor-acp': credential }))
    const probe = mock(async () => false)

    expect(await ensureOpenCodeCursorPluginAuthCredential({
      globalAuthPath,
      managedAuthPath,
      cursorAgentExecutablePath: '/test/cursor-agent',
      probe,
      now: () => 1_000,
    })).toBe(false)

    expect(probe).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(managedAuthPath, 'utf8'))).toMatchObject({
      'cursor-acp': credential,
    })
  })

  test('preserves an explicit Cursor API credential without probing the CLI marker', async () => {
    const globalAuthPath = path.join(tempDir, 'cursor-explicit-global.json')
    const managedAuthPath = path.join(tempDir, 'cursor-explicit-managed.json')
    await writeFile(globalAuthPath, JSON.stringify({
      'cursor-acp': { type: 'api', key: 'real-user-key' },
    }))
    const probe = mock(async () => false)

    expect(await ensureOpenCodeCursorPluginAuthCredential({
      globalAuthPath,
      managedAuthPath,
      cursorAgentExecutablePath: '/test/cursor-agent',
      probe,
    })).toBe(false)

    expect(JSON.parse(await readFile(managedAuthPath, 'utf8'))).toMatchObject({
      'cursor-acp': { type: 'api', key: 'real-user-key' },
    })
    expect(probe).not.toHaveBeenCalled()
  })

  test('seeds the Kiro plugin OAuth marker after the official CLI reports authenticated', async () => {
    const globalAuthPath = path.join(tempDir, 'kiro-global-auth.json')
    const managedAuthPath = path.join(tempDir, 'kiro-managed-auth.json')
    const probe = mock(async () => true)

    expect(await ensureOpenCodeKiroPluginAuthCredential({
      globalAuthPath,
      managedAuthPath,
      kiroCliExecutablePath: '/test/kiro-cli',
      platform: 'linux',
      probe,
      now: () => 1_000,
    })).toBe(true)

    for (const authPath of [globalAuthPath, managedAuthPath]) {
      expect(JSON.parse(await readFile(authPath, 'utf8'))).toMatchObject({
        kiro: {
          type: 'oauth',
          access: 'authenticated',
          refresh: '',
          expires: 28_801_000,
        },
      })
    }
    expect(probe).toHaveBeenCalledTimes(1)
  })

  test('does not seed the Kiro plugin marker when the CLI is logged out', async () => {
    const globalAuthPath = path.join(tempDir, 'kiro-logged-out-global.json')
    const managedAuthPath = path.join(tempDir, 'kiro-logged-out-managed.json')

    expect(await ensureOpenCodeKiroPluginAuthCredential({
      globalAuthPath,
      managedAuthPath,
      kiroCliExecutablePath: '/test/kiro-cli',
      probe: async () => false,
    })).toBe(false)

    expect(await lstat(globalAuthPath).then(() => true).catch(() => false)).toBe(false)
    expect(await lstat(managedAuthPath).then(() => true).catch(() => false)).toBe(false)
  })

  test('refreshes a stale Kiro marker after rechecking the official CLI', async () => {
    const globalAuthPath = path.join(tempDir, 'kiro-stale-global.json')
    const managedAuthPath = path.join(tempDir, 'kiro-stale-managed.json')
    await writeFile(globalAuthPath, JSON.stringify({
      kiro: { type: 'oauth', access: 'authenticated', refresh: '', expires: 2_000 },
    }))
    const probe = mock(async () => true)

    expect(await ensureOpenCodeKiroPluginAuthCredential({
      globalAuthPath,
      managedAuthPath,
      kiroCliExecutablePath: '/test/kiro-cli',
      probe,
      now: () => 1_000,
    })).toBe(true)

    for (const authPath of [globalAuthPath, managedAuthPath]) {
      expect(JSON.parse(await readFile(authPath, 'utf8')).kiro.expires).toBe(28_801_000)
    }
    expect(probe).toHaveBeenCalledTimes(1)
  })

  test('removes a stale Kiro marker when the official CLI is logged out', async () => {
    const globalAuthPath = path.join(tempDir, 'kiro-stale-logged-out-global.json')
    const managedAuthPath = path.join(tempDir, 'kiro-stale-logged-out-managed.json')
    const staleStore = JSON.stringify({
      kiro: { type: 'oauth', access: 'authenticated', refresh: '', expires: 2_000 },
      openai: { type: 'oauth', access: 'keep-me' },
    })
    await Promise.all([
      writeFile(globalAuthPath, staleStore),
      writeFile(managedAuthPath, staleStore),
    ])

    expect(await ensureOpenCodeKiroPluginAuthCredential({
      globalAuthPath,
      managedAuthPath,
      kiroCliExecutablePath: '/test/kiro-cli',
      probe: async () => false,
      now: () => 1_000,
    })).toBe(false)

    for (const authPath of [globalAuthPath, managedAuthPath]) {
      expect(JSON.parse(await readFile(authPath, 'utf8'))).toEqual({
        openai: { type: 'oauth', access: 'keep-me' },
      })
    }
  })

  test('rechecks and removes a fresh Kiro marker after CLI logout', async () => {
    const globalAuthPath = path.join(tempDir, 'kiro-fresh-logged-out-global.json')
    const managedAuthPath = path.join(tempDir, 'kiro-fresh-logged-out-managed.json')
    const freshStore = JSON.stringify({
      kiro: { type: 'oauth', access: 'authenticated', refresh: '', expires: 30_000_000 },
      openai: { type: 'oauth', access: 'keep-me' },
    })
    await Promise.all([
      writeFile(globalAuthPath, freshStore),
      writeFile(managedAuthPath, freshStore),
    ])
    const probe = mock(async () => false)

    expect(await ensureOpenCodeKiroPluginAuthCredential({
      globalAuthPath,
      managedAuthPath,
      kiroCliExecutablePath: '/test/kiro-cli',
      probe,
      now: () => 1_000,
    })).toBe(false)

    expect(probe).toHaveBeenCalledTimes(1)
    for (const authPath of [globalAuthPath, managedAuthPath]) {
      expect(JSON.parse(await readFile(authPath, 'utf8'))).toEqual({
        openai: { type: 'oauth', access: 'keep-me' },
      })
    }
  })

  test('can prepare a managed profile without the app MCP overlay for model-only probes', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const previousMcpCommand = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND
    const previousMcpEntry = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY
    const appDataHome = path.join(tempDir, 'app-data-no-mcp')
    const appCacheHome = path.join(tempDir, 'app-cache-no-mcp')
    const mcpEntryPath = path.join(tempDir, 'agent-teams-mcp.js')
    await writeFile(mcpEntryPath, 'process.exit(0)\n', 'utf8')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome
    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND = process.execPath
    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY = mcpEntryPath

    try {
      const profile = await new OpenCodeProfileManager().prepareProfile(tempDir, {
        includeAppMcp: false,
      })

      expect(profile.managedConfig.mcp).toBeUndefined()
    } finally {
      if (previousDataHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      }
      if (previousCacheHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      }
      if (previousMcpCommand === undefined) {
        delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND
      } else {
        process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND = previousMcpCommand
      }
      if (previousMcpEntry === undefined) {
        delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY
      } else {
        process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY = previousMcpEntry
      }
    }
  }, 30_000)

  test('recovers a refreshed xAI OAuth credential from a peer during restart preparation', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const previousHome = process.env.HOME
    const previousXdgDataHome = process.env.XDG_DATA_HOME
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
    const appDataHome = path.join(tempDir, 'app-data-oauth-restart')
    const appCacheHome = path.join(tempDir, 'app-cache-oauth-restart')
    const homePath = path.join(tempDir, 'home-oauth-restart')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome
    process.env.HOME = homePath
    process.env.XDG_DATA_HOME = path.join(homePath, '.local', 'share')
    process.env.XDG_CONFIG_HOME = path.join(homePath, '.config')

    const now = Date.now()
    const stale = {
      type: 'oauth',
      access: 'expired-access',
      refresh: 'refresh-before-rotation',
      expires: now - 60_000,
      accountId: 'supergrok-account',
    }
    const rotated = {
      type: 'oauth',
      access: 'refreshed-access',
      refresh: 'refresh-after-rotation',
      expires: now + 3_600_000,
      accountId: 'supergrok-account',
    }

    try {
      const manager = new OpenCodeProfileManager()
      await upsertOpenCodeAuthCredential({
        authPath: manager.getGlobalAuthPath(),
        providerId: 'xai',
        credential: stale,
      })
      const activeProfile = await manager.prepareProfile(path.join(tempDir, 'active-project'), {
        includeAppMcp: false,
        includeManagedSubscriptionPlugins: false,
      })
      await upsertOpenCodeAuthCredential({
        authPath: activeProfile.managedAuthPath,
        providerId: 'xai',
        credential: rotated,
      })

      const restartedProfile = await manager.prepareProfile(path.join(tempDir, 'restarted-project'), {
        includeAppMcp: false,
        includeManagedSubscriptionPlugins: false,
      })

      await expect(Promise.all([
        readOpenCodeAuthCredential({ authPath: manager.getGlobalAuthPath(), providerId: 'xai' }),
        readOpenCodeAuthCredential({ authPath: activeProfile.managedAuthPath, providerId: 'xai' }),
        readOpenCodeAuthCredential({ authPath: restartedProfile.managedAuthPath, providerId: 'xai' }),
      ])).resolves.toEqual([rotated, rotated, rotated])
    } finally {
      if (previousDataHome === undefined) delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      else process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      if (previousCacheHome === undefined) delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      else process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = previousXdgDataHome
      if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
    }
  }, 15_000)

  test('keeps app-managed LLM Gateway auth active when local OpenCode has a stale key', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const previousHome = process.env.HOME
    const previousXdgDataHome = process.env.XDG_DATA_HOME
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
    const appDataHome = path.join(tempDir, 'app-data-llmgateway')
    const appCacheHome = path.join(tempDir, 'app-cache-llmgateway')
    const homePath = path.join(tempDir, 'home-llmgateway')
    const localAuthPath = path.join(homePath, '.local', 'share', 'opencode', 'auth.json')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome
    process.env.HOME = homePath
    process.env.XDG_DATA_HOME = path.join(homePath, '.local', 'share')
    process.env.XDG_CONFIG_HOME = path.join(homePath, '.config')

    const freshCredential = { type: 'api', key: 'llmgateway-new-valid-key' }
    const staleCredential = { type: 'api', key: 'llmgateway-deleted-old-key' }

    try {
      const manager = new OpenCodeProfileManager()
      await Promise.all([
        upsertOpenCodeAuthCredential({
          authPath: manager.getGlobalAuthPath(),
          providerId: 'llmgateway',
          credential: freshCredential,
        }),
        upsertOpenCodeAuthCredential({
          authPath: localAuthPath,
          providerId: 'llmgateway',
          credential: staleCredential,
        }),
      ])

      const profile = await manager.prepareProfile(path.join(tempDir, 'llmgateway-project'), {
        includeAppMcp: false,
        includeManagedSubscriptionPlugins: false,
      })

      expect(profile.authState).toBe('ok')
      await expect(
        readOpenCodeAuthCredential({
          authPath: profile.managedAuthPath,
          providerId: 'llmgateway',
        }),
      ).resolves.toEqual(freshCredential)
      await expect(
        readOpenCodeAuthCredential({ authPath: localAuthPath, providerId: 'llmgateway' }),
      ).resolves.toEqual(staleCredential)
    } finally {
      if (previousDataHome === undefined) delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      else process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      if (previousCacheHome === undefined) delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      else process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = previousXdgDataHome
      if (previousXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previousXdgConfigHome
    }
  }, 15_000)

  test('imports only safe user OpenCode config into managed profile content', async () => {
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
    const previousOpenCodeConfig = process.env.OPENCODE_CONFIG
    const previousOpenCodeConfigContent = process.env.OPENCODE_CONFIG_CONTENT
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const previousMcpUrl = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL
    const appDataHome = path.join(tempDir, 'app-data-config-import')
    const appCacheHome = path.join(tempDir, 'app-cache-config-import')
    const xdgConfigHome = path.join(tempDir, 'real-xdg-config')
    const customConfigPath = path.join(tempDir, 'custom-opencode.jsonc')
    const projectPath = path.join(tempDir, 'project-config-import')
    await mkdir(path.join(xdgConfigHome, 'opencode'), { recursive: true })
    await mkdir(projectPath, { recursive: true })
    await writeFile(path.join(projectPath, 'opencode.json'), JSON.stringify({
      plugin: ['project-user-plugin', 'opencode-kiro@0.4.0', '@rama_nigg/open-cursor@2.5.2'],
    }))
    await writeFile(
      path.join(xdgConfigHome, 'opencode', 'opencode.jsonc'),
      `{
        // Local Ollama route should be imported.
        "model": "ollama/qwen2.5-coder:0.5b",
        "provider": {
          "ollama": {
            "npm": "@ai-sdk/openai-compatible",
            "options": { "baseURL": "http://127.0.0.1:11434/v1" },
            "models": { "qwen2.5-coder:0.5b": {} }
          }
        },
        "mcp": { "unsafe": { "type": "local", "command": ["bad"] } },
        "permission": { "*": "allow" },
        "plugin": ["unsafe-plugin"],
        "agent": { "unsafe": { "mode": "primary" } }
      }`,
      'utf8',
    )
    await writeFile(
      customConfigPath,
      JSON.stringify({
        small_model: 'llama.cpp/qwen-test:0.5b',
        provider: {
          'llama.cpp': {
            npm: '@ai-sdk/openai-compatible',
            options: { baseURL: 'http://127.0.0.1:8080/v1' },
            models: { 'qwen-test:0.5b': {} },
          },
        },
        command: { unsafe: 'nope' },
      }),
      'utf8',
    )
    process.env.XDG_CONFIG_HOME = xdgConfigHome
    process.env.OPENCODE_CONFIG = customConfigPath
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({
      provider: {
        deepinfra: { options: { apiKey: 'example-fixture-literal' }, models: { chosen: {} } },
        unrelated: { options: { apiKey: 'placeholder-fixture-literal' } },
        kiro: { options: { poisoned: true }, models: { poison: {} } },
        'cursor-acp': { options: { poisoned: true }, models: { poison: {} } },
        lmstudio: {
          npm: '@ai-sdk/openai-compatible',
          options: { baseURL: 'http://localhost:1234/v1' },
          models: { 'google/gemma-3n-e4b': {} },
        },
      },
      command: { unsafeInline: 'nope' },
    })
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome
    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL = 'http://127.0.0.1:43123/mcp'

    try {
      const manager = new OpenCodeProfileManager()
      const profile = await manager.prepareProfile(projectPath)
      const managedConfig = JSON.parse(profile.env.OPENCODE_CONFIG_CONTENT ?? '{}') as Record<string, unknown>
      const providers = managedConfig.provider as Record<string, unknown>
      const agents = managedConfig.agent as Record<string, unknown>
      const mcp = (managedConfig.mcp ?? {}) as Record<string, unknown>

      expect(profile.env.OPENCODE_CONFIG).toBeUndefined()
      expect(providers.ollama).toMatchObject({
        models: { 'qwen2.5-coder:0.5b': {} },
      })
      expect(providers['llama.cpp']).toMatchObject({
        options: { baseURL: 'http://127.0.0.1:8080/v1' },
      })
      expect(providers.lmstudio).toMatchObject({
        models: { 'google/gemma-3n-e4b': {} },
      })
      expect(managedConfig.model).toBe('ollama/qwen2.5-coder:0.5b')
      expect(profile.importedConfigDefaultModelId).toBe('ollama/qwen2.5-coder:0.5b')
      expect(managedConfig.small_model).toBe('llama.cpp/qwen-test:0.5b')
      expect(managedConfig.plugin).toEqual([
        'opencode-kiro@0.4.0',
        '@rama_nigg/open-cursor@2.5.2',
      ])
      const catalogScope = (providerId: string) => resolveOpenCodeProfileScope({
        projectPath,
        purpose: 'catalog',
        selectedModel: `${providerId}/catalog`,
      })
      const scopedProfile = await manager.prepareProfile(projectPath, {
        profileScope: await catalogScope('deepinfra'),
      })
      expect(scopedProfile.managedConfig.plugin).toEqual([])
      expect(scopedProfile.managedConfig.provider).toEqual({
        deepinfra: {
          options: { apiKey: 'example-fixture-literal' },
          models: { chosen: {} },
        },
      })
      expect(scopedProfile.workingDirectoryPath).not.toBe(projectPath)
      const kiroProfile = await manager.prepareProfile(
        projectPath,
        {
          profileScope: await catalogScope('kiro'),
        },
      )
      expect(kiroProfile.managedConfig.plugin).toEqual([
        'opencode-kiro@0.4.0',
      ])
      const cursorProfile = await manager.prepareProfile(
        projectPath,
        {
          profileScope: await catalogScope('cursor-acp'),
        },
      )
      expect(cursorProfile.managedConfig.plugin).toEqual([
        '@rama_nigg/open-cursor@2.5.2',
      ])
      await Promise.all(['deepinfra', 'llama.cpp', 'kiro', 'cursor-acp'].map(providerId =>
        upsertOpenCodeAuthCredential({
          authPath: path.join(process.env.XDG_DATA_HOME!, 'opencode', 'auth.json'),
          providerId,
          credential: { type: 'api', key: `${providerId}-secret` },
        })))
      for (const selected of ['deepinfra/chosen', 'llama.cpp/qwen-test:0.5b']) {
        const providerId = selected.slice(0, selected.indexOf('/'))
        const launchScope = await resolveOpenCodeProfileScope({
          projectPath, purpose: 'launch_runtime', selectedModel: selected,
        })
        const launchProfile = await manager.prepareProfile(projectPath, {
          profileScope: launchScope,
        })
        const retainedScopeEnvironment = JSON.parse(
          launchProfile.env.CLAUDE_MULTIMODEL_OPENCODE_SCOPE_ENVIRONMENT ?? '{}',
        ) as Record<string, unknown>
        expect(retainedScopeEnvironment).not.toHaveProperty('OPENCODE_CONFIG_CONTENT')
        expect(retainedScopeEnvironment).not.toHaveProperty('OPENCODE_CONFIG')
        const serializedProfileEnvironment = Object.values(launchProfile.env).join('\n')
        expect(serializedProfileEnvironment).not.toContain(
          'placeholder-fixture-literal',
        )
        expect(JSON.stringify(launchProfile.managedConfig)).not.toContain(
          'placeholder-fixture-literal',
        )
        expect(await resolveOpenCodeProfileScope({
          projectPath, purpose: 'launch_runtime', selectedModel: selected,
          env: launchProfile.env,
        })).toEqual(launchScope)
        expect(Object.keys(launchProfile.managedConfig.provider as object)).toEqual([providerId])
        expect(launchProfile.managedConfig.plugin).toEqual(['unsafe-plugin', 'project-user-plugin'])
        expect(launchProfile.managedConfig.mcp).toHaveProperty('agent-teams')
        expect(launchProfile.managedConfig.agent).toHaveProperty('teammate')
        expect(await readOpenCodeAuthCredential({
          authPath: launchProfile.managedAuthPath, providerId,
        })).toMatchObject({ key: `${providerId}-secret` })
        expect(await readOpenCodeAuthCredential({
          authPath: launchProfile.managedAuthPath, providerId: 'kiro',
        })).toBeNull()
        expect(await readOpenCodeAuthCredential({
          authPath: launchProfile.managedAuthPath, providerId: 'cursor-acp',
        })).toBeNull()
      }
      expect(managedConfig).not.toHaveProperty('permission')
      expect(managedConfig).not.toHaveProperty('command')
      expect(mcp.unsafe).toBeUndefined()
      expect(agents.teammate).toBeDefined()
      expect(agents.unsafe).toBeUndefined()
    } finally {
      if (previousXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME
      } else {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome
      }
      if (previousOpenCodeConfig === undefined) {
        delete process.env.OPENCODE_CONFIG
      } else {
        process.env.OPENCODE_CONFIG = previousOpenCodeConfig
      }
      if (previousOpenCodeConfigContent === undefined) {
        delete process.env.OPENCODE_CONFIG_CONTENT
      } else {
        process.env.OPENCODE_CONFIG_CONTENT = previousOpenCodeConfigContent
      }
      if (previousDataHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      }
      if (previousCacheHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      }
      if (previousMcpUrl === undefined) {
        delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL
      } else {
        process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL = previousMcpUrl
      }
    }
  })

  test('imports Ollama Cloud model routes from user opencode.json', async () => {
    const previousXdgConfigHome = process.env.XDG_CONFIG_HOME
    const previousOpenCodeConfig = process.env.OPENCODE_CONFIG
    const previousOpenCodeConfigContent = process.env.OPENCODE_CONFIG_CONTENT
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const appDataHome = path.join(tempDir, 'app-data-ollama-cloud-import')
    const appCacheHome = path.join(tempDir, 'app-cache-ollama-cloud-import')
    const xdgConfigHome = path.join(tempDir, 'xdg-config-ollama-cloud')
    await mkdir(path.join(xdgConfigHome, 'opencode'), { recursive: true })
    await writeFile(
      path.join(xdgConfigHome, 'opencode', 'opencode.json'),
      JSON.stringify({
        model: 'ollama/kimi-k2.6:cloud',
        provider: {
          ollama: {
            models: {
              'kimi-k2.6:cloud': {
                limit: {
                  context: 262_144,
                  output: 262_144,
                },
                attachment: true,
                modalities: {
                  input: ['text', 'image'],
                  output: ['text'],
                },
                name: 'kimi-k2.6:cloud',
              },
              'deepseek-v4-flash:cloud': {
                limit: {
                  context: 1_000_000,
                  output: 1_000_000,
                },
                name: 'deepseek-v4-flash:cloud',
              },
            },
          },
        },
      }),
      'utf8',
    )
    process.env.XDG_CONFIG_HOME = xdgConfigHome
    delete process.env.OPENCODE_CONFIG
    delete process.env.OPENCODE_CONFIG_CONTENT
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome

    try {
      const profile = await new OpenCodeProfileManager().prepareProfile(
        path.join(tempDir, 'project-ollama-cloud-import'),
      )
      const managedConfig = JSON.parse(profile.env.OPENCODE_CONFIG_CONTENT ?? '{}') as Record<string, unknown>
      const providers = managedConfig.provider as Record<string, unknown>

      expect(managedConfig.model).toBe('ollama/kimi-k2.6:cloud')
      expect(providers.ollama).toMatchObject({
        models: {
          'kimi-k2.6:cloud': {
            limit: {
              context: 262_144,
              output: 262_144,
            },
            attachment: true,
            modalities: {
              input: ['text', 'image'],
              output: ['text'],
            },
            name: 'kimi-k2.6:cloud',
          },
          'deepseek-v4-flash:cloud': {
            limit: {
              context: 1_000_000,
              output: 1_000_000,
            },
            name: 'deepseek-v4-flash:cloud',
          },
        },
      })
    } finally {
      if (previousXdgConfigHome === undefined) {
        delete process.env.XDG_CONFIG_HOME
      } else {
        process.env.XDG_CONFIG_HOME = previousXdgConfigHome
      }
      if (previousOpenCodeConfig === undefined) {
        delete process.env.OPENCODE_CONFIG
      } else {
        process.env.OPENCODE_CONFIG = previousOpenCodeConfig
      }
      if (previousOpenCodeConfigContent === undefined) {
        delete process.env.OPENCODE_CONFIG_CONTENT
      } else {
        process.env.OPENCODE_CONFIG_CONTENT = previousOpenCodeConfigContent
      }
      if (previousDataHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      }
      if (previousCacheHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      }
    }
  })

  test('exposes an app-owned global auth path separate from the real OpenCode auth store', () => {
    const previousXdgDataHome = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = tempDir
    try {
      const manager = new OpenCodeProfileManager()
      const realOpenCodeAuthPath = path.join(tempDir, 'opencode', 'auth.json')
      const globalAuthPath = manager.getGlobalAuthPath()
      expect(globalAuthPath).not.toBe(realOpenCodeAuthPath)
      expect(globalAuthPath.endsWith(path.join('opencode', 'auth.json'))).toBe(true)
    } finally {
      if (previousXdgDataHome === undefined) {
        delete process.env.XDG_DATA_HOME
      } else {
        process.env.XDG_DATA_HOME = previousXdgDataHome
      }
    }
  })

  test('captures the freshest competing OAuth credential with the managed-auth policy', async () => {
    const manager = new OpenCodeProfileManager()
    const projectPath = path.join(tempDir, 'oauth-catalog-project')
    const globalAuthPath = manager.getGlobalAuthPath()
    const sourceAuthPath = path.join(process.env.XDG_DATA_HOME!, 'opencode', 'auth.json')
    await Promise.all([
      mkdir(projectPath, { recursive: true }),
      upsertOpenCodeAuthCredential({
        authPath: globalAuthPath,
        providerId: 'openai',
        credential: { type: 'oauth', access: 'older', refresh: 'older-refresh', expires: 100 },
      }),
      upsertOpenCodeAuthCredential({
        authPath: sourceAuthPath,
        providerId: 'openai',
        credential: { type: 'oauth', access: 'newer', refresh: 'newer-refresh', expires: 200 },
      }),
    ])
    const profileScope = await resolveOpenCodeProfileScope({
      projectPath, purpose: 'catalog', selectedModel: 'openai/catalog',
    })
    const prepared = await manager.prepareProfile(projectPath, { profileScope })

    expect(await readOpenCodeAuthCredential({
      authPath: prepared.managedAuthPath, providerId: 'openai',
    })).toMatchObject({ access: 'newer', expires: 200 })
  })

  test('captures an app-global API credential ahead of competing user auth', async () => {
    const manager = new OpenCodeProfileManager()
    const projectPath = path.join(tempDir, 'global-api-catalog-project')
    const globalAuthPath = manager.getGlobalAuthPath()
    const sourceAuthPath = path.join(process.env.XDG_DATA_HOME!, 'opencode', 'auth.json')
    await Promise.all([
      mkdir(projectPath, { recursive: true }),
      upsertOpenCodeAuthCredential({
        authPath: globalAuthPath,
        providerId: 'openai',
        credential: { type: 'api', key: 'app-global-key' },
      }),
      upsertOpenCodeAuthCredential({
        authPath: sourceAuthPath,
        providerId: 'openai',
        credential: { type: 'oauth', access: 'user-oauth', refresh: 'refresh', expires: 999 },
      }),
    ])
    const profileScope = await resolveOpenCodeProfileScope({
      projectPath, purpose: 'catalog', selectedModel: 'openai/catalog',
    })
    const prepared = await manager.prepareProfile(projectPath, { profileScope })

    expect(await readOpenCodeAuthCredential({
      authPath: prepared.managedAuthPath, providerId: 'openai',
    })).toEqual({ type: 'api', key: 'app-global-key' })
  })

  test('keeps generated OpenCode dependency caches outside per-profile HOME', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const previousMcpCommand = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND
    const previousMcpEntry = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY
    const previousMcpArgsJson = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON
    const previousMcpUrl = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL
    const appDataHome = path.join(tempDir, 'app-data')
    const appCacheHome = path.join(tempDir, 'app-cache')
    const mcpEntryPath = path.join(tempDir, 'agent-teams-mcp.js')
    await writeFile(mcpEntryPath, 'process.stdin.resume()\n', 'utf8')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome
    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND = process.execPath
    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY = mcpEntryPath
    delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON
    delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL
    try {
      const manager = new OpenCodeProfileManager()
      const profile = await manager.prepareProfile(path.join(tempDir, 'project'))
      const profileNodeModulesPath = path.join(profile.xdgConfigHome, 'opencode', 'node_modules')
      const sharedNodeModulesPath = path.join(profile.xdgCacheHome, 'config-node_modules')
      const tmpStat = await lstat(profile.tmpPath)
      const nodeModulesStat = await lstat(profileNodeModulesPath)
      const nodeModulesTarget = await readlink(profileNodeModulesPath)
      const appMcpConfig = (
        profile.managedConfig.mcp as Record<string, { environment?: Record<string, string> }>
      )?.['agent-teams']

      expect(profile.profileRootPath.startsWith(path.join(appDataHome, 'opencode', 'profiles'))).toBe(true)
      expect(profile.tmpPath).toBe(path.join(profile.profileRootPath, 'tmp'))
      expect(profile.env.TMPDIR).toBe(profile.tmpPath)
      expect(profile.env.TMP).toBe(profile.tmpPath)
      expect(profile.env.TEMP).toBe(profile.tmpPath)
      expect(tmpStat.isDirectory()).toBe(true)
      expect(profile.xdgCacheHome).toBe(path.join(appCacheHome, 'opencode', 'shared-cache'))
      expect(profile.env.NPM_CONFIG_CACHE).toBe(path.join(profile.xdgCacheHome, 'npm'))
      expect(profile.env.PLAYWRIGHT_BROWSERS_PATH).toBe(
        path.join(profile.xdgCacheHome, 'tools', 'ms-playwright'),
      )
      expect(profile.env.PUPPETEER_CACHE_DIR).toBe(
        path.join(profile.xdgCacheHome, 'tools', 'puppeteer'),
      )
      expect(profile.env.PIP_CACHE_DIR).toBe(path.join(profile.xdgCacheHome, 'tools', 'pip'))
      expect(profile.env.UV_CACHE_DIR).toBe(path.join(profile.xdgCacheHome, 'tools', 'uv'))
      expect(profile.env.npm_config_devdir).toBe(
        path.join(profile.xdgCacheHome, 'tools', 'node-gyp'),
      )
      expect(profile.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]).toBe(appDataHome)
      expect(profile.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]).toBe(appCacheHome)
      expect(appMcpConfig?.environment?.[CLAUDE_MULTIMODEL_DATA_HOME_ENV]).toBe(appDataHome)
      expect(appMcpConfig?.environment?.[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]).toBe(appCacheHome)
      expect(nodeModulesStat.isSymbolicLink()).toBe(true)
      expect(path.resolve(path.dirname(profileNodeModulesPath), nodeModulesTarget)).toBe(sharedNodeModulesPath)
    } finally {
      if (previousDataHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      }
      if (previousCacheHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      }
      if (previousMcpCommand === undefined) {
        delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND
      } else {
        process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND = previousMcpCommand
      }
      if (previousMcpEntry === undefined) {
        delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY
      } else {
        process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY = previousMcpEntry
      }
      if (previousMcpArgsJson === undefined) {
        delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON
      } else {
        process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON = previousMcpArgsJson
      }
      if (previousMcpUrl === undefined) {
        delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL
      } else {
        process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL = previousMcpUrl
      }
    }
  })

  test('does not add local environment keys to remote app MCP config', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const previousMcpUrl = process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = path.join(tempDir, 'app-data-remote-mcp')
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = path.join(tempDir, 'app-cache-remote-mcp')
    process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL = 'http://127.0.0.1:41004/mcp'
    try {
      const manager = new OpenCodeProfileManager()
      const profile = await manager.prepareProfile(path.join(tempDir, 'project-remote-mcp'))
      const appMcpConfig = (
        profile.managedConfig.mcp as Record<string, { environment?: Record<string, string> }>
      )?.['agent-teams']

      expect(appMcpConfig).toMatchObject({
        type: 'remote',
        url: 'http://127.0.0.1:41004/mcp',
      })
      expect(appMcpConfig?.environment).toBeUndefined()
    } finally {
      if (previousDataHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      }
      if (previousCacheHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      }
      if (previousMcpUrl === undefined) {
        delete process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL
      } else {
        process.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL = previousMcpUrl
      }
    }
  })

  test('repairs profile node_modules when a real directory was left behind', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const appDataHome = path.join(tempDir, 'app-data-repair')
    const appCacheHome = path.join(tempDir, 'app-cache-repair')
    const projectPath = path.join(tempDir, 'project-repair')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome
    try {
      await mkdir(projectPath, { recursive: true })
      const manager = new OpenCodeProfileManager()
      const firstProfile = await manager.prepareProfile(projectPath)
      const profileNodeModulesPath = path.join(
        firstProfile.xdgConfigHome,
        'opencode',
        'node_modules',
      )
      const sharedNodeModulesPath = path.join(
        firstProfile.xdgCacheHome,
        'config-node_modules',
      )
      const sharedExistingPackagePath = path.join(
        sharedNodeModulesPath,
        'existing-shared-package',
      )
      await mkdir(sharedExistingPackagePath, { recursive: true })
      await writeFile(
        path.join(sharedExistingPackagePath, 'package.json'),
        '{"source":"shared-cache"}\n',
        'utf8',
      )
      await rm(profileNodeModulesPath, { recursive: true, force: true })
      const manuallyInstalledPackagePath = path.join(
        profileNodeModulesPath,
        'manually-installed-package',
      )
      await mkdir(manuallyInstalledPackagePath, { recursive: true })
      await writeFile(
        path.join(manuallyInstalledPackagePath, 'package.json'),
        '{"name":"manually-installed-package"}\n',
        'utf8',
      )
      const conflictingProfilePackagePath = path.join(
        profileNodeModulesPath,
        'existing-shared-package',
      )
      await mkdir(conflictingProfilePackagePath, { recursive: true })
      await writeFile(
        path.join(conflictingProfilePackagePath, 'package.json'),
        '{"source":"profile-directory"}\n',
        'utf8',
      )

      const repairedProfile = await manager.prepareProfile(projectPath)
      const repairedStat = await lstat(profileNodeModulesPath)
      const repairedTarget = await readlink(profileNodeModulesPath)

      expect(repairedProfile.profileRootKey).toBe(firstProfile.profileRootKey)
      expect(repairedStat.isSymbolicLink()).toBe(true)
      expect(path.resolve(path.dirname(profileNodeModulesPath), repairedTarget)).toBe(
        sharedNodeModulesPath,
      )
      expect(
        await readFile(
          path.join(sharedNodeModulesPath, 'manually-installed-package', 'package.json'),
          'utf8',
        ),
      ).toBe(
        '{"name":"manually-installed-package"}\n',
      )
      expect(
        await readFile(
          path.join(sharedNodeModulesPath, 'existing-shared-package', 'package.json'),
          'utf8',
        ),
      ).toBe('{"source":"shared-cache"}\n')
    } finally {
      if (previousDataHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      }
      if (previousCacheHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      }
    }
  })

  test('preserves populated shared config node_modules across profile preparation', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const appDataHome = path.join(tempDir, 'app-data-preserve-config-modules')
    const appCacheHome = path.join(tempDir, 'app-cache-preserve-config-modules')
    const projectPath = path.join(tempDir, 'project-preserve-config-modules')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome
    try {
      await mkdir(projectPath, { recursive: true })
      const manager = new OpenCodeProfileManager()
      const firstProfile = await manager.prepareProfile(projectPath, {
        includeAppMcp: false,
        includeManagedSubscriptionPlugins: false,
      })
      const sharedNodeModulesPath = path.join(
        firstProfile.xdgCacheHome,
        'config-node_modules',
      )
      const profileNodeModulesPath = path.join(
        firstProfile.xdgConfigHome,
        'opencode',
        'node_modules',
      )
      const markerPath = path.join(sharedNodeModulesPath, 'installed-package.marker')
      await writeFile(markerPath, 'preserve me\n', 'utf8')

      const secondProfile = await manager.prepareProfile(projectPath, {
        includeAppMcp: false,
        includeManagedSubscriptionPlugins: false,
      })
      const nodeModulesStat = await lstat(profileNodeModulesPath)
      const nodeModulesTarget = await readlink(profileNodeModulesPath)

      expect(secondProfile.profileRootKey).toBe(firstProfile.profileRootKey)
      expect(await readFile(markerPath, 'utf8')).toBe('preserve me\n')
      expect(nodeModulesStat.isSymbolicLink()).toBe(true)
      expect(path.resolve(path.dirname(profileNodeModulesPath), nodeModulesTarget)).toBe(
        sharedNodeModulesPath,
      )
    } finally {
      if (previousDataHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      }
      if (previousCacheHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      }
    }
  })

  test('repairs an empty managed OpenCode plugin cache after an interrupted install', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const appDataHome = path.join(tempDir, 'app-data-plugin-repair')
    const appCacheHome = path.join(tempDir, 'app-cache-plugin-repair')
    const projectPath = path.join(tempDir, 'project-plugin-repair')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome
    try {
      await mkdir(projectPath, { recursive: true })
      const manager = new OpenCodeProfileManager()
      const firstProfile = await manager.prepareProfile(projectPath)
      const interruptedCachePath = path.join(
        firstProfile.xdgCacheHome,
        'opencode',
        'packages',
        'opencode-kiro@0.4.0',
      )
      await mkdir(interruptedCachePath, { recursive: true })

      await manager.prepareProfile(projectPath)

      const interruptedCacheStillExists = await lstat(interruptedCachePath)
        .then(() => true)
        .catch(() => false)
      expect(interruptedCacheStillExists).toBe(false)
    } finally {
      if (previousDataHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      }
      if (previousCacheHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      }
    }
  })

  test('serializes concurrent profile preparation for the same project profile', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const appDataHome = path.join(tempDir, 'app-data-concurrent')
    const appCacheHome = path.join(tempDir, 'app-cache-concurrent')
    const projectPath = path.join(tempDir, 'project-concurrent')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome
    try {
      await mkdir(projectPath, { recursive: true })
      const manager = new OpenCodeProfileManager()
      const prepareOptions = {
        includeAppMcp: false,
        includeManagedSubscriptionPlugins: false,
      } as const
      const firstProfile = await manager.prepareProfile(projectPath, prepareOptions)
      const profileNodeModulesPath = path.join(
        firstProfile.xdgConfigHome,
        'opencode',
        'node_modules',
      )
      await rm(profileNodeModulesPath, { recursive: true, force: true })
      await mkdir(profileNodeModulesPath, { recursive: true })

      const profiles = await Promise.all(
        Array.from({ length: 8 }, () => manager.prepareProfile(projectPath, prepareOptions)),
      )
      const repairedStat = await lstat(profileNodeModulesPath)
      const repairedTarget = await readlink(profileNodeModulesPath)

      expect(new Set(profiles.map(profile => profile.profileRootKey))).toEqual(
        new Set([firstProfile.profileRootKey]),
      )
      expect(repairedStat.isSymbolicLink()).toBe(true)
      expect(path.resolve(path.dirname(profileNodeModulesPath), repairedTarget)).toBe(
        path.join(firstProfile.xdgCacheHome, 'config-node_modules'),
      )
    } finally {
      if (previousDataHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      }
      if (previousCacheHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      }
    }
  }, 15_000)

  test('keeps later profile preparation queued when an earlier waiter is aborted', async () => {
    const manager = new OpenCodeProfileManager() as unknown as {
      withProfilePreparationLock<T>(
        profileRootKey: string,
        operation: () => Promise<T>,
        abortSignal?: AbortSignal,
      ): Promise<T>
    }
    let markFirstStarted!: () => void
    let releaseFirst!: () => void
    const firstStarted = new Promise<void>(resolve => {
      markFirstStarted = resolve
    })
    const firstRelease = new Promise<void>(resolve => {
      releaseFirst = resolve
    })
    let firstActive = false
    const first = manager.withProfilePreparationLock('abort-queue', async () => {
      firstActive = true
      markFirstStarted()
      try {
        await firstRelease
      } finally {
        firstActive = false
      }
    })
    await firstStarted

    const controller = new AbortController()
    const timeout = new Error('profile preparation deadline expired')
    let abortedOperationCalled = false
    const aborted = manager.withProfilePreparationLock('abort-queue', async () => {
      abortedOperationCalled = true
    }, controller.signal)
    controller.abort(timeout)
    await expect(aborted).rejects.toBe(timeout)

    let laterOperationCalled = false
    const later = manager.withProfilePreparationLock('abort-queue', async () => {
      laterOperationCalled = true
      expect(firstActive).toBe(false)
    })

    try {
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(abortedOperationCalled).toBe(false)
      expect(laterOperationCalled).toBe(false)
    } finally {
      releaseFirst()
      await first
      await later
    }
    expect(laterOperationCalled).toBe(true)
  })

  test('handles profile node_modules repair across separate process preparation races', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const appDataHome = path.join(tempDir, 'app-data-process-race')
    const appCacheHome = path.join(tempDir, 'app-cache-process-race')
    const projectPath = path.join(tempDir, 'project-process-race')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome
    try {
      await mkdir(projectPath, { recursive: true })
      const manager = new OpenCodeProfileManager()
      const firstProfile = await manager.prepareProfile(projectPath, { includeAppMcp: false })
      const profileNodeModulesPath = path.join(
        firstProfile.xdgConfigHome,
        'opencode',
        'node_modules',
      )
      await rm(profileNodeModulesPath, { recursive: true, force: true })
      await mkdir(profileNodeModulesPath, { recursive: true })
      await writeFile(path.join(profileNodeModulesPath, 'stale.txt'), 'stale directory\n', 'utf8')

      const profileManagerUrl = pathToFileURL(
        path.resolve('src/services/opencode/OpenCodeProfileManager.ts'),
      ).href
      const scriptPath = path.join(tempDir, 'prepare-opencode-profile.mjs')
      await writeFile(
        scriptPath,
        `const { OpenCodeProfileManager } = await import(${JSON.stringify(profileManagerUrl)});
const startAt = Number(process.argv[3]);
while (Date.now() < startAt) {
  await Bun.sleep(5);
}
await new OpenCodeProfileManager().prepareProfile(process.argv[2], { includeAppMcp: false });
`,
        'utf8',
      )
      const childEnv = {
        ...process.env,
        [CLAUDE_MULTIMODEL_DATA_HOME_ENV]: appDataHome,
        [CLAUDE_MULTIMODEL_CACHE_HOME_ENV]: appCacheHome,
      }

      const startAt = String(Date.now() + 750)
      await Promise.all(Array.from(
        { length: 12 },
        () => runBunScript(scriptPath, [projectPath, startAt], childEnv),
      ))

      const repairedStat = await lstat(profileNodeModulesPath)
      const repairedTarget = await readlink(profileNodeModulesPath)
      expect(repairedStat.isSymbolicLink()).toBe(true)
      expect(path.resolve(path.dirname(profileNodeModulesPath), repairedTarget)).toBe(
        path.join(firstProfile.xdgCacheHome, 'config-node_modules'),
      )
    } finally {
      if (previousDataHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      }
      if (previousCacheHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      }
    }
  }, 20_000)

  test('syncs app-global OpenCode auth before real local auth so fresh login wins conflicts', () => {
    expect(
      orderOpenCodeAuthSyncSources({
        globalAuthPath: '/Users/test/Library/Application Support/claude-multimodel-nodejs/opencode/auth.json',
        globalAuthFingerprint: 'old-global-openai',
        sourceAuthPath: '/Users/test/.local/share/opencode/auth.json',
        sourceAuthFingerprint: 'fresh-local-openai',
      })
    ).toEqual([
      '/Users/test/Library/Application Support/claude-multimodel-nodejs/opencode/auth.json',
      '/Users/test/.local/share/opencode/auth.json',
    ])
  })

  test('keeps canonical user OpenCode auth after isolated XDG auth sources', () => {
    expect(
      orderOpenCodeAuthSyncSources({
        globalAuthPath: '/Users/test/Library/Application Support/claude-multimodel-nodejs/opencode/auth.json',
        globalAuthFingerprint: 'old-global-openai',
        sourceAuthSources: [
          {
            path: '/tmp/isolated-xdg/opencode/auth.json',
            fingerprint: null,
          },
          {
            path: '/Users/test/.local/share/opencode/auth.json',
            fingerprint: 'fresh-local-openai',
          },
        ],
      })
    ).toEqual([
      '/Users/test/Library/Application Support/claude-multimodel-nodejs/opencode/auth.json',
      '/Users/test/.local/share/opencode/auth.json',
    ])
  })

  test('keeps managed config fingerprint stable across volatile app MCP environment values', async () => {
    const launchBase = await resolveOpenCodeAppMcpLaunchConfig({
      env: {
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: '/usr/local/bin/node',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: '/tmp/agent-teams-mcp.js',
        HOME: '/Users/test',
        PATH: '/usr/local/bin:/usr/bin',
      },
      pathExists: async () => false,
    })
    const launchVolatile = await resolveOpenCodeAppMcpLaunchConfig({
      env: {
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: '/usr/local/bin/node',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: '/tmp/agent-teams-mcp.js',
        HOME: '/Users/test',
        PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin',
        TMPDIR: '/var/folders/runtime-a',
        CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:43123',
      },
      pathExists: async () => false,
    })
    const baseFingerprint = buildManagedConfigFingerprint(buildManagedConfig(launchBase.config))
    const volatileFingerprint = buildManagedConfigFingerprint(
      buildManagedConfig(launchVolatile.config)
    )

    expect(volatileFingerprint).toBe(baseFingerprint)
  })

  test('keeps managed config fingerprint stable across remote app MCP URL port drift', async () => {
    const launchFirst = await resolveOpenCodeAppMcpLaunchConfig({
      env: {
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:41001/mcp',
      },
      pathExists: async () => false,
    })
    const launchSecond = await resolveOpenCodeAppMcpLaunchConfig({
      env: {
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_URL: 'http://127.0.0.1:41002/mcp',
      },
      pathExists: async () => false,
    })

    expect(
      buildManagedConfigFingerprint(buildManagedConfig(launchSecond.config))
    ).toBe(buildManagedConfigFingerprint(buildManagedConfig(launchFirst.config)))
  })

  test('still changes managed config fingerprint when the MCP command changes', async () => {
    const launchNode = await resolveOpenCodeAppMcpLaunchConfig({
      env: {
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: '/usr/local/bin/node',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: '/tmp/agent-teams-mcp.js',
      },
      pathExists: async () => false,
    })
    const launchBun = await resolveOpenCodeAppMcpLaunchConfig({
      env: {
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: '/Users/belief/.bun/bin/bun',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: '/tmp/agent-teams-mcp.js',
      },
      pathExists: async () => false,
    })

    expect(
      buildManagedConfigFingerprint(buildManagedConfig(launchNode.config))
    ).not.toBe(buildManagedConfigFingerprint(buildManagedConfig(launchBun.config)))
  })

  test('disables OpenCode auto-update by default but keeps an explicit app override possible', () => {
    const managedConfig = buildManagedConfig()
    const overrideConfig = buildManagedConfig(null, { allowAutoUpdate: true })

    expect(managedConfig.autoupdate).toBe(false)
    expect(overrideConfig).not.toHaveProperty('autoupdate')
    expect(applyOpenCodeAutoUpdatePolicy({}).OPENCODE_DISABLE_AUTOUPDATE).toBe('1')
    expect(
      applyOpenCodeAutoUpdatePolicy({
        CLAUDE_TEAM_OPENCODE_ALLOW_AUTOUPDATE: '1',
        OPENCODE_DISABLE_AUTOUPDATE: '1',
      }).OPENCODE_DISABLE_AUTOUPDATE,
    ).toBeUndefined()
  })

  test('adds an app-managed default model only when explicitly configured', () => {
    const managedConfig = buildManagedConfig(null, {
      defaultModelId: 'openrouter/openai/gpt-oss-20b:free',
    })

    expect(managedConfig.model).toBe('openrouter/openai/gpt-oss-20b:free')
    expect(buildManagedConfig().model).toBeUndefined()
  })

  test('applies all-projects default to project profiles without overrides', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const appDataHome = path.join(tempDir, 'app-data-all-projects-default')
    const appCacheHome = path.join(tempDir, 'app-cache-all-projects-default')
    const projectA = path.join(tempDir, 'project-a')
    const projectB = path.join(tempDir, 'project-b')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome

    try {
      await mkdir(projectA, { recursive: true })
      await mkdir(projectB, { recursive: true })
      await setOpenCodeManagedGlobalDefaultModel(
        appDataHome,
        'openrouter/openai/gpt-oss-20b:free',
      )

      const manager = new OpenCodeProfileManager()
      const profileA = await manager.prepareProfile(projectA, { includeAppMcp: false })
      const profileB = await manager.prepareProfile(projectB, { includeAppMcp: false })

      expect(profileA.managedConfig.model).toBe('openrouter/openai/gpt-oss-20b:free')
      expect(profileB.managedConfig.model).toBe('openrouter/openai/gpt-oss-20b:free')
      expect(profileA.projectDefaultModelId).toBeNull()
      expect(profileA.allProjectsDefaultModelId).toBe('openrouter/openai/gpt-oss-20b:free')
      expect(profileA.effectiveManagedDefaultSource).toBe('all_projects')
    } finally {
      if (previousDataHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      }
      if (previousCacheHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      }
    }
  })

  test('project default overrides all-projects default', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const appDataHome = path.join(tempDir, 'app-data-project-default-wins')
    const appCacheHome = path.join(tempDir, 'app-cache-project-default-wins')
    const projectPath = path.join(tempDir, 'project-default-wins')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome

    try {
      await mkdir(projectPath, { recursive: true })
      await setOpenCodeManagedGlobalDefaultModel(appDataHome, 'openrouter/global-model')
      const manager = new OpenCodeProfileManager()
      const initialProfile = await manager.prepareProfile(projectPath, { includeAppMcp: false })
      await setOpenCodeManagedDefaultModel(initialProfile.profileRootPath, 'openrouter/project-model')

      const profile = await manager.prepareProfile(projectPath, { includeAppMcp: false })

      expect(profile.managedConfig.model).toBe('openrouter/project-model')
      expect(profile.projectDefaultModelId).toBe('openrouter/project-model')
      expect(profile.allProjectsDefaultModelId).toBe('openrouter/global-model')
      expect(profile.effectiveManagedDefaultSource).toBe('project')
    } finally {
      if (previousDataHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      }
      if (previousCacheHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      }
    }
  })

  test('applies app-managed local model limits without changing user or project config', async () => {
    const previousDataHome = process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
    const previousCacheHome = process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
    const appDataHome = path.join(tempDir, 'app-data-local-limits')
    const appCacheHome = path.join(tempDir, 'app-cache-local-limits')
    const projectPath = path.join(tempDir, 'project-local-limits')
    const projectConfigPath = path.join(projectPath, 'opencode.json')
    process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = appDataHome
    process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = appCacheHome

    try {
      await mkdir(projectPath, { recursive: true })
      await writeFile(
        projectConfigPath,
        JSON.stringify({ provider: { local: { models: { qwen: { name: 'Qwen local' } } } } }),
      )
      const originalProjectConfig = await readFile(projectConfigPath, 'utf8')
      const manager = new OpenCodeProfileManager()
      const initialProfile = await manager.prepareProfile(projectPath, { includeAppMcp: false })
      await setOpenCodeManagedModelLimits(initialProfile.profileRootPath, {
        modelId: 'local/qwen',
        contextTokens: 128_000,
        outputTokens: 32_000,
      })

      const profile = await manager.prepareProfile(projectPath, { includeAppMcp: false })

      expect(profile.managedConfig).toMatchObject({
        provider: {
          local: {
            models: {
              qwen: {
                limit: { context: 128_000, output: 32_000 },
              },
            },
          },
        },
      })
      expect(await readFile(projectConfigPath, 'utf8')).toBe(originalProjectConfig)
    } finally {
      if (previousDataHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_DATA_HOME_ENV] = previousDataHome
      }
      if (previousCacheHome === undefined) {
        delete process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV]
      } else {
        process.env[CLAUDE_MULTIMODEL_CACHE_HOME_ENV] = previousCacheHome
      }
    }
  }, 15_000)

  test('can cap a provider-scoped model output limit in managed config overrides', () => {
    const managedConfig = buildManagedConfig(null, {
      modelOutputLimitOverrides: [
        {
          modelId: 'openrouter/anthropic/claude-3.5-haiku',
          outputTokens: 512,
          contextTokens: 32_000,
        },
      ],
    })

    expect(managedConfig.provider).toMatchObject({
      atlascloud: {
        npm: '@ai-sdk/openai-compatible',
        options: {
          baseURL: 'https://api.atlascloud.ai/v1',
        },
        models: {
          'zai-org/glm-5.1': {
            tool_call: true,
          },
        },
      },
      openrouter: {
        models: {
          'anthropic/claude-3.5-haiku': {
            limit: {
              context: 32_000,
              output: 512,
            },
          },
        },
      },
    })
  })
})


test('managed execution pins the reviewed native cancellation route despite ambient SDK/pool overrides', () => {
  const env = { CURSOR_ACP_BACKEND: 'sdk', CURSOR_ACP_AGENT_POOL: 'true',
    CURSOR_ACP_SESSION_RESUME: 'true', CURSOR_ACP_REUSE_EXISTING_PROXY: 'true',
    CURSOR_ACP_TOOL_LOOP_MODE: 'cursor' }
  applyCursorManagedExecutionEnvironment(env)
  expect(env).toMatchObject({ CURSOR_ACP_BACKEND: 'cursor-agent', CURSOR_ACP_AGENT_POOL: 'false',
    CURSOR_ACP_SESSION_RESUME: 'false', CURSOR_ACP_REUSE_EXISTING_PROXY: 'false',
    CURSOR_ACP_TOOL_LOOP_MODE: 'opencode' })
})

test('Cursor retained port state separates host generations and is stable for unchanged identity', () => {
  const inputs = { assetsIdentity: 'assets', nativeIdentity: 'account-a', scopeToken: 'scope', configFingerprint: 'config',
    projectPath: '/project', profileRootKey: 'profile', projectBehaviorFingerprint: 'agents-a',
    binaryHostIdentity: 'binary-a', transportIdentity: 'raw-mcp-a' }
  const generation = buildCursorHostGeneration(inputs)
  expect(buildCursorHostGeneration({ ...inputs })).toBe(generation)
  for (const field of Object.keys(inputs) as Array<keyof typeof inputs>) {
    expect(buildCursorHostGeneration({ ...inputs, [field]: 'changed' })).not.toBe(generation)
  }
})

test('complete Cursor wrapper uses discovered absolute CLI and owned mcptool with spaces and short PATH', async () => {
  if (process.platform === 'win32') return
  const root = await mkdtemp(path.join(os.tmpdir(), "cursor wrapper user's "))
  try {
    const bin = path.join(root, '.local/bin')
    const obsolete = path.join(root, 'obsolete bin')
    await mkdir(bin, { recursive: true })
    await mkdir(obsolete)
    const native = path.join(bin, 'cursor-agent')
    await writeFile(native, '#!/bin/sh\nprintf "native:%s:%s:%s:%s\\n" "$HOME" "$XDG_CONFIG_HOME" "$CURSOR_CONFIG_DIR" "$1"\nmcptool "$2"\n', { mode: 0o700 })
    await writeFile(path.join(obsolete, 'mcptool'), '#!/bin/sh\necho obsolete\n', { mode: 0o700 })
    const cli = path.join(root, 'managed mcp cli')
    await writeFile(cli, '#!/bin/sh\nprintf "managed:%s" "$1"\n', { mode: 0o700 })
    const env = { HOME: root, PATH: `${obsolete}:/usr/bin:/bin`, XDG_CONFIG_HOME: path.join(root, 'native config'), CURSOR_CONFIG_DIR: path.join(root, 'isolated cursor config') }
    const bridge = await ensureOpenCodeNativeCliCredentialBridge(path.join(root, 'profile'), env, 'darwin', {
      pluginEntryPath: path.join(root, 'plugin.js'), mcpToolPath: cli, interpreterPath: '/bin/sh', fingerprint: 'fixture',
    }, path.join(root, 'profile config.json'))
    expect(bridge.cursorAgentHostCommand).toBe(await realpath(native))
    const output = await runCommandCapture(bridge.cursorAgentExecutablePath, ['a b', 'c d'], {
      HOME: '/wrong', XDG_CONFIG_HOME: '/wrong', PATH: bridge.binPath,
    })
    expect(output).toBe(`native:${root}:${env.XDG_CONFIG_HOME}:${env.CURSOR_CONFIG_DIR}:a b\nmanaged:c d`)
  } finally { await rm(root, { recursive: true, force: true }) }
})

describe('ensureSelectedOpenCodeModelInImportedConfig', () => {
  test('adds the selected local model to an imported Ollama allowlist', () => {
    const config = {
      provider: {
        ollama: {
          npm: '@ai-sdk/openai-compatible',
          models: { 'qwen2.5-coder:0.5b': {} },
        },
      },
    }
    ensureSelectedOpenCodeModelInImportedConfig(
      config,
      'ollama/qwen2.5-coder:7b-32k',
      'launch_runtime',
    )
    expect(config.provider.ollama.models).toEqual({
      'qwen2.5-coder:0.5b': {},
      'qwen2.5-coder:7b-32k': {},
    })
  })

  test('does not shrink a live-discovery Ollama provider', () => {
    const config = {
      provider: {
        ollama: { models: {} },
      },
    }
    ensureSelectedOpenCodeModelInImportedConfig(
      config,
      'ollama/qwen2.5-coder:7b-32k',
      'launch_runtime',
    )
    expect(config.provider.ollama.models).toEqual({})
  })

  test('leaves catalog scopes and placeholder models untouched', () => {
    const config = {
      provider: {
        ollama: { models: { 'qwen2.5-coder:0.5b': {} } },
      },
    }
    ensureSelectedOpenCodeModelInImportedConfig(config, 'ollama/qwen2.5-coder:7b-32k', 'catalog')
    ensureSelectedOpenCodeModelInImportedConfig(config, 'ollama/oauth-authority', 'launch_runtime')
    expect(config.provider.ollama.models).toEqual({ 'qwen2.5-coder:0.5b': {} })
  })
})
