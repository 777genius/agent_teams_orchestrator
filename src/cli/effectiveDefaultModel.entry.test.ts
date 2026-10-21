import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { access, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const entry = fileURLToPath(new URL('../entrypoints/cli.tsx', import.meta.url))
const bun = process.versions.bun
  ? process.execPath
  : (process.env.TEST_RUNTIME_STATUS_BUN ?? 'bun')

test(
  'real source CLI resolves applied settings before publishing inherited model',
  { timeout: 60_000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), 'TEST-effective-default-entry-'))
    const paths: string[] = []
    const inferenceModels: string[] = []
    const rootMethods: string[] = []
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
      paths.push(pathname)
      if (pathname === '/v1/messages') {
        let raw = ''
        request.on('data', (chunk) => {
          raw += chunk.toString()
        })
        request.on('end', () => {
          const body = JSON.parse(raw)
          inferenceModels.push(body.model)
          const message = {
            id: 'msg_fixture',
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          }
          if (!body.stream) {
            response.setHeader('content-type', 'application/json')
            response.end(
              JSON.stringify({
                ...message,
                content: [{ type: 'text', text: 'OK' }],
                stop_reason: 'end_turn',
              }),
            )
            return
          }
          response.setHeader('content-type', 'text/event-stream')
          for (const event of [
            { type: 'message_start', message },
            {
              type: 'content_block_start',
              index: 0,
              content_block: { type: 'text', text: '' },
            },
            {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: 'OK' },
            },
            { type: 'content_block_stop', index: 0 },
            {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn', stop_sequence: null },
              usage: { output_tokens: 1 },
            },
            { type: 'message_stop' },
          ])
            response.write(
              `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
          response.end()
        })
        return
      }
      if (pathname === '/') {
        rootMethods.push(request.method ?? '')
        response.end('OK')
        return
      }
      if (pathname !== '/v1/models' || request.method !== 'GET') {
        response.statusCode = 404
        response.end()
        return
      }
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          data: [{ id: 'first-listed' }, { id: 'gateway-selected' }],
        }),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert(address && typeof address === 'object')
    const baseUrl = `http://127.0.0.1:${address.port}`
    const config = join(home, '.claude')
    await mkdir(config, { recursive: true })
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
    const comSpec = process.env.ComSpec ?? process.env.COMSPEC
    const env = {
      // Source startup can initialize Windows OS helpers; inference also needs
      // Git Bash even with tools disabled. Keep provider launchers isolated by
      // exposing only the system directory and the explicit shell.
      ...(process.platform === 'win32'
        ? {
            SystemRoot: systemRoot,
            WINDIR: systemRoot,
            ComSpec: comSpec,
            PATHEXT: '.COM;.EXE;.BAT;.CMD',
            CLAUDE_CODE_GIT_BASH_PATH: (
              await import('../utils/windowsPaths.js')
            ).findGitBashPath(),
          }
        : {}),
      PATH:
        process.platform === 'win32' && systemRoot
          ? join(systemRoot, 'System32')
          : '',
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: config,
      APPDATA: join(home, 'appdata'),
      LOCALAPPDATA: join(home, 'local-appdata'),
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_CACHE_HOME: join(home, '.cache'),
      NODE_ENV: 'development',
      CI: '1',
      CLAUDE_CODE_ENTRY_PROVIDER: 'anthropic',
      CLAUDE_CODE_SIMPLE: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
      ANTHROPIC_BASE_URL: baseUrl,
      ANTHROPIC_AUTH_TOKEN: 'fixture-only',
      ANTHROPIC_API_KEY: 'fixture-only',
    }
    let childNumber = 0
    async function run(
      args: string[],
      extraEnv: Record<string, string>,
      cwd = home,
    ) {
      const invocation = ++childNumber
      const started = performance.now()
      const firstPath = paths.length
      const firstRootMethod = rootMethods.length
      const child = spawn(
        bun,
        ['--no-install', '--no-env-file', entry, ...args],
        {
          cwd,
          env: { ...env, ...extraEnv },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      let stdout = '',
        stderr = ''
      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      child.stderr.on('data', (data: Buffer) => {
        stderr += data.toString()
      })
      let watchdogTriggered = false
      const timer = setTimeout(() => {
        watchdogTriggered = true
        child.kill('SIGKILL')
      }, 20_000)
      function failureDetails(
        code: number | null,
        signal: NodeJS.Signals | null,
        error?: unknown,
      ) {
        let stdoutState = stdout.length ? 'non-json-or-incomplete' : 'empty'
        if (stdout.length) {
          try {
            JSON.parse(stdout)
            stdoutState = 'valid-json'
          } catch {
            // Preserve incomplete output as diagnostic evidence.
          }
        }
        return JSON.stringify({
          invocation,
          args,
          code,
          signal,
          elapsedMs: Math.round(performance.now() - started),
          watchdogTriggered,
          stdoutState,
          stdoutChars: stdout.length,
          stderrChars: stderr.length,
          stdoutTail: stdout.slice(-2048),
          stderrTail: stderr.slice(-2048),
          httpPathCount: paths.length - firstPath,
          httpPaths: paths.slice(firstPath).slice(-32),
          rootMethods: rootMethods.slice(firstRootMethod).slice(-32),
          ...(error ? { error: String(error) } : {}),
        })
      }
      try {
        const { code, signal } = await new Promise<{
          code: number | null
          signal: NodeJS.Signals | null
        }>((resolve, reject) => {
          child.once('error', (error) =>
            reject(new Error(failureDetails(null, null, error))),
          )
          child.once('close', (code, signal) => resolve({ code, signal }))
        })
        const details = failureDetails(code, signal)
        assert.equal(code, 0, details)
        assert.equal(signal, null, details)
        assert.doesNotMatch(
          stderr,
          /'chcp' is not recognized as an internal or external command/i,
          details,
        )
        return { stdout, stderr }
      } finally {
        clearTimeout(timer)
      }
    }
    async function status(
      extraEnv: Record<string, string>,
      summary = false,
      cwd = home,
    ) {
      const result = await run(
        [
          'runtime',
          'status',
          '--json',
          '--provider',
          'anthropic',
          ...(summary ? ['--summary'] : []),
        ],
        extraEnv,
        cwd,
      )
      return JSON.parse(result.stdout).providers.anthropic
    }
    try {
      if (process.platform === 'win32') {
        assert(systemRoot && isAbsolute(systemRoot), 'Expected absolute SystemRoot')
        assert(comSpec && isAbsolute(comSpec), 'Expected absolute ComSpec')
        await access(comSpec)
        // Exercise the real OS command in the exact fixture environment without
        // warming the source CLI or an unrelated provider SDK beforehand.
        const codepage = spawnSync(comSpec, ['/d', '/s', '/c', 'chcp'], {
          cwd: home,
          env,
          encoding: 'utf8',
          timeout: 5_000,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        const details = JSON.stringify({
          command: 'chcp',
          code: codepage.status,
          signal: codepage.signal,
          error: codepage.error?.message,
          stdoutTail: codepage.stdout?.slice(-2048),
          stderrTail: codepage.stderr?.slice(-2048),
        })
        assert.equal(codepage.status, 0, details)
        assert.match(codepage.stdout, /\b\d+\b/, details)
      }
      const auto = await status({
        AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE: 'auto',
        ANTHROPIC_MODEL: 'gateway-selected',
      })
      assert.equal(auto.effectiveDefaultModel, 'gateway-selected')
      assert.equal(auto.modelCatalog.defaultLaunchModel, 'first-listed')
      await writeFile(
        join(config, 'settings.json'),
        JSON.stringify({
          env: {
            ANTHROPIC_MODEL: 'sonnet',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'gateway-selected',
          },
        }),
      )
      const compatible = await status({
        AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE: 'compatible',
        ANTHROPIC_MODEL: 'ambient-model',
      })
      assert.equal(compatible.effectiveDefaultModel, 'gateway-selected')
      assert.equal(compatible.statusCheckOutcome, 'authoritative')
      assert.equal(compatible.verificationState, 'verified')
      const prompt = await run(
        [
          '--print',
          'Reply OK',
          '--output-format',
          'json',
          '--max-turns',
          '1',
          '--tools',
          '',
          '--no-session-persistence',
          '--model',
          compatible.effectiveDefaultModel,
        ],
        {
          AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE: 'compatible',
        },
      )
      assert.equal(JSON.parse(prompt.stdout).is_error, false)
      assert.equal(JSON.parse(prompt.stdout).result, 'OK')
      assert.deepEqual(inferenceModels, [compatible.effectiveDefaultModel])
      const direct = await status(
        {
          AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE: 'api_key',
          ANTHROPIC_BASE_URL: '',
          ANTHROPIC_AUTH_TOKEN: '',
        },
        true,
      )
      assert.equal(direct.effectiveDefaultModel, null)
      await writeFile(join(config, 'settings.json'), '{}')
      for (const model of ['project-alpha', 'project-beta']) {
        const project = join(home, model)
        await mkdir(join(project, '.claude'), { recursive: true })
        await writeFile(
          join(project, '.claude', 'settings.json'),
          JSON.stringify({ model }),
        )
        const scoped = await status(
          { AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE: 'auto' },
          false,
          project,
        )
        assert.equal(scoped.effectiveDefaultModel, model)
      }
      assert(
        paths.length >= 5 &&
          paths.every((path) =>
            ['/', '/v1/models', '/v1/messages'].includes(path),
          ),
        JSON.stringify(paths),
      )
      assert(rootMethods.every((method) => method === 'HEAD'))
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await rm(home, { recursive: true, force: true })
    }
  },
)
