/** Owned child of codex-native-continuity-e2e.ts; no runner/model mocks. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Message } from '../../src/types/message.js'
import type { CodexNativeConversationScope } from '../../src/services/codexNative/conversationScope.js'

type Spec = {
  project: string
  sessionId: string
  teamName: string
  memberName: string
  resume: boolean
  manual: boolean
  turns: { scope: CodexNativeConversationScope; text: string; expected: string }[]
}

try {
  const spec = JSON.parse(await readFile(process.argv[2]!, 'utf8')) as Spec
  if (!spec.project || !spec.sessionId || !Array.isArray(spec.turns)) throw new Error('Invalid fixture specification')
  // The parent supplies disposable CODEX_HOME/CLAUDE_CONFIG_DIR before any
  // production import. Establish host identity before settings caches load.
  process.chdir(spec.project)
  const state = await import('../../src/bootstrap/state.js')
  const { asSessionId } = await import('../../src/types/ids.js')
  state.setOriginalCwd(spec.project)
  state.setCwdState(spec.project)
  state.switchSession(asSessionId(spec.sessionId), null)
  state.setIsInteractive(false)
  state.setSessionPersistenceDisabled(false)
  state.setAllowedSettingSources([])
  state.setFlagSettingsInline({ codex: { forced_login_method: 'api' } })
  state.setStrictMcpConfig(true)
  state.setFlagMcpConfig(['{"mcpServers":{}}'])
  const { setDynamicTeamContext } = await import('../../src/utils/teammate.js')
  setDynamicTeamContext({ agentId: `${spec.memberName}@${spec.teamName}`, agentName: spec.memberName,
    teamName: spec.teamName, planModeRequired: false })

  const [appStateModule, inbox, bridge, messages, storage, bootstrap, group] = await Promise.all([
    import('../../src/state/AppStateStore.js'),
    import('../../src/hooks/useInboxPoller.js'),
    import('../../src/services/codexNative/replTurnBridge.js'),
    import('../../src/utils/messages.js'),
    import('../../src/utils/sessionStorage.js'),
    import('../../src/services/teamBootstrap/nativeAppManagedBootstrapContext.js'),
    import('../../src/utils/groupMailbox.js'),
  ])
  let live: Message[] = []
  if (spec.resume) {
    const { loadConversationForResume } = await import('../../src/utils/conversationRecovery.js')
    const result = await loadConversationForResume(spec.sessionId, undefined)
    if (!result?.messages.length || result.sessionId !== spec.sessionId) throw new Error('Teammate host resume failed')
    state.switchSession(asSessionId(spec.sessionId), result.fullPath ? path.dirname(result.fullPath) : null)
    await storage.resetSessionFilePointer()
    storage.adoptResumedSessionFile()
    live = result.messages
  }
  const initialAppState = appStateModule.getDefaultAppState()
  const permissionMode = spec.manual ? 'default' : 'bypassPermissions'
  initialAppState.toolPermissionContext.mode = permissionMode

  for (const turn of spec.turns) {
    let prompt: string
    if (turn.scope === 'bootstrap') {
      prompt = bootstrap.buildNativeAppManagedBootstrapPrivatePrompt()
    } else {
      const runKey = group.getCurrentGroupRunIdentity().groupRunKey
      const row = {
        from: 'user', to: spec.memberName, source: 'user', teamName: spec.teamName,
        memberName: spec.memberName, messageId: randomUUID(), timestamp: new Date().toISOString(),
        text: turn.text, read: false,
        ...(turn.scope === 'group' ? {
          groupChatId: randomUUID(), groupMessageId: randomUUID(), groupChatName: 'TEST continuity group',
          groupChatProtocolVersion: 1 as const, groupRunKey: runKey,
          groupRecipientNames: [spec.memberName], groupRecipientRunKeys: { [spec.memberName]: runKey },
        } : {}),
      }
      group.assertValidGroupMailboxRows([row])
      if (turn.scope === 'group' && !group.isCurrentGroupMailboxMessage(row)) throw new Error('Invalid current group envelope')
      prompt = inbox.getOrdinaryInlineHandoffPrompt({ ...row, replyProtocol: 'agent_teams_message_send',
        ...(turn.scope === 'group' ? { groupCatalog: [], groupHistory: [row] } : {}) })
    }
    const submitted = messages.createUserMessage({ content: prompt, isMeta: true })
    live.push(submitted)
    await bridge.runCodexNativeTurnInRepl({
      prompt, conversationScope: turn.scope, cwd: spec.project, model: 'gpt-5.4', effortValue: undefined,
      permissionMode, additionalWritableDirectories: [], initialAppState, transcriptMessages: live,
      requestApproval: async () => { throw new Error('Unexpected native approval in text-only fixture') },
      onReplEvent: event => messages.handleMessageFromStream(event, message => live.push(message), () => {}, () => {}, () => {}, () => {}),
    })
    const reply = inbox.findOrdinaryDirectReplyFallback({ messages: live,
      submitUserMessageUuid: submitted.uuid, excludeNativeCommentary: true })
    if (reply?.text !== turn.expected) throw new Error(`Unexpected teammate native reply: ${JSON.stringify(reply)}`)
    await storage.flushSessionStorage()
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
      result: reply.text, session_id: spec.sessionId }))
  }
  await storage.flushSessionStorage()
  process.exit(0)
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exit(1)
}
