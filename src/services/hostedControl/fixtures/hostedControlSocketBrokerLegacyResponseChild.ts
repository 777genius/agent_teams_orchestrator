// Parser-only fixture. No listener and no native transport qualification.
import { readFileSync } from 'node:fs'
readFileSync(3)
process.stdin.resume()
process.stdout.write(process.argv[2]!)
