import { object, REMAINING } from './contracts';
import { LogCut } from './collect';

// This is an observation join, never a production terminal/delivery proof algorithm.
export function facts(input: {
  generation: string; sessionID: string; callerID: string; marker: string;
  receipt?: any; cut?: LogCut; rows: any[]; complete: boolean;
}) {
  const { generation, sessionID, callerID, marker, receipt, cut, rows, complete } = input;
  const missing: string[] = [], failures: string[] = [];
  const user = rows.filter(m => generation === 'v1'
    ? m.info?.role === 'user' && m.info.id === callerID && m.parts?.some((p: any) => p.type === 'text' && p.text === marker)
    : m.type === 'user' && m.text === marker);
  if (user.length > 1) failures.push('multiple projected users for single selected caller/body');
  if (user.length !== 1) missing.push('unique projected user');
  const projectedUserID = user.length === 1 ? (generation === 'v1' ? user[0].info.id : user[0].id) : null;
  const events = cut?.events ?? [];
  const receiptID = receipt?.type === 'user' && receipt.sessionID === sessionID && receipt.payload?.text === marker ? receipt.id : null;
  if (receipt && !receiptID) failures.push('malformed/foreign/payload-mismatched receipt');
  const enqueued = events.filter(e => e.type === 'session.inbox.enqueued' && e.data.item?.type === 'user' && e.data.item.payload?.text === marker);
  const inboxID = enqueued.length === 1 ? enqueued[0].data.inboxID : null;
  if (generation === 'v2') {
    if (!cut?.synced) missing.push('complete durable cut');
    if (enqueued.length !== 1) missing.push('unique enqueued payload');
    if (receiptID && inboxID && receiptID !== inboxID) missing.push('receipt/inbox relationship unresolved');
    if (events.some(e => e.type === 'session.inbox.enqueued' && e.data.item?.payload?.text !== marker)) missing.push('foreign/control/batch input');
  }
  const delivered = events.filter(e => e.type === 'session.inbox.delivered' && e.data.inboxID === inboxID);
  const starts = events.filter(e => e.type === 'session.execution.started');
  const terminals = events.filter(e => ['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted'].includes(e.type));
  if (generation === 'v2' && (starts.length !== 1 || terminals.length !== 1 || delivered.length !== 1)) missing.push('unique execution/delivery window');
  const assistants = rows.filter(m => generation === 'v1'
    ? m.info?.role === 'assistant' && m.info.parentID === projectedUserID : m.type === 'assistant');
  const final = assistants.filter(m => {
    const info = generation === 'v1' ? m.info : m;
    const parts = generation === 'v1' ? m.parts : m.content;
    return info.time?.completed && info.finish === 'stop' && !info.error &&
      Array.isArray(parts) && !parts.some((p: any) => p.type === 'tool' && p.state?.status !== 'completed');
  });
  // V2 has no canonical parentID. Raw completion cannot prove the execution join.
  const attributed = generation === 'v1' && projectedUserID ? final : [];
  if (generation === 'v2') missing.push('caller/receipt/inbox/projection/execution association');
  if (!complete) missing.push('complete transcript');
  if (!attributed.length) missing.push('canonical terminal assistant');
  const position = (e: any) => e ? { eventID: e.id, seq: e.durable.seq, streamIndex: events.indexOf(e) } : null;
  return {
    status: failures.length ? 'FAIL' : 'MISSING', scope: 'S1a raw measurement; no native qualification',
    callerID, receiptID, inboxID, projectedUserID,
    receiptCallerEqualityObserved: receiptID ? receiptID === callerID : null,
    inboxProjectedEqualityObserved: inboxID && projectedUserID ? inboxID === projectedUserID : null,
    executionStart: starts.map(position), executionTerminal: terminals.map(position), delivery: delivered.map(position),
    executionStartBeforeDeliveryObserved: starts.length === 1 && delivered.length === 1 ? events.indexOf(starts[0]) < events.indexOf(delivered[0]) : null,
    synced: cut?.synced ?? null, assistantParentIDs: generation === 'v1' ? assistants.map(m => m.info.parentID) : null,
    terminalCandidateIDs: final.map(m => generation === 'v1' ? m.info.id : m.id),
    terminalAssistantIDs: attributed.map(m => generation === 'v1' ? m.info.id : m.id),
    missing, failures, fullS1: 'MISSING', remaining: REMAINING,
  };
}
