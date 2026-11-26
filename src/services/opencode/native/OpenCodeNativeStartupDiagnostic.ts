const phases = [
  'registry-read', 'profile-scope', 'binary-resolve', 'startup-lock', 'startup-unlock', 'retained-host',
  'port-allocate', 'temp-cleanup', 'native-binary', 'custody-helper', 'authority-parent', 'authority-gate',
  'authority-read', 'image-copy', 'authority-preparing', 'native-measure', 'measure-helper', 'helper-hello',
  'measure-terminal', 'measure-stdout', 'measure-image', 'launch-helper', 'launch-reply', 'authority-publish',
  'authority-refusal', 'health', 'birth', 'host-publish', 'failed-launch-stop', 'failed-launch-temp',
] as const

export type NativeStartupPhase = typeof phases[number]
export type NativeStartupObservation = Readonly<{ phase: NativeStartupPhase; event: 'begin' | 'settled' }>
/** Optional per-call TEST observation. It conveys no process, request or disposal authority. */
export type NativeStartupObserver = (observation: NativeStartupObservation) => void

/** No observer: preserve the original Promise. An observer cannot replace an operation's outcome. */
export function observeNativeStartup<T>(observer: NativeStartupObserver | undefined, phase: NativeStartupPhase,
  work: () => Promise<T>): Promise<T> {
  if (!observer) return work()
  const emit = (event: NativeStartupObservation['event']) => {
    if (!phases.includes(phase)) return
    try { observer(Object.freeze({ phase, event })) }
    catch { /* Diagnostic callbacks are synchronous and never change the original outcome. */ }
  }
  emit('begin')
  try {
    return work().then(value => { emit('settled'); return value }, error => { emit('settled'); throw error })
  } catch (error) { emit('settled'); throw error }
}
