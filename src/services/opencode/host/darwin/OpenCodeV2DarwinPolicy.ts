/** These kernel rules also form the qualification receipt's policy identity. */
export const DARWIN_SCOPE_POLICY = [
  '(allow process-fork (require-not (%entitlement-is-present "com.apple.private.coalition-spawn")))',
  '(deny mach-lookup)',
  '(deny appleevent-send)',
].join('\n') + '\n'
