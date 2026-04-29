import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  quoteWindowsCmdArg,
  resolveDirectWindowsLauncher,
  spawnPortableCli,
  spawnSyncPortableCli,
} from './portableCli.js'

const originalPlatform = process.platform

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', {
    value,
    configurable: true,
  })
}

afterEach(() => {
  setPlatform(originalPlatform)
})

describe('portableCli Windows launcher resolution', () => {
  test('resolves npm cmd shims to the underlying node script', async () => {
    setPlatform('win32')
    const tempDir = await mkdtemp(path.join(tmpdir(), 'portable-cli-test-'))
    try {
      const scriptPath = path.join(tempDir, 'codex.js')
      const shimPath = path.join(tempDir, 'codex.cmd')
      await writeFile(scriptPath, 'console.log("ok")\n', 'utf8')
      await writeFile(
        shimPath,
        [
          '@ECHO off',
          'SETLOCAL',
          'IF EXIST "%dp0%\\node.exe" (',
          '  SET "_prog=%dp0%\\node.exe"',
          ') ELSE (',
          '  SET "_prog=node"',
          ')',
          'endLocal & "%_prog%" "%dp0%codex.js" %*',
          '',
        ].join('\n'),
        'utf8',
      )

      expect(resolveDirectWindowsLauncher(shimPath)).toEqual({
        command: 'node',
        argsPrefix: [scriptPath],
      })
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('resolves extensionless npm node cmd shims to the underlying node script', async () => {
    setPlatform('win32')
    const tempDir = await mkdtemp(path.join(tmpdir(), 'portable-cli-test-'))
    try {
      const scriptDir = path.join(tempDir, 'node_modules', 'opencode-ai', 'bin')
      const scriptPath = path.join(scriptDir, 'opencode')
      const shimPath = path.join(tempDir, 'opencode.cmd')
      await mkdir(scriptDir, { recursive: true })
      await writeFile(scriptPath, 'console.log("ok")\n', 'utf8')
      await writeFile(
        shimPath,
        [
          '@ECHO off',
          'GOTO start',
          ':find_dp0',
          'SET dp0=%~dp0',
          'EXIT /b',
          ':start',
          'SETLOCAL',
          'CALL :find_dp0',
          'IF EXIST "%dp0%\\node.exe" (',
          '  SET "_prog=%dp0%\\node.exe"',
          ') ELSE (',
          '  SET "_prog=node"',
          ')',
          'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\opencode-ai\\bin\\opencode" %*',
          '',
        ].join('\n'),
        'utf8',
      )

      expect(resolveDirectWindowsLauncher(shimPath)).toEqual({
        command: 'node',
        argsPrefix: [scriptPath],
      })
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('escapes cmd metacharacters for fallback shell launches', () => {
    setPlatform('win32')

    expect(quoteWindowsCmdArg('A&B')).toBe('"A&B"')
    expect(quoteWindowsCmdArg('%PATH%')).toBe('""^%"PATH"^%""')
    expect(quoteWindowsCmdArg('plain-value')).toBe('plain-value')
  })

  test('does not rewrite launchers on macOS or Linux', async () => {
    setPlatform('darwin')
    const tempDir = await mkdtemp(path.join(tmpdir(), 'portable-cli-test-'))
    try {
      const shimPath = path.join(tempDir, 'codex.cmd')
      await writeFile(shimPath, 'echo should-not-parse\n', 'utf8')

      expect(resolveDirectWindowsLauncher(shimPath)).toBeNull()
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  test('spawns npm cmd shims through node without invoking cmd.exe', async () => {
    setPlatform('win32')
    const tempDir = await mkdtemp(path.join(tmpdir(), 'portable-cli-test-'))
    try {
      const scriptPath = path.join(tempDir, 'codex.js')
      const shimPath = path.join(tempDir, 'codex.cmd')
      await writeFile(
        scriptPath,
        'console.log(JSON.stringify(process.argv.slice(2)))\n',
        'utf8',
      )
      await writeFile(
        shimPath,
        [
          '@ECHO off',
          'SETLOCAL',
          'IF EXIST "%dp0%\\node.exe" (',
          '  SET "_prog=%dp0%\\node.exe"',
          ') ELSE (',
          '  SET "_prog=node"',
          ')',
          'endLocal & "%_prog%" "%dp0%codex.js" %*',
          '',
        ].join('\n'),
        'utf8',
      )

      const child = spawnPortableCli(
        shimPath,
        ['exec', 'A&B', '%PATH%'],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      child.stdout?.on('data', chunk => stdoutChunks.push(Buffer.from(chunk)))
      child.stderr?.on('data', chunk => stderrChunks.push(Buffer.from(chunk)))

      const exitCode = await new Promise<number | null>((resolve, reject) => {
        child.once('error', reject)
        child.once('close', resolve)
      })

      expect(exitCode).toBe(0)
      expect(Buffer.concat(stderrChunks).toString('utf8')).toBe('')
      expect(JSON.parse(Buffer.concat(stdoutChunks).toString('utf8'))).toEqual([
        'exec',
        'A&B',
        '%PATH%',
      ])

      const syncResult = spawnSyncPortableCli(
        shimPath,
        ['login', 'status'],
        { encoding: 'utf8' },
      )

      expect(syncResult.status).toBe(0)
      expect(syncResult.stderr).toBe('')
      expect(JSON.parse(String(syncResult.stdout))).toEqual(['login', 'status'])
    } finally {
      await rm(tempDir, { recursive: true, force: true })
    }
  })
})
