export function unsupportedInternalFeature(featureName: string): never {
  throw new Error(
    `${featureName} is not available in this reconstructed external source snapshot.`,
  )
}
