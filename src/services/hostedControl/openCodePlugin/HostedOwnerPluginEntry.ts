import { createHostedOwnerToolPlugin } from './HostedOwnerToolPlugin.js'

// The only export in the packaged OpenCode plugin. Keep the image artifact
// self-contained so OpenCode never resolves dependencies from writable paths.
export default createHostedOwnerToolPlugin()
