import type { OpenCodeV2Pin } from '../compatibility/OpenCodeGenerationPolicy.js'

/** Read only the selected server's concrete IPv4 loopback listener. Effect 4
 * stable changed TcpAddress into an InetAddressV4 with an opaque IP value. */
export function openCodeV2ServerLoopbackUrl(pin: OpenCodeV2Pin, value: unknown): string {
  const invalid = () => { throw new Error('execution_server_address_invalid') }
  if (!value || typeof value !== 'object') return invalid()
  const address = value as Record<string, unknown>
  const loopback = pin === '2.0.0'
    ? address._tag === 'TcpAddress' && address.hostname === '127.0.0.1'
    : pin === '2.0.32' && address._tag === 'InetAddressV4' &&
      address.address !== null && typeof address.address === 'object' &&
      '_tag' in address.address && address.address._tag === 'Ipv4Address' && String(address.address) === '127.0.0.1'
  if (!loopback || !Number.isSafeInteger(address.port) || Number(address.port) < 1 || Number(address.port) > 65535) return invalid()
  return `http://127.0.0.1:${address.port}`
}
