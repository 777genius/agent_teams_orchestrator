import path from 'node:path'
import { qualifyDarwin } from '../../src/services/opencode/host/darwin/OpenCodeV2DarwinQualification.js'
export { qualifyDarwin }
if (import.meta.main) {
  if (process.argv.length !== 3 && process.argv.length !== 4) throw new Error('Usage: bun scripts/opencode-v2/qualify-darwin.ts NATIVE_ROOT [OUTPUT]')
  console.log(JSON.stringify(await qualifyDarwin(path.resolve(process.argv[2]!), process.argv[3] && path.resolve(process.argv[3])), null, 2))
}
