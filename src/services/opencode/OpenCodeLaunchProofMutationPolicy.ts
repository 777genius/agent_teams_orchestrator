/**
 * The only allowed handoff from proof observation to an irreversible member
 * mutation. The mutation promise is created synchronously after revalidation
 * succeeds, leaving no awaited transport gap in which retained proof can drift.
 */
export async function runOpenCodeMutationWithFreshProof<T>(
  revalidate: () => Promise<void>,
  mutate: () => Promise<T>,
): Promise<T> {
  await revalidate()
  return mutate()
}
