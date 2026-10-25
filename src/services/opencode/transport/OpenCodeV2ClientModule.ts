import { pathToFileURL } from 'node:url'
import type { CurrentClient, FloorClient } from '../compatibility/OpenCodeV2WireTypes.js'
import { openCodeV2Wire, type OpenCodeV2Pin } from '../compatibility/OpenCodeV2Registry.js'
import { resolveOpenCodeV2GraphEntry, verifyOpenCodePackage } from '../host/OpenCodeV2ServerGraph.js'

/** Types describe the two wire families; the loaded bytes are always the selected version's client. */
export type OpenCodeV2ClientModule =
  | Readonly<{ wire: 'floor'; module: typeof FloorClient }>
  | Readonly<{ wire: 'current'; module: typeof CurrentClient }>

/** The selected version's official Promise client entry, before any import. */
export async function resolveOpenCodeV2ClientEntry(pin: OpenCodeV2Pin, from?: string): Promise<string> {
  const entry = await resolveOpenCodeV2GraphEntry(pin, 'client', undefined, from)
  await verifyOpenCodePackage(entry, '@opencode/client', pin)
  return entry
}

/** Import exactly the resolved entry, after the caller bound it to its graph proof. */
export async function importOpenCodeV2ClientModule(pin: OpenCodeV2Pin, entry: string): Promise<OpenCodeV2ClientModule> {
  await verifyOpenCodePackage(entry, '@opencode/client', pin)
  const module: unknown = await import(pathToFileURL(entry).href)
  return openCodeV2Wire(pin) === 'floor'
    ? { wire: 'floor', module: module as typeof FloorClient }
    : { wire: 'current', module: module as typeof CurrentClient }
}
