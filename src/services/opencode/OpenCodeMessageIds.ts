import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'

const BASE62_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const OPEN_CODE_ID_RANDOM_SUFFIX_LENGTH = 14
const OPEN_CODE_MESSAGE_TIME_HEX_LENGTH = 12
const OPEN_CODE_PROMPT_COUNTER_SLOT = 0
const OPEN_CODE_COUNTER_MODULUS = 0x1000n
const OPEN_CODE_CANONICAL_MESSAGE_ID_PATTERN = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const OPEN_CODE_PROMPT_ORDERING_MESSAGE_ID_PATTERN = /^msg_/
const OPEN_CODE_PROMPT_MAX_LOCAL_CLOCK_WAIT_MS = 250

let lastReservedPromptTimestampMs = 0

function normalizeTimestampMs(value: number): number {
  return Math.max(0, Math.trunc(Number.isFinite(value) ? value : Date.now()))
}

function normalizeCounter(value: number): number {
  const counter = Math.trunc(value)
  if (counter < 0 || counter >= Number(OPEN_CODE_COUNTER_MODULUS)) {
    throw new Error(`OpenCode id counter must be between 0 and 4095, received ${value}`)
  }
  return counter
}

function encodeOpenCodeAscendingTime(timestampMs: number, counter: number): string {
  const encoded = BigInt(normalizeTimestampMs(timestampMs)) * OPEN_CODE_COUNTER_MODULUS
    + BigInt(normalizeCounter(counter))
  const timeBytes = Buffer.alloc(6)
  for (let index = 0; index < 6; index += 1) {
    timeBytes[index] = Number((encoded >> BigInt(40 - 8 * index)) & 0xffn)
  }
  return timeBytes.toString('hex')
}

function buildRandomBase62Suffix(length: number): string {
  const bytes = randomBytes(length)
  let result = ''
  for (let index = 0; index < length; index += 1) {
    result += BASE62_CHARS[bytes[index] % BASE62_CHARS.length]
  }
  return result
}

function normalizeRandomSuffix(value?: string): string {
  if (value === undefined) {
    return buildRandomBase62Suffix(OPEN_CODE_ID_RANDOM_SUFFIX_LENGTH)
  }
  if (
    value.length !== OPEN_CODE_ID_RANDOM_SUFFIX_LENGTH ||
    [...value].some(char => !BASE62_CHARS.includes(char))
  ) {
    throw new Error('OpenCode id random suffix must be 14 base62 characters')
  }
  return value
}

export function isCanonicalOpenCodeAscendingMessageId(value: string | null | undefined): value is string {
  return typeof value === 'string' && OPEN_CODE_CANONICAL_MESSAGE_ID_PATTERN.test(value)
}

export function getGreatestCanonicalOpenCodeMessageId(
  messageIds: Iterable<string | null | undefined>,
): string | null {
  let latest: string | null = null
  for (const messageId of messageIds) {
    if (!isCanonicalOpenCodeAscendingMessageId(messageId)) {
      continue
    }
    if (!latest || messageId > latest) {
      latest = messageId
    }
  }
  return latest
}

export function getGreatestOpenCodePromptOrderingMessageId(
  messageIds: Iterable<string | null | undefined>,
): string | null {
  let latest: string | null = null
  for (const messageId of messageIds) {
    if (typeof messageId !== 'string' || !OPEN_CODE_PROMPT_ORDERING_MESSAGE_ID_PATTERN.test(messageId)) {
      continue
    }
    if (!latest || messageId > latest) {
      latest = messageId
    }
  }
  return latest
}

export function getOpenCodeAscendingMessageIdTimestampSlot(messageId: string): number | null {
  if (!isCanonicalOpenCodeAscendingMessageId(messageId)) {
    return null
  }
  const encoded = BigInt(`0x${messageId.slice(4, 4 + OPEN_CODE_MESSAGE_TIME_HEX_LENGTH)}`)
  return Number(encoded / OPEN_CODE_COUNTER_MODULUS)
}

export function buildOpenCodeRuntimePromptMessageId(input: {
  timestampMs?: number
  counter?: number
  randomSuffix?: string
} = {}): string {
  const timestampMs = normalizeTimestampMs(input.timestampMs ?? Date.now())
  const counter = normalizeCounter(input.counter ?? OPEN_CODE_PROMPT_COUNTER_SLOT)
  return `msg_${encodeOpenCodeAscendingTime(timestampMs, counter)}${normalizeRandomSuffix(input.randomSuffix)}`
}

export function reserveOpenCodeRuntimePromptMessageId(input: {
  nowMs?: number
  lowerBoundMessageIds?: Iterable<string | null | undefined>
  randomSuffix?: string
} = {}): {
  runtimePromptMessageId: string
  timestampMs: number
  waitMs: number
  lowerBoundMessageId: string | null
} {
  const nowMs = normalizeTimestampMs(input.nowMs ?? Date.now())
  const localNextTimestampMs = lastReservedPromptTimestampMs + 1
  const timestampMs =
    localNextTimestampMs - nowMs > OPEN_CODE_PROMPT_MAX_LOCAL_CLOCK_WAIT_MS
      ? nowMs
      : Math.max(nowMs, localNextTimestampMs)
  lastReservedPromptTimestampMs = timestampMs

  return {
    runtimePromptMessageId: buildOpenCodeRuntimePromptMessageId({
      timestampMs,
      randomSuffix: input.randomSuffix,
    }),
    timestampMs,
    waitMs: Math.max(0, timestampMs - nowMs),
    lowerBoundMessageId: getGreatestOpenCodePromptOrderingMessageId(input.lowerBoundMessageIds ?? []),
  }
}

export function resetOpenCodeRuntimePromptMessageIdAllocatorForTest(): void {
  lastReservedPromptTimestampMs = 0
}
