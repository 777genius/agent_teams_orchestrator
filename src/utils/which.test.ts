import { describe, expect, test } from 'bun:test'

import { which, whichSync } from './which.js'

describe('which', () => {
  test('treats shell metacharacters as part of the command name', async () => {
    const command = 'definitely-not-a-real-command & echo hacked'

    expect(await which(command)).toBeNull()
    expect(whichSync(command)).toBeNull()
  })
})
