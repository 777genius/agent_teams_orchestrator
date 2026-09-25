let busy = false

/** Serializes root-owned container operations within this single-member daemon process. */
export async function withRootDockerContainerOperationLock<T>(memberOperationId: string,
  action: () => Promise<T>): Promise<T> {
  if (!memberOperationId || busy) throw new Error('root-container-operation-busy')
  busy = true
  try { return await action() } finally { busy = false }
}
