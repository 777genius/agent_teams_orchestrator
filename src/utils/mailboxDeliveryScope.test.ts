import { describe, expect, it } from 'bun:test'

import {
  shouldFinalizeFileBackedProtocolMessages,
  shouldFinalizeFileBackedRegularMessages,
  shouldReadProtocolMailboxMessagesFromFile,
  shouldReadRegularMailboxMessagesFromFile,
  shouldUseLiveInboxOwnerPath,
} from './mailboxDeliveryScope.js'

describe('mailboxDeliveryScope', () => {
  it('uses AppState live owner path only for interactive leader runtime', () => {
    expect(
      shouldUseLiveInboxOwnerPath({
        viewedTeammate: false,
        inProcessTeammate: false,
        nonInteractiveSession: false,
      }),
    ).toBe(true)

    expect(
      shouldUseLiveInboxOwnerPath({
        viewedTeammate: true,
        inProcessTeammate: false,
        nonInteractiveSession: false,
      }),
    ).toBe(false)
    expect(
      shouldUseLiveInboxOwnerPath({
        viewedTeammate: false,
        inProcessTeammate: true,
        nonInteractiveSession: false,
      }),
    ).toBe(false)
    expect(
      shouldUseLiveInboxOwnerPath({
        viewedTeammate: false,
        inProcessTeammate: false,
        nonInteractiveSession: true,
      }),
    ).toBe(false)
  })

  it('reads regular mailbox rows from file only for observer, in-process, or non-interactive scopes', () => {
    expect(
      shouldReadRegularMailboxMessagesFromFile({
        viewedTeammate: false,
        inProcessTeammate: false,
        nonInteractiveSession: false,
      }),
    ).toBe(false)
    expect(
      shouldReadRegularMailboxMessagesFromFile({
        viewedTeammate: true,
        inProcessTeammate: false,
        nonInteractiveSession: false,
      }),
    ).toBe(true)
    expect(
      shouldReadRegularMailboxMessagesFromFile({
        viewedTeammate: false,
        inProcessTeammate: true,
        nonInteractiveSession: false,
      }),
    ).toBe(true)
    expect(
      shouldReadRegularMailboxMessagesFromFile({
        viewedTeammate: false,
        inProcessTeammate: false,
        nonInteractiveSession: true,
      }),
    ).toBe(true)
  })

  it('keeps structured protocol rows available from file outside the live interactive owner path', () => {
    expect(
      shouldReadProtocolMailboxMessagesFromFile({
        viewedTeammate: false,
        inProcessTeammate: false,
        nonInteractiveSession: false,
      }),
    ).toBe(false)
    expect(
      shouldReadProtocolMailboxMessagesFromFile({
        viewedTeammate: true,
        inProcessTeammate: false,
        nonInteractiveSession: false,
      }),
    ).toBe(true)
    expect(
      shouldReadProtocolMailboxMessagesFromFile({
        viewedTeammate: false,
        inProcessTeammate: true,
        nonInteractiveSession: false,
      }),
    ).toBe(true)
    expect(
      shouldReadProtocolMailboxMessagesFromFile({
        viewedTeammate: false,
        inProcessTeammate: false,
        nonInteractiveSession: true,
      }),
    ).toBe(true)
  })

  it('keeps viewer and non-interactive scopes read-only for file-backed regular messages', () => {
    expect(
      shouldFinalizeFileBackedRegularMessages({
        viewedTeammate: true,
        inProcessTeammate: false,
        nonInteractiveSession: false,
      }),
    ).toBe(false)
    expect(
      shouldFinalizeFileBackedRegularMessages({
        viewedTeammate: false,
        inProcessTeammate: false,
        nonInteractiveSession: true,
      }),
    ).toBe(false)
    expect(
      shouldFinalizeFileBackedRegularMessages({
        viewedTeammate: false,
        inProcessTeammate: true,
        nonInteractiveSession: false,
      }),
    ).toBe(true)
  })

  it('only lets the in-process live owner finalize file-backed structured protocol rows', () => {
    expect(
      shouldFinalizeFileBackedProtocolMessages({
        viewedTeammate: true,
        inProcessTeammate: false,
        nonInteractiveSession: false,
      }),
    ).toBe(false)
    expect(
      shouldFinalizeFileBackedProtocolMessages({
        viewedTeammate: false,
        inProcessTeammate: false,
        nonInteractiveSession: true,
      }),
    ).toBe(false)
    expect(
      shouldFinalizeFileBackedProtocolMessages({
        viewedTeammate: false,
        inProcessTeammate: true,
        nonInteractiveSession: false,
      }),
    ).toBe(true)
  })
})
