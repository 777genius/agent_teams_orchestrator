/**
 * Compile-time shapes of the two V2 wire families (see `openCodeV2Wire`). The
 * floor is the supported range minimum and therefore fixed; the current shape
 * comes from the root type-only packages. Runtime bytes are never imported from
 * here: each run loads the selected version's own client/server graph alias.
 */
export type * as FloorClient from '@opencode/client-v2.0.0'
export type * as CurrentClient from '@opencode/client'
export type { ConfigEntry as FloorConfigEntry } from '@opencode/client-v2.0.0'
export type { ConfigEntry as CurrentConfigEntry } from '@opencode/client'
export type { ServerOptions as FloorServerOptions } from '@opencode/server-v2.0.0/options'
export type { ServerOptions as CurrentServerOptions } from '@opencode/server/options'
