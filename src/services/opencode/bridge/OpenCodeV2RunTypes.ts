import type { OpenCodePreparedProfile, OpenCodeExecutionProof } from '../types.js'
import type { ControllerToolProof } from './OpenCodeV2ControllerTools.js'
import type { QueueIntent } from '../execution/OpenCodeV2AdmissionService.js'
import type { AdmissionRecord, SessionAuthority } from '../execution/OpenCodeV2ExecutionContracts.js'
import type { ExecutionLease, SelectedExecutionProfile, ValidatedExecutionNative } from '../host/OpenCodeV2ExecutionHost.js'
import type { ExecutionCleanupReceipt } from '../host/OpenCodeV2ExecutionLifecycle.js'
import type { ExecutionBridgeClient, ExecutionLog, ExecutionMessagePage, ExecutionPermission, ExecutionMcpServer } from '../transport/OpenCodeV2ExecutionClientFactory.js'
import type { OpenCodeV2TurnProjection } from './OpenCodeV2TurnProjection.js'

export type RunBinding = Readonly<{ teamId: string; runId: string; controllerInstanceId: string; ownerId: string }>
export type RunProcessIdentity = Readonly<{ pid: number; startTicks: string; bootId: string; executablePath: string; executableSha256: string }>
export type RunControlRecord = Readonly<{
  schema: 1; protocol: 1; binding: RunBinding; process: RunProcessIdentity
  directory: string; socketPath: string; socketDevice: number; socketInode: number
  deadline: number; uid: number; sourceSha256: string
}>
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
export type RunQualification = Readonly<{ capabilitySnapshotId: string | null; expectedBehaviorFingerprint: string; binaryPath: string; binaryFingerprint: string; version: string | null }>
export type RunLaunchPlan = Readonly<{
  qualification?: RunQualification
  dataRoot: string; binding: RunBinding; deadline: number; members: readonly RunMemberPlan[]
  executionProbe?: Readonly<{ memberId: string; intent: QueueIntent; expectedText: string; prepared: OpenCodePreparedProfile; capabilitySnapshotId: string }>
  source: Readonly<{ entryPath: string; entrySha256: string; bunPath: string; bunSha256: string
    files: readonly Readonly<{ path: string; sha256: string }>[]; env: Readonly<Record<string, string>> }>
}>
type MemberRequest = Readonly<{ memberId: string; originalSessionId: string }>
export type RunControlRequest =
  | (MemberRequest & Readonly<{ operation: 'send'; intent: QueueIntent; submissionOwner?: string }>)
  | (MemberRequest & Readonly<{ operation: 'observe'; nativeInputID: string; intent?: QueueIntent; submissionOwner?: string }>)
  | (MemberRequest & Readonly<{ operation: 'transcript' }>)
  | (MemberRequest & Readonly<{ operation: 'permissions' }>)
  | (MemberRequest & Readonly<{ operation: 'mcp' }>)
  | (MemberRequest & Readonly<{ operation: 'probeEvidence' }>)
  | (MemberRequest & Readonly<{ operation: 'permissionReply'; requestId: string; decision: 'allow' | 'deny' }>)
  | Readonly<{ operation: 'stop' }>
  | Readonly<{ operation: 'status' }>
export type RunOwnerState = 'starting' | 'active' | 'stopping' | 'stopped' | 'cleanup_unknown'
export type RunMemberStatus = Readonly<{
  memberId: string; laneId: string; originalSessionId: string
  selectedModel: string; selectedVariant?: string
  opencodeSessionId: string; runtimeSessionId: string
  profileEpoch: string; profileRoot: string; pin: '2.0.0' | '2.0.21'; runtimePid?: number
  state: 'accepted' | 'unknown' | 'rejected'; bootstrap: InstructionReceipt | null
  controllerTools?: ControllerToolProof
}>
export type RunStopMember = Readonly<{ memberId: string; cleanup: ExecutionCleanupReceipt | null; errors: readonly string[] }>
export type RunProbeFailure = 'native_execution_failed' | 'native_execution_cancelled'
export type RunControlResult =
  | Readonly<{ kind: 'send_refused'; disposition: 'not_reserved'; authority: SessionAuthority; intent: QueueIntent; submissionOwner?: string }>
  | Readonly<{ kind: 'send' | 'observe'; admission: AdmissionRecord; turn: OpenCodeV2TurnProjection | null }>
  | Readonly<{ kind: 'transcript'; messages: ExecutionMessagePage; log: ExecutionLog }>
  | Readonly<{ kind: 'permissions'; requests: ExecutionPermission[] }>
  | Readonly<{ kind: 'permissionReply'; status: 'applied' | 'unknown' }>
  | Readonly<{ kind: 'mcp'; servers: ExecutionMcpServer[] }>
  | Readonly<{ kind: 'probeEvidence'; proof: OpenCodeExecutionProof | null; failure: RunProbeFailure | null }>
  | Readonly<{ kind: 'status'; qualification?: RunQualification; state: RunOwnerState; members: readonly RunMemberStatus[]; deadline: number }>
  | Readonly<{ kind: 'stop'; state: 'stopped' | 'cleanup_unknown'; members: readonly RunStopMember[]; ownerRetired?: boolean }>

/** These ports preserve real process-owned objects. They are never control DTOs. */
export type RunExecutionPorts = Readonly<{
  acquire: (native: ValidatedExecutionNative, profile: SelectedExecutionProfile,
    context: import('../execution/OpenCodeV2ExecutionContracts.js').ExecutionContext) => Promise<ExecutionLease>
  client: (authority: ExecutionLease['authority'],
    context: import('../execution/OpenCodeV2ExecutionContracts.js').ExecutionContext) => Promise<ExecutionBridgeClient>
}>
