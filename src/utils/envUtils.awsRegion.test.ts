import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  clearAWSRegionCache,
  getAWSRegion,
  resolveAWSRegion,
} from './envUtils.js'
import { clearAwsIniCache } from './aws.js'

const AWS_ENV_KEYS = [
  'AWS_CONFIG_FILE',
  'AWS_DEFAULT_REGION',
  'AWS_PROFILE',
  'AWS_REGION',
  'AWS_SHARED_CREDENTIALS_FILE',
  'CLAUDE_CODE_SKIP_BEDROCK_AUTH',
] as const

describe('AWS region resolution', () => {
  let tempRoot = ''
  let originalEnv = new Map<string, string | undefined>()

  beforeEach(async () => {
    originalEnv = new Map(AWS_ENV_KEYS.map(key => [key, process.env[key]]))
    tempRoot = await mkdtemp(join(tmpdir(), 'aws-region-resolution-'))
    clearAWSRegionCache()
    for (const key of AWS_ENV_KEYS) delete process.env[key]
  })

  afterEach(async () => {
    for (const key of AWS_ENV_KEYS) {
      const value = originalEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    clearAWSRegionCache()
    await rm(tempRoot, { recursive: true, force: true })
  })

  test('prefers AWS_REGION and AWS_DEFAULT_REGION over profile files', async () => {
    process.env.AWS_REGION = ' eu-central-1 '
    process.env.AWS_DEFAULT_REGION = 'ap-south-1'

    expect(getAWSRegion()).toBe('eu-central-1')
    expect(await resolveAWSRegion()).toBe('eu-central-1')

    delete process.env.AWS_REGION
    expect(getAWSRegion()).toBe('ap-south-1')
    expect(await resolveAWSRegion()).toBe('ap-south-1')
  })

  test(
    'uses the active profile with AWS SDK file precedence',
    async () => {
      const credentialsPath = join(tempRoot, 'credentials')
      const configPath = join(tempRoot, 'config')
      await writeFile(
        credentialsPath,
        '[demo]\nregion = eu-west-1\naws_access_key_id = test\naws_secret_access_key = test\n',
      )
      await writeFile(configPath, '[profile demo]\nregion = ap-southeast-2\n')
      process.env.AWS_PROFILE = 'demo'
      process.env.AWS_SHARED_CREDENTIALS_FILE = credentialsPath
      process.env.AWS_CONFIG_FILE = configPath

      expect(await resolveAWSRegion()).toBe('eu-west-1')
      expect(getAWSRegion()).toBe('eu-west-1')

      process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH = '1'
      const { createBedrockRuntimeClient } = await import('./model/bedrock.js')
      const client = await createBedrockRuntimeClient()
      try {
        expect(await client.config.region()).toBe('eu-west-1')
      } finally {
        client.destroy()
      }
    },
    30_000,
  )

  test('reloads a changed profile region after the AWS INI cache is cleared', async () => {
    const credentialsPath = join(tempRoot, 'credentials')
    const configPath = join(tempRoot, 'config')
    await writeFile(
      credentialsPath,
      '[demo]\nregion = eu-west-1\naws_access_key_id = test\naws_secret_access_key = test\n',
    )
    await writeFile(configPath, '')
    process.env.AWS_PROFILE = 'demo'
    process.env.AWS_SHARED_CREDENTIALS_FILE = credentialsPath
    process.env.AWS_CONFIG_FILE = configPath

    expect(await resolveAWSRegion()).toBe('eu-west-1')

    await writeFile(
      credentialsPath,
      '[demo]\nregion = ap-south-1\naws_access_key_id = test\naws_secret_access_key = test\n',
    )
    await clearAwsIniCache()

    expect(await resolveAWSRegion()).toBe('ap-south-1')
    expect(getAWSRegion()).toBe('ap-south-1')
  })

  test('falls back to us-east-1 when no env or profile region exists', async () => {
    process.env.AWS_PROFILE = 'missing'
    process.env.AWS_SHARED_CREDENTIALS_FILE = join(tempRoot, 'missing-credentials')
    process.env.AWS_CONFIG_FILE = join(tempRoot, 'missing-config')

    expect(await resolveAWSRegion()).toBe('us-east-1')
    expect(getAWSRegion()).toBe('us-east-1')
  })
})
