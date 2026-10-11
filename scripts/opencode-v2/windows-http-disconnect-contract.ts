import assert from 'node:assert/strict'
import { createWindowsExecutionHttpClient } from '../../src/services/opencode/host/windows/OpenCodeV2WindowsHTTP.js'

// Deterministic protocol contract; native qualification is a separate probe.
export async function verifyWindowsHttpDisconnectContract() {
  let releaseCredit!: () => void, observedCredit!: () => void
  const creditHeld = new Promise<void>(resolve => { releaseCredit = resolve })
  const creditObserved = new Promise<void>(resolve => { observedCredit = resolve })
  let client: ReturnType<typeof createWindowsExecutionHttpClient>, id = ''
  client = createWindowsExecutionHttpClient(async frame => {
    id = String(frame.id)
    if (frame.action === 'request') client.accept({ type: 'windowsHTTP', id, action: 'head', status: 200, statusText: 'OK', headers: [], body: true })
    if (frame.action === 'credit') { observedCredit(); await creditHeld }
  }, () => {})
  client.bindOrigin('http://127.0.0.1:43127')
  const response = await client.fetch('http://127.0.0.1:43127/disconnect')
  const reader = response.body!.getReader(), pendingRead = reader.read()
  void pendingRead.catch(() => undefined)
  client.accept({ type: 'windowsHTTP', id, action: 'data', direction: 'response', bytes: Buffer.from('stale-after-disconnect').toString('base64') })
  const terminal = new Error('execution_containment_launcher_denied')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([creditObserved, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('contract_credit_deadline')), 1000) })])
    clearTimeout(timer)
    client.fail(terminal)
    // Failure must reject immediately, independently of the pending credit ACK.
    await assert.rejects(Promise.race([pendingRead, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('contract_disconnect_deadline')), 1000) })]), error => error === terminal)
  } finally { clearTimeout(timer); releaseCredit() }
  await assert.rejects(reader.read(), error => error === terminal)
  return { protocolContractOnly: true, nativeQualified: false, pendingReadBeforeDisconnect: true, creditHeldAtDisconnect: true, rejectedBeforeCreditAck: true, terminalErrorIdentityPreserved: true }
}

if (import.meta.main) console.log(JSON.stringify(await verifyWindowsHttpDisconnectContract()))
