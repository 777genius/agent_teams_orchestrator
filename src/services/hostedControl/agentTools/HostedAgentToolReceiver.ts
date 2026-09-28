import type { Socket } from 'node:net'

import {
  decodeHostedAgentToolRequest,
  hostedAgentToolResponse,
  HOSTED_AGENT_TOOL_MAX_FRAME_BYTES,
  type HostedAgentToolRequest,
  type HostedAgentToolResponse,
} from './HostedAgentToolContract.js'
import { HostedAgentToolEffectGate } from './HostedAgentToolEffectGate.js'
import { HostedAgentToolWal, type HostedAgentToolBinding } from './HostedAgentToolWal.js'

type Context = HostedAgentToolRequest['context']
export type HostedAgentTaskCall = Readonly<{ binding: Readonly<HostedAgentToolBinding>; taskId: string;
  messageID?: string; callID: string; signal: AbortSignal }>
type TaskCall = HostedAgentTaskCall
type TextTaskCall = TaskCall & Readonly<{ text: string }>
type MessageCall = Readonly<{
  binding: Readonly<HostedAgentToolBinding>
  to: string
  text: string
  taskRefs: readonly { teamName: string; taskId: string }[]
  messageID?: string
  callID: string
  signal: AbortSignal
}>

/** Effects receive only Owner-bound identity and validated tool arguments. */
export type HostedAgentToolExecutors = Readonly<{
  hosted_task_get: (call: TaskCall) => Promise<string>
  hosted_task_start: (call: TaskCall) => Promise<string>
  hosted_task_complete: (call: TaskCall) => Promise<string>
  hosted_task_add_comment: (call: TextTaskCall) => Promise<string>
  hosted_message_send: (call: MessageCall) => Promise<string>
}>

export type HostedAgentToolReceiverOptions = Readonly<{
  /** This socket has already passed Owner's private FD3 peer authentication. */
  socket: Socket
  binding: HostedAgentToolBinding
  teamName: string
  gate: HostedAgentToolEffectGate
  wal: HostedAgentToolWal
  isCurrent: (binding: Readonly<HostedAgentToolBinding>, context: Context) => boolean | Promise<boolean>
  canSendTo: (to: string, binding: Readonly<HostedAgentToolBinding>) => boolean | Promise<boolean>
  executors: HostedAgentToolExecutors
}>

const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const decoder = new TextDecoder('utf-8', { fatal: true })

/** Inactive until an authenticated Owner runtime explicitly constructs it. */
export class HostedAgentToolReceiver {
  readonly #binding: Readonly<HostedAgentToolBinding>
  #buffer = Buffer.alloc(0)
  #processing = false
  #closed = false
  #connectionAbort = new AbortController()

  constructor(private readonly options: HostedAgentToolReceiverOptions) {
    this.#binding = Object.freeze({ ...options.binding })
    options.socket.on('data', chunk => this.#onData(chunk))
    options.socket.on('end', () => this.close())
    options.socket.on('close', () => this.close())
    options.socket.on('error', () => this.close())
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#connectionAbort.abort(new Error('Hosted agent tool socket closed'))
    this.options.socket.destroy()
  }

  #onData(chunk: unknown): void {
    if (this.#closed) return
    if (this.#processing || !Buffer.isBuffer(chunk) ||
      this.#buffer.length + chunk.length > HOSTED_AGENT_TOOL_MAX_FRAME_BYTES + 4) {
      this.close()
      return
    }
    this.#buffer = Buffer.concat([this.#buffer, chunk])
    if (this.#buffer.length < 4) return
    const length = this.#buffer.readUInt32BE(0)
    if (length === 0 || length > HOSTED_AGENT_TOOL_MAX_FRAME_BYTES ||
      this.#buffer.length > length + 4) {
      this.close()
      return
    }
    if (this.#buffer.length < length + 4) return
    const bytes = this.#buffer.subarray(4)
    this.#buffer = Buffer.alloc(0)
    this.#processing = true
    void this.#respond(bytes).catch(() => this.close())
  }

  async #respond(bytes: Buffer): Promise<void> {
    let request: HostedAgentToolRequest
    try {
      request = decodeHostedAgentToolRequest(decoder.decode(bytes))
      if (!REQUEST_ID.test(request.requestId) || request.context.sessionID !== this.#binding.sessionID ||
        request.tool === 'hosted_message_send' &&
        (request.args as { taskRefs?: readonly { teamName: string }[] }).taskRefs?.some(
          ref => ref.teamName !== this.options.teamName,
        )) throw new Error('Hosted agent tool authority mismatch')
    } catch {
      this.close()
      return
    }
    const response = await this.#process(request)
    if (this.#closed) return
    const frame = encodeResponse(response)
    const written = new Promise<void>((resolve, reject) => {
      this.options.socket.write(frame, error => error ? reject(error) : resolve())
    })
    // The peer can send its next call as soon as it sees these bytes, before
    // Node invokes the local write callback.
    this.#processing = false
    await written
  }

  async #process(request: HostedAgentToolRequest): Promise<HostedAgentToolResponse> {
    const unavailable = () => hostedAgentToolResponse(request.requestId, { error: 'unavailable' })
    const operatorRequired = () => hostedAgentToolResponse(request.requestId, { error: 'operator_required' })
    try {
      const gated = await this.options.gate.withCurrentMemberEffect(
        () => this.#isCurrent(request),
        async gateSignal => {
          if (request.tool === 'hosted_message_send' &&
            !(await this.options.canSendTo((request.args as { to: string }).to, this.#binding))) {
            return unavailable()
          }
          if (gateSignal.aborted || !(await this.#isCurrent(request)) || gateSignal.aborted) return unavailable()
          const decision = await this.options.wal.begin({ binding: this.#binding, request })
          if (decision.kind === 'conflict') return hostedAgentToolResponse(request.requestId, { error: 'conflict' })
          if (decision.kind === 'operator_required') return operatorRequired()
          if (decision.kind === 'replay') {
            const replay = hostedAgentToolResponse(request.requestId, { result: decision.result })
            encodeResponse(replay)
            return replay
          }
          if (gateSignal.aborted || !(await this.#isCurrent(request)) || gateSignal.aborted) {
            return operatorRequired()
          }
          const signal = AbortSignal.any([gateSignal, this.#connectionAbort.signal])
          if (signal.aborted || this.#closed) return operatorRequired()
          const result = await this.#execute(request, signal)
          // Ensure terminal bytes can actually pass the plugin's 64 KiB frame cap.
          const response = hostedAgentToolResponse(request.requestId, { result })
          encodeResponse(response)
          const completion = await this.options.wal.complete({ binding: this.#binding, request, result })
          return completion === 'conflict' ? operatorRequired() : response
        },
      )
      return gated.kind === 'unavailable' ? unavailable() : gated.value
    } catch {
      // The effect may have happened. Its unresolved WAL intent forbids retry.
      return operatorRequired()
    }
  }

  async #isCurrent(request: HostedAgentToolRequest): Promise<boolean> {
    if (this.#closed || this.#connectionAbort.signal.aborted ||
      request.context.sessionID !== this.#binding.sessionID) return false
    const current = await this.options.isCurrent(this.#binding, request.context)
    return current && !this.#closed && !this.#connectionAbort.signal.aborted
  }

  #execute(request: HostedAgentToolRequest, signal: AbortSignal): Promise<string> {
    const binding = this.#binding
    switch (request.tool) {
      case 'hosted_task_get':
      case 'hosted_task_start':
      case 'hosted_task_complete': {
        const args = request.args as { taskId: string }
        return this.options.executors[request.tool]({ binding, taskId: args.taskId,
          messageID: request.context.messageID, callID: request.context.callID, signal })
      }
      case 'hosted_task_add_comment': {
        const args = request.args as { taskId: string; text: string }
        return this.options.executors.hosted_task_add_comment({ binding, ...args,
          messageID: request.context.messageID, callID: request.context.callID, signal })
      }
      case 'hosted_message_send': {
        const args = request.args as { to: string; text: string; taskRefs?: readonly { teamName: string; taskId: string }[] }
        return this.options.executors.hosted_message_send({ binding, to: args.to, text: args.text,
          taskRefs: args.taskRefs ?? [], messageID: request.context.messageID,
          callID: request.context.callID, signal })
      }
    }
  }
}

function encodeResponse(response: HostedAgentToolResponse): Buffer {
  const bytes = Buffer.from(JSON.stringify(response), 'utf8')
  if (bytes.length === 0 || bytes.length > HOSTED_AGENT_TOOL_MAX_FRAME_BYTES) {
    throw new Error('Hosted agent tool response exceeds FD3 frame')
  }
  const frame = Buffer.allocUnsafe(4 + bytes.length)
  frame.writeUInt32BE(bytes.length, 0)
  bytes.copy(frame, 4)
  return frame
}
