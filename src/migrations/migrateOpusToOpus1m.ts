/**
 * Legacy migration retained as a no-op. The `opus` and `opus[1m]` aliases are
 * distinct user policy and must not be rewritten during startup.
 */
export function migrateOpusToOpus1m(): void {}
