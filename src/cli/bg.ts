import { unsupportedInternalFeature } from '../utils/unsupportedInternalFeature.js'

export async function psHandler(_args: string[]): Promise<void> {
  unsupportedInternalFeature('Background session support')
}

export async function logsHandler(_sessionId?: string): Promise<void> {
  unsupportedInternalFeature('Background session support')
}

export async function attachHandler(_sessionId?: string): Promise<void> {
  unsupportedInternalFeature('Background session support')
}

export async function killHandler(_sessionId?: string): Promise<void> {
  unsupportedInternalFeature('Background session support')
}

export async function handleBgFlag(_args: string[]): Promise<void> {
  unsupportedInternalFeature('Background session support')
}
