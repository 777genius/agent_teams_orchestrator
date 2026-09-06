import { createOwnerProvenanceNodeOperations, createOwnerWalPublicationProducerFromEnvironment,
  HOSTED_OWNER_PROVENANCE_ENV, type OwnerWalImageCustodian, type OwnerWalPublicationProducer,
} from '../../../src/services/hostedControl/HostedApprovalOwnerProvenance.js'
import type { HostedControlBootstrapAdmissionV2 } from '../../../src/services/hostedControl/HostedControlBootstrapV2.js'
import { OwnedDescriptorV2 } from '../../../src/services/hostedControl/HostedControlBootstrapV2Descriptors.js'
import { requireV2 } from '../../../src/services/hostedControl/HostedControlBootstrapV2Wire.js'

/** Called only inside verified activation recovery. The existing W2 constructor
 * receives the admitted capsule explicitly; it never reads process.env here.
 * The actual disk image custodian remains the composition's P2B responsibility. */
export function createNativePublicationV2(bootstrap: HostedControlBootstrapAdmissionV2,
  modulePath: string, imageCustodian: OwnerWalImageCustodian): OwnerWalPublicationProducer {
  const descriptor = new OwnedDescriptorV2(bootstrap.ownerNative.resource.take())
  const operations = createOwnerProvenanceNodeOperations()
  try {
    requireV2(descriptor.fd === 9, 'native_descriptor')
    const producer = createOwnerWalPublicationProducerFromEnvironment({
      environment: Object.freeze({ [HOSTED_OWNER_PROVENANCE_ENV]: bootstrap.ownerNative.producerCapsule }),
      modulePath, imageCustodian,
      operations: { ...operations, close(fd) {
        requireV2(fd === 9, 'native_descriptor'); descriptor.close()
      } },
    })
    requireV2(producer, 'native_capsule_missing')
    return producer
  } catch (error) { descriptor.close(); throw error }
}
