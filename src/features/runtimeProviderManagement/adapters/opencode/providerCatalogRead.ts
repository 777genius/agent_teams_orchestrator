type CatalogRead<T> = { ok: true; value: T } | { ok: false; message: string }

/** Only retry read-only discovery. OAuth authorize/callback must never be replayed. */
export async function readProviderCatalogWithRetry<T>(
  read: (attempt: number) => Promise<T>,
): Promise<CatalogRead<T>> {
  const failures: string[] = []
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return { ok: true, value: await read(attempt) }
    } catch (error) {
      failures.push((error instanceof Error ? error.message : String(error)).slice(0, 512))
    }
  }
  return { ok: false, message: `Both catalog read attempts failed: ${failures.join('\n')}` }
}

export function providerCatalogReadFailures(reads: Record<string, CatalogRead<unknown>>): string | null {
  const failures = Object.entries(reads).flatMap(([endpoint, result]) =>
    'message' in result ? [`${endpoint}: ${result.message}`] : [],
  )
  return failures.length > 0
    ? `OpenCode provider catalog could not be loaded.\n${failures.join('\n')}`
    : null
}
