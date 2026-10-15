/**
 * Legacy migration retained as a no-op. Explicit concrete model selections are
 * durable policy and must never be rewritten during startup.
 */
export function migrateLegacyOpusToCurrent(): void {}
