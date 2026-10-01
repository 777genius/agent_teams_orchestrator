/** Anthropic request identity, independent of updater and feature-gate versioning. */
export function getClientVersion(): string {
  // Older SDK/source consumers may supply only the original VERSION macro.
  return MACRO.CLIENT_VERSION ?? MACRO.VERSION
}
