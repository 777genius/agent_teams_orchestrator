import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import {
  buildCursorAgentResourceExhaustedPreloadScript,
  patchCursorAgentResourceExhaustedClassification,
} from './OpenCodeCursorResourceExhaustedPatch.js'

const CURSOR_CLASSIFIER_FIXTURE = [
  'const c={yM:{',
  "FREE_USER_USAGE_LIMIT:'free',",
  "GENERIC_RATE_LIMIT_EXCEEDED:'generic',",
  "RESOURCE_EXHAUSTED:'resource'",
  '}};',
  'R=new Set([c.yM.FREE_USER_USAGE_LIMIT,c.yM.GENERIC_RATE_LIMIT_EXCEEDED]);',
].join('')

describe('OpenCodeCursorResourceExhaustedPatch', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map(tempDir =>
      rm(tempDir, { recursive: true, force: true })
    ))
  })

  test('adds RESOURCE_EXHAUSTED to the unique Cursor action-required set', () => {
    const result = patchCursorAgentResourceExhaustedClassification(
      CURSOR_CLASSIFIER_FIXTURE,
    )

    expect(result).toMatchObject({ applied: true, compatible: true })
    expect(result.source).toContain(
      'c.yM.GENERIC_RATE_LIMIT_EXCEEDED,c.yM.RESOURCE_EXHAUSTED',
    )
    expect(
      patchCursorAgentResourceExhaustedClassification(result.source),
    ).toMatchObject({ applied: false, compatible: true })
  })

  test('fails closed when the Cursor bundle shape is ambiguous', () => {
    const result = patchCursorAgentResourceExhaustedClassification(
      `${CURSOR_CLASSIFIER_FIXTURE}${CURSOR_CLASSIFIER_FIXTURE}`,
    )

    expect(result).toEqual({
      source: `${CURSOR_CLASSIFIER_FIXTURE}${CURSOR_CLASSIFIER_FIXTURE}`,
      applied: false,
      compatible: false,
    })
  })

  test('preload patches the entry module and does not leak itself through NODE_OPTIONS', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'cursor-resource-patch-'))
    tempDirs.push(tempDir)
    const preloadPath = path.join(tempDir, 'resource-exhausted-preload.cjs')
    const entryPath = path.join(tempDir, 'index.js')
    await Promise.all([
      writeFile(preloadPath, buildCursorAgentResourceExhaustedPreloadScript(), 'utf8'),
      writeFile(
        entryPath,
        `${CURSOR_CLASSIFIER_FIXTURE}process.stdout.write(JSON.stringify({patched:R.has(c.yM.RESOURCE_EXHAUSTED),nodeOptions:process.env.NODE_OPTIONS||null}))`,
        'utf8',
      ),
    ])

    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn('node', [entryPath], {
        env: {
          ...process.env,
          NODE_OPTIONS: `--require="${preloadPath}" --no-warnings`,
          AGENT_TEAMS_CURSOR_ORIGINAL_NODE_OPTIONS: '--no-warnings',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => { stdout += String(chunk) })
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.once('error', reject)
      child.once('close', code => {
        if (code === 0) resolve(stdout)
        else reject(new Error(`node exited with ${code}: ${stderr}`))
      })
    })

    expect(JSON.parse(output)).toEqual({
      patched: true,
      nodeOptions: '--no-warnings',
    })
  })

  test('preload restores the loader after an incompatible entry module', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'cursor-resource-patch-'))
    tempDirs.push(tempDir)
    const preloadPath = path.join(tempDir, 'resource-exhausted-preload.cjs')
    const entryPath = path.join(tempDir, 'index.js')
    const secondaryPath = path.join(tempDir, 'secondary.js')
    await Promise.all([
      writeFile(preloadPath, buildCursorAgentResourceExhaustedPreloadScript(), 'utf8'),
      writeFile(
        entryPath,
        "process.stdout.write(JSON.stringify({patched:require('./secondary.js')}))",
        'utf8',
      ),
      writeFile(
        secondaryPath,
        `${CURSOR_CLASSIFIER_FIXTURE}module.exports=R.has(c.yM.RESOURCE_EXHAUSTED)`,
        'utf8',
      ),
    ])

    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn('node', [entryPath], {
        env: {
          ...process.env,
          NODE_OPTIONS: `--require="${preloadPath}"`,
          AGENT_TEAMS_CURSOR_ORIGINAL_NODE_OPTIONS: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', chunk => { stdout += String(chunk) })
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.once('error', reject)
      child.once('close', code => {
        if (code === 0) resolve(stdout)
        else reject(new Error(`node exited with ${code}: ${stderr}`))
      })
    })

    expect(JSON.parse(output)).toEqual({ patched: false })
  })
})
