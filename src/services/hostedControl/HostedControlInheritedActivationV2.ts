import { Socket } from 'node:net'
import { OwnedDescriptorV2, sameDescriptorV2, snapshotV2, type DescriptorSnapshotV2 } from './HostedControlBootstrapV2Descriptors.js'
import { requireV2 } from './HostedControlBootstrapV2Wire.js'

const admitted = new WeakSet<object>()
/** A descriptor owner, not an authentication or custody brand. Only bootstrap
 * admission constructs this resource; the server transfers its exact FD once. */
export class HostedControlInheritedActivationV2 {
  #descriptor: OwnedDescriptorV2 | null
  #socket: Socket | null = null
  #closed = false
  private constructor(descriptor: OwnedDescriptorV2, private readonly snapshot: DescriptorSnapshotV2) {
    this.#descriptor = descriptor; admitted.add(this)
  }
  static retain(descriptor: OwnedDescriptorV2, snapshot: DescriptorSnapshotV2): HostedControlInheritedActivationV2 {
    requireV2(snapshot.role === 'activation-v2' && snapshot.childFd === 5 && descriptor.fd === 5 &&
      sameDescriptorV2(snapshot, snapshotV2('activation-v2')), 'activation_descriptor')
    return new HostedControlInheritedActivationV2(descriptor, snapshot)
  }
  take(): Socket {
    requireV2(admitted.has(this) && this.#descriptor && this.isCurrent(), 'activation_consumed')
    const owner = this.#descriptor; this.#descriptor = null
    try {
      const socket = new Socket({ fd: owner.fd, readable: true, writable: true, allowHalfOpen: false })
      owner.take(); this.#socket = socket
      socket.on('error', () => undefined)
      socket.once('close', () => { this.#closed = true })
      socket.pause()
      return socket
    } catch (error) { owner.close(); this.#closed = true; throw error }
  }
  isCurrent(): boolean {
    if (this.#closed || this.#socket?.destroyed) return false
    try { return sameDescriptorV2(this.snapshot, snapshotV2('activation-v2')) } catch { return false }
  }
  close(): void {
    this.#closed = true; this.#descriptor?.close(); this.#descriptor = null
    this.#socket?.destroy()
  }
}
