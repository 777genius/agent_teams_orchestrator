import { describe, expect, test } from 'bun:test'

import { buildWindowsDeepLinkOpenCommand } from './desktopDeepLink.js'

describe('desktop deep links', () => {
  test('opens Windows URLs without cmd shell parsing', () => {
    const deepLinkUrl =
      'claude://resume?session=session-1&cwd=C%3A%5CRepo%5CProject%26branch%3Dmain'

    expect(buildWindowsDeepLinkOpenCommand(deepLinkUrl)).toEqual({
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', deepLinkUrl],
    })
  })
})
