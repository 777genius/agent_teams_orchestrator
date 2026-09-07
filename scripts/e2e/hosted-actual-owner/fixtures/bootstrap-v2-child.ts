import { readFileSync, writeFileSync, appendFileSync, fstatSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { readHostedControlBootstrapV2 } from '../../../../src/services/hostedControl/HostedControlBootstrapV2.js'
import { SELECTED_LAUNCH_PHASE } from '../../../../src/services/hostedControl/HostedControlSelectedLaunchPhase.js'
import { HostedControlServer } from '../../../../src/services/hostedControl/HostedControlServer.js'
import { HostedApprovalDeferredManifestV2 } from '../../../../src/services/hostedControl/HostedApprovalDeferredManifestV2.js'
import { HostedApprovalActivatablePort } from '../../../../src/services/hostedControl/HostedApprovalActivatablePort.js'
import { createHostedApprovalActivationV2PinsForTest } from '../../../../src/services/hostedControl/HostedApprovalActivationV2Pins.js'
import { hostedControlAuthorityFromConfig, hostedControlOwnerIdentityFromConfig } from '../../../../src/services/hostedControl/HostedControlRuntimeConfig.js'
import { HOSTED_CONTROL_SOCKET_BROKER_FLAG, runHostedControlSocketBroker } from '../../../../src/services/hostedControl/HostedControlSocketBroker.js'
import { createNativeWalImagesV2 } from '../native-wal-images-v2.js'
import assert from 'node:assert/strict'
import { activationGolden } from '../../../../src/services/hostedControl/fixtures/bootstrapV2Producer.js'
import { checkPretransfer, checkEffect, checkRawDescriptor } from './bootstrap-v2-regressions.js'
import type { HostedApprovalActivationConnection } from '../../../../src/services/hostedControl/HostedApprovalActivationSession.js'
import type { HostedApprovalWirePort } from '../../../../src/services/hostedControl/HostedApprovalWire.js'

if (process.argv[2] === HOSTED_CONTROL_SOCKET_BROKER_FLAG) await runHostedControlSocketBroker(process.argv.slice(3))
const [selectionPath, resultPath, scenario] = process.argv.slice(2)
let bootstrap: Awaited<ReturnType<typeof readHostedControlBootstrapV2>> | undefined
let server: HostedControlServer | undefined
const closed = (fd: number) => { try { fstatSync(fd); return false } catch { return true } }
try {
  bootstrap = await readHostedControlBootstrapV2({ modulePath: process.argv[1],
    ...(scenario.startsWith('selection-') ? { selectionPhase: SELECTED_LAUNCH_PHASE } : {}),
    selectLaunch: () => JSON.parse(readFileSync(selectionPath, 'utf8')) })
  const oneUseClosed = [4, 7, 11].map(closed)
  if (scenario === 'wal-images') {
    const images = await createNativeWalImagesV2(bootstrap, dirname(resultPath))
    try {
      assert.equal(images.isHealthy(), true)
      assert.deepEqual(images.receipts(), [])
      await assert.rejects(createNativeWalImagesV2(bootstrap, dirname(resultPath)))
      assert.equal(images.isHealthy(), true)
    } finally { images.close() }
    writeFileSync(resultPath, JSON.stringify({ ok: true, checked: scenario }))
  } else if (scenario.startsWith('raw-')) {
    await checkRawDescriptor(bootstrap, scenario)
    writeFileSync(resultPath, JSON.stringify({ ok: true, checked: scenario }))
  } else if (scenario.startsWith('pretransfer-')) {
    const checks = await checkPretransfer(bootstrap, scenario)
    writeFileSync(resultPath, JSON.stringify({ ok: true, ...checks }))
  } else if (!scenario.startsWith('activation')) {
    writeFileSync(resultPath, JSON.stringify({ ok: true, oneUseClosed, roles: bootstrap.header.descriptorMap.descriptors.map(d => [d.role, d.childFd]) }))
  } else {
    const admitted = bootstrap, port = new HostedApprovalActivatablePort()
    let retained!: HostedApprovalActivationConnection
    const authority = hostedControlAuthorityFromConfig(admitted.config)
    server = new HostedControlServer({ socketPath: admitted.config.socketPath, secret: admitted.secret, authority,
      ownerIdentity: hostedControlOwnerIdentityFromConfig(admitted.config),
      activationTransport: 'inherited-v2',
      service: { async mutate() { throw new Error('unit fixture has no effects') } },
      beforeActivationFrameWriteForTest: (phase, socket) => {
        if (phase === 'ready' && scenario.startsWith('activation-effect')) {
          socket.pause() // Hold bytes in the kernel until the synchronous effect fence.
          void checkEffect(() => retained, admitted.activation, resultPath).catch(error => {
            writeFileSync(resultPath + '.effect', JSON.stringify({ error: String(error) }))
          })
        }
      },
      activationSessionFactory: connection => {
        retained = connection
        const session = HostedApprovalDeferredManifestV2.forTest({
          proofKey: admitted.secret, connection, port, expectedHost: admitted.expectedHost,
          rawAdmissionPath: join(dirname(resultPath), 'admission.json'),
          authority: { snapshot: () => ({ authority, ownerBinding: connection.ownerBinding,
            socketPath: admitted.config.socketPath, ...admitted.approvalActivationV2 }),
            assertBootstrapCurrent: () => admitted.guard.assertCurrent(), assertRootCurrent: () => true },
          recover: async () => {
            appendFileSync(resultPath + '.adopted', 'verified-before-adoption')
            return { claimIngress: async () => [], acknowledgeIngress: async () => false,
              getAdmittedIngressAuthority: async () => null, resolveIngressAuthority: async () => null,
              authorizeDecision: async () => false, deliverDecision: async () => { throw new Error('no unit effect') },
              reconcileDecision: async () => { throw new Error('no unit effect') } } as HostedApprovalWirePort
          },
        }, createHostedApprovalActivationV2PinsForTest({ publicKeySpkiDer: Buffer.from(activationGolden.signing.publicKeySpkiDerBase64url, 'base64url'),
          publicKeyDigest: activationGolden.signing.publicKeyDigest, contractDigest: activationGolden.signing.contractDigest }))
        return {
          activate: async frame => {
            try { return await session.activate(frame) } catch (error) {
              writeFileSync(resultPath + '.rejection', String(error)); throw error
            }
          },
          revoke: () => session.revoke(),
        }
      },
    })
    await server.start()
    server.attachInheritedActivationV2(admitted.activation)
    let repeatedRejected = false
    // Repeated take rejects without destroying the first admitted connection.
    try { admitted.activation.take() } catch { repeatedRejected = true }
    let repeatedAttachmentRejected = false
    try { server.attachInheritedActivationV2(admitted.activation) } catch { repeatedAttachmentRejected = true }
    writeFileSync(resultPath, JSON.stringify({ ok: true, oneUseClosed, ownerBinding: server.ownerBinding,
      repeatedRejected, repeatedAttachmentRejected }))
  }
  await bootstrap.guard.lost
} catch (error) {
  writeFileSync(resultPath, JSON.stringify({ ok: false, error: String(error), oneUseClosed: [4, 7, 11].map(closed) }))
} finally { await server?.stop(); await bootstrap?.close() }
