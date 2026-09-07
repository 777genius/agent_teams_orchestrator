/** The stream operations used by the control server. node:net.Socket implements
 * this directly; an inherited descriptor does not pretend to be a Socket. */
export type HostedControlConnectionEvents = {
  data: [Buffer]; end: []; close: [boolean]; error: [Error]; timeout: []; drain: []
}
export interface HostedControlConnection {
  readonly destroyed: boolean
  on<E extends keyof HostedControlConnectionEvents>(event: E, listener: (...args: HostedControlConnectionEvents[E]) => void): this
  once<E extends keyof HostedControlConnectionEvents>(event: E, listener: (...args: HostedControlConnectionEvents[E]) => void): this
  off<E extends keyof HostedControlConnectionEvents>(event: E, listener: (...args: HostedControlConnectionEvents[E]) => void): this
  pause(): this
  resume(): this
  setTimeout(milliseconds: number, callback?: () => void): this
  write(data: string | Uint8Array, callback?: (error?: Error | null) => void): boolean
  end(data?: string | Uint8Array): this
  destroy(error?: Error): this
}
