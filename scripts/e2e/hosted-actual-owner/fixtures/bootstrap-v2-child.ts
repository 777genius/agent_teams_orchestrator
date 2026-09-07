import { readFileSync, writeFileSync, appendFileSync, fstatSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { readHostedControlBootstrapV2 } from '../../../../src/services/hostedControl/HostedControlBootstrapV2.js'
import { HostedControlServer } from '../../../../src/services/hostedControl/HostedControlServer.js'
import { HostedApprovalDeferredManifestV2 } from '../../../../src/services/hostedControl/HostedApprovalDeferredManifestV2.js'
import { HostedApprovalActivatablePort } from '../../../../src/services/hostedControl/HostedApprovalActivatablePort.js'
import { createHostedApprovalActivationV2PinsForTest } from '../../../../src/services/hostedControl/HostedApprovalActivationV2Pins.js'
import { hostedControlAuthorityFromConfig, hostedControlOwnerIdentityFromConfig } from '../../../../src/services/hostedControl/HostedControlRuntimeConfig.js'
import { HOSTED_CONTROL_SOCKET_BROKER_FLAG, runHostedControlSocketBroker } from '../../../../src/services/hostedControl/HostedControlSocketBroker.js'
import { activationGolden } from '../../../../src/services/hostedControl/fixtures/bootstrapV2Producer.js'
import type { HostedApprovalWirePort } from '../../../../src/services/hostedControl/HostedApprovalWire.js'

if (process.argv[2] === HOSTED_CONTROL_SOCKET_BROKER_FLAG) await runHostedControlSocketBroker(process.argv.slice(3))
const [selectionPath, resultPath, scenario] = process.argv.slice(2)
let bootstrap: Awaited<ReturnType<typeof readHostedControlBootstrapV2>> | undefined
let server: HostedControlServer | undefined
const closed = (fd: number) => { try { fstatSync(fd); return false } catch { return true } }
try {
  bootstrap = await readHostedControlBootstrapV2({ modulePath: process.argv[1],
    selectLaunch: () => JSON.parse(readFileSync(selectionPath, 'utf8')) })
  const oneUseClosed = [4, 7, 11].map(closed)
  if (scenario !== 'activation') {
    writeFileSync(resultPath, JSON.stringify({ ok: true, oneUseClosed, roles: bootstrap.header.descriptorMap.descriptors.map(d => [d.role, d.childFd]) }))
  } else {
    const admitted = bootstrap, port = new HostedApprovalActivatablePort()
    const authority = hostedControlAuthorityFromConfig(admitted.config)
    server = new HostedControlServer({ socketPath: admitted.config.socketPath, secret: admitted.secret, authority,
      ownerIdentity: hostedControlOwnerIdentityFromConfig(admitted.config),
      activationTransport: 'inherited-v2',
      service: { async mutate() { throw new Error('unit fixture has no effects') } },
      activationSessionFactory: connection => HostedApprovalDeferredManifestV2.forTest({
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
        publicKeyDigest: activationGolden.signing.publicKeyDigest, contractDigest: activationGolden.signing.contractDigest })),
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
