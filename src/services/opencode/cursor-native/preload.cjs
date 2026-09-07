'use strict'
const cp = require('node:child_process')
const { syncBuiltinESMExports } = require('node:module')
const socket = process.env.CURSOR_OWNER_SOCKET
const token = process.env.CURSOR_OWNER_TOKEN
const gate = process.env.CURSOR_OWNER_GATE
const scope = process.env.CURSOR_OWNER_SCOPE
const previous = process.env.CURSOR_OWNER_NODE_OPTIONS || ''
delete process.env.CURSOR_OWNER_SOCKET
delete process.env.CURSOR_OWNER_TOKEN
delete process.env.CURSOR_OWNER_GATE
delete process.env.CURSOR_OWNER_NODE_OPTIONS
if (previous) process.env.NODE_OPTIONS = previous
else delete process.env.NODE_OPTIONS
if (!socket || !token || !gate) throw new Error('Missing request owner')
const original = cp.spawn
cp.spawn = function ownedSpawn(command, args, options) {
  if (!Array.isArray(args)) { options = args || {}; args = [] }
  options ||= {}
  // An explicit env would drop the inherited marker that teardown sweeps for.
  if (scope && options.env && options.env.CURSOR_OWNER_SCOPE !== scope) {
    options = { ...options, env: { ...options.env, CURSOR_OWNER_SCOPE: scope } }
  }
  if (!options.detached) return original.call(this, command, args, options)
  // Do not approximate shell:true quoting or IPC/argv0 contracts outside this slice.
  if (options.shell || options.argv0 || options.stdio?.includes?.('ipc')) {
    throw new Error('Unsupported detached spawn contract in request owner')
  }
  return original.call(this, gate, [command, ...args], {
    ...options, detached: false,
    env: { ...(options.env || process.env), CURSOR_OWNER_SOCKET: socket, CURSOR_OWNER_TOKEN: token },
  })
}
syncBuiltinESMExports()
const parent = process.ppid
setInterval(() => {
  if (process.ppid === parent) return
  try { process.kill(-process.pid, 'SIGKILL') } catch { process.kill(process.pid, 'SIGKILL') }
}, 100).unref()

