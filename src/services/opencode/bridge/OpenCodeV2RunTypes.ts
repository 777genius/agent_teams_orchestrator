import type { OpenCodeGroupChatRunProof } from '../OpenCodeGroupChatCapability.js'
import type { OpenCodePreparedProfile, OpenCodeExecutionProof } from '../types.js'
import type { ControllerToolProof } from './OpenCodeV2ControllerTools.js'
import type { QueueIntent } from '../execution/OpenCodeV2AdmissionService.js'
import type { AdmissionRecord, SessionAuthority } from '../execution/OpenCodeV2ExecutionContracts.js'
import type { OpenCodeV2ProviderFailureCategory, RunInitializationPhase } from '../execution/OpenCodeV2Diagnostics.js'
import type { OpenCodeV2ProviderWireFailure } from '../transport/OpenCodeV2ProviderWire.js'
import type { OpenCodeV2Pin } from '../compatibility/OpenCodeV2Registry.js'
import type { OpenCodeV2DeliveryBinding } from '../host/OpenCodeV2DeliveryManifest.js'
import type { ExecutionLease, SelectedExecutionProfile, ValidatedExecutionNative } from '../host/OpenCodeV2ExecutionHost.js'
import type { ExecutionCleanupReceipt } from '../host/OpenCodeV2ExecutionLifecycle.js'
import type { ExecutionBridgeClient, ExecutionLog, ExecutionMessagePage, ExecutionPermission, ExecutionMcpServer } from '../transport/OpenCodeV2ExecutionClientFactory.js'
import type { OpenCodeV2TurnProjection } from './OpenCodeV2TurnProjection.js'

export type RunBinding = Readonly<{ teamId: string; runId: string; controllerInstanceId: string; ownerId: string }>
export type RunProcessIdentity = Readonly<{ pid: number; startTicks: string; bootId: string; executablePath: string; executableSha256: string }>
type RunControlRecordBase = Readonly<{ schema: 1; protocol: 1; binding: RunBinding; directory: string; deadline: number; sourceSha256: string }>
/** POSIX publishes a private pathname socket; Windows publishes `tcp://127.0.0.1:<port>` with zero device and inode. */
export type RunUnixControlRecord = RunControlRecordBase & Readonly<{
  process: RunProcessIdentity
  socketPath: string; socketDevice: number; socketInode: number; uid: number
}>
export type RunControlRecord = RunUnixControlRecord
export type RunAnyProcessIdentity = RunProcessIdentity
export type InstructionReceipt = Readonly<{
  strategy: 'instruction-entry'; key: string; contextHash: string; briefingHash: string
  verified: boolean; missingNativeMessageID: true
}>
export type RunMemberPlan = Readonly<{
  memberId: string; laneId: string; originalSessionId: string; title?: string
  native: ValidatedExecutionNative; profile: SelectedExecutionProfile
  bootstrap: Readonly<{ key: string; value: string; contextHash: string; briefingHash: string }>
  controllerMcpName: string; advertisedTools: readonly string[]
}>
export type RunQualification = Readonly<{ capabilitySnapshotId: string | null; expectedBehaviorFingerprint: string; binaryPath: string; binaryFingerprint: string; version: string | null; engineVersion?: OpenCodeV2Pin }>
export type RunLaunchPlan = Readonly<{
  qualification?: RunQualification
  dataRoot: string; binding: RunBinding; deadline: number; members: readonly RunMemberPlan[]
  executionProbe?: Readonly<{ memberId: string; intent: QueueIntent; expectedText: string; prepared: OpenCodePreparedProfile; capabilitySnapshotId: string }>
  source: Readonly<{ entryPath: string; entrySha256: string; bunPath: string; bunSha256: string
    files: readonly Readonly<{ path: string; sha256: string }>[]; env: Readonly<Record<string, string>>; delivery?: OpenCodeV2DeliveryBinding }>
}>
type MemberRequest = Readonly<{ memberId: string; originalSessionId: string }>
export type RunControlRequest =
  | (MemberRequest & Readonly<{ operation: 'send'; intent: QueueIntent; submissionOwner?: string }>)
  | (MemberRequest & Readonly<{ operation: 'observe'; nativeInputID: string; intent?: QueueIntent; submissionOwner?: string }>)
  | (MemberRequest & Readonly<{ operation: 'transcript' }>)
  | (MemberRequest & Readonly<{ operation: 'permissions' }>)
  | (MemberRequest & Readonly<{ operation: 'mcp' }>)
  | (MemberRequest & Readonly<{ operation: 'groupProof' }>)
  | (MemberRequest & Readonly<{ operation: 'probeEvidence' }>)
  | (MemberRequest & Readonly<{ operation: 'permissionReply'; requestId: string; decision: 'allow' | 'deny' }>)
  | Readonly<{ operation: 'stop' }>
  | Readonly<{ operation: 'status' }>
export type RunOwnerState = 'starting' | 'active' | 'stopping' | 'stopped' | 'cleanup_unknown'
export type RunMemberStatus = Readonly<{
  memberId: string; laneId: string; originalSessionId: string
  selectedModel: string; selectedVariant?: string
  opencodeSessionId: string; runtimeSessionId: string
  profileEpoch: string; profileRoot: string; pin: OpenCodeV2Pin; runtimePid?: number
  state: 'accepted' | 'unknown' | 'rejected'; bootstrap: InstructionReceipt | null
  /** Observational age of the current initialization phase, never readiness evidence. */
  initialization?: Readonly<{ phase: RunInitializationPhase; elapsedMs: number }>
  controllerTools?: ControllerToolProof
}>
export type RunStopMember = Readonly<{ memberId: string; cleanup: ExecutionCleanupReceipt | null; errors: readonly string[] }>
export type RunProbeFailure = 'native_execution_failed' | 'native_execution_cancelled'
/** Closed facts of an owner's own initialization failure: a fixed category and the
 * provider wire stage. Never a message, body, path or credential. */
export type RunOwnerFailure = Readonly<{ category: OpenCodeV2ProviderFailureCategory; operation?: OpenCodeV2ProviderWireFailure }>
/** The original owner process is proven gone; `failure` is its own record, if any. */
export type RunOwnerRetirement = Readonly<{ failure: RunOwnerFailure | null }>
export type RunControlResult =
  | Readonly<{ kind: 'send_refused'; disposition: 'not_reserved'; authority: SessionAuthority; intent: QueueIntent; submissionOwner?: string }>
  | Readonly<{ kind: 'send' | 'observe'; admission: AdmissionRecord; turn: OpenCodeV2TurnProjection | null }>
  | Readonly<{ kind: 'transcript'; messages: ExecutionMessagePage; log: ExecutionLog }>
  | Readonly<{ kind: 'permissions'; requests: ExecutionPermission[] }>
  | Readonly<{ kind: 'permissionReply'; status: 'applied' | 'unknown' }>
  | Readonly<{ kind: 'mcp'; servers: ExecutionMcpServer[] }>
  | Readonly<{ kind: 'groupProof'; proof: OpenCodeGroupChatRunProof | null }>
  | Readonly<{ kind: 'probeEvidence'; proof: OpenCodeExecutionProof | null; failure: RunProbeFailure | null }>
  | Readonly<{ kind: 'status'; qualification?: RunQualification; state: RunOwnerState; members: readonly RunMemberStatus[]; deadline: number }>
  | Readonly<{ kind: 'stop'; state: 'stopped' | 'cleanup_unknown'; members: readonly RunStopMember[]; ownerRetired?: boolean }>

/** These ports preserve real process-owned objects. They are never control DTOs. */
export type RunExecutionPorts = Readonly<{
  acquire: (native: ValidatedExecutionNative, profile: SelectedExecutionProfile,
    context: import('../execution/OpenCodeV2ExecutionContracts.js').ExecutionContext,
    startupGate?: import('../host/OpenCodeV2ExecutionHost.js').ExecutionStartupGate,
    graphValidation?: import('../host/OpenCodeV2ExecutionBinding.js').ExecutionGraphValidation) => Promise<ExecutionLease>
  client: (authority: ExecutionLease['authority'],
    context: import('../execution/OpenCodeV2ExecutionContracts.js').ExecutionContext) => Promise<ExecutionBridgeClient>
}>
