/** Proposed manager boundary. No credentials, gameplay handles or model tools. */
export interface ReleaseProfile {
  worldProfile: string;
  botProfile: string;
  ownerProfile: string;
  serverVersion: string;
  protocol: number;
}

export interface AcceptedRelease {
  id: string;
  digest: string;
  /** A bounded, reviewed feature summary; never arbitrary player input. */
  summary: string;
  profile: ReleaseProfile;
  checkpointSchema: number;
  /** Validator proves immutable complete bytes and compatible/reversible data. */
  artifactRoot: string;
  entrypoint: string;
}

export interface ManagerIntent {
  sessionId: string;
  generation: number;
  online: boolean;
  paused: boolean;
}

export interface OperationFence {
  sessionId: string;
  deploymentGeneration: number;
  commandGeneration: number;
}

export interface CheckpointRef {
  id: string;
  sessionId: string;
  schema: number;
}

export type FailureCode =
  | 'artifact_invalid' | 'incompatible' | 'checkpoint_failed' | 'intent_failed'
  | 'cleanup_unproven' | 'ownership_unproven' | 'startup_failed' | 'readiness_failed'
  | 'auth_required' | 'whitelist_denied' | 'server_unavailable' | 'identity_conflict'
  | 'protocol_mismatch' | 'superseded' | 'timeout' | 'commit_failed' | 'busy' | 'request_invalid';

export class ManagerFault extends Error {
  readonly code: FailureCode;
  constructor(code: FailureCode, detail: string) {
    super(detail);
    this.name = 'ManagerFault';
    this.code = code;
  }
}

export interface ArtifactPort {
  /** Must rehash complete accepted bytes, check receipt and compatibility. */
  validate(releaseId: string, signal: AbortSignal): Promise<AcceptedRelease>;
  /** Atomic pointer/journal write, fenced against newer persisted intent. */
  commitActive(release: AcceptedRelease, fence: OperationFence, signal: AbortSignal): Promise<void>;
}

export interface ChildRegistration {
  id: string;
  pid: number;
  releaseId: string;
  digest: string;
  fence: OperationFence;
}

export interface DrainEvidence {
  childId: string;
  fence: OperationFence;
  admissionClosed: boolean;
  preparationsSettled: boolean;
  providersSettled: boolean;
  actuatorsReleased: boolean;
  interfacesSettled: boolean;
  socketClosed: boolean;
  /** Local connection-closure event timestamp, not checkpoint completion time. */
  socketClosedAtMs: number;
  /** Durable child checkpoint, confirmed effects distinct from unknown effects. */
  checkpoint: CheckpointRef;
}

export interface GoneEvidence {
  childId: string;
  rootGone: boolean;
  descendantsGone: boolean;
  /** Independent process-tree proof; socket proof also needs drained child IPC. */
  inspectionSucceeded: boolean;
  socketClosed: boolean;
}

export interface ReadinessEvidence {
  childId: string;
  fence: OperationFence;
  releaseId: string;
  digest: string;
  profile: ReleaseProfile;
  checkpointId: string;
  connectionEpoch: number;
  spawnValid: boolean;
  spawnedAtMs: number;
  dimension: string;
  observedAtMs: number;
  inventoryServerConfirmed: boolean;
  observationServerConfirmed: boolean;
  capabilitiesRegistered: boolean;
  authReady: boolean;
  providersReady: boolean;
  paused: boolean;
  /** Joining does not open gameplay admission before verification/commit. */
  admissionClosed: boolean;
}

export interface CheckpointPort {
  /** Serialized durable CAS by generation. Late old writes cannot restore on. */
  persistIntent(intent: ManagerIntent, signal: AbortSignal): Promise<void>;
  /** Validate child freeze and durably retain conservative budget/directive state. */
  capture(child: ChildRegistration, drain: DrainEvidence, signal: AbortSignal): Promise<CheckpointRef>;
}

export interface ChildDriver {
  /** Natural loss revokes readiness; it never schedules automatic reconnect. */
  onLoss(listener: (child: ChildRegistration, reason: FailureCode) => void): () => void;
  /** Synchronous registration BEFORE any asynchronous spawn/readiness wait. */
  launch(release: AcceptedRelease, checkpoint: CheckpointRef, intent: ManagerIntent, fence: OperationFence): ChildRegistration;
  drain(child: ChildRegistration, fence: OperationFence, signal: AbortSignal): Promise<DrainEvidence>;
  terminate(child: ChildRegistration, signal: AbortSignal): Promise<GoneEvidence>;
  proveGone(child: ChildRegistration, signal: AbortSignal): Promise<GoneEvidence>;
  readiness(child: ChildRegistration, fence: OperationFence, signal: AbortSignal): Promise<ReadinessEvidence>;
  /** Atomically recheck current connection/readiness before opening admission. */
  activate(child: ChildRegistration, intent: ManagerIntent, fence: OperationFence, signal: AbortSignal): Promise<void>;
  pause(child: ChildRegistration, intent: ManagerIntent, signal: AbortSignal): Promise<void>;
  /** One attempt on the existing owner reply mode, no public fallback/retry. */
  announce(child: ChildRegistration, fence: OperationFence, text: string, signal: AbortSignal): Promise<'sent' | 'unavailable'>;
}

export interface ManagerLease {
  /** Throws unless this manager still owns the exclusive local profile lease. */
  assertHeld(): void;
}

/** Owner authentication belongs to the trusted bridge/local controller. */
export interface ManagerControlRequest {
  action: 'on' | 'off' | 'stop' | 'resume';
  profile: ReleaseProfile;
  sessionId: string;
  /** Ephemeral manager boot identity; old bridge queues never replay after restart. */
  controlSessionId: string;
  generation: number;
  issuedAtMs: number;
  expiresAtMs: number;
}

export interface ManagerOptions {
  artifacts: ArtifactPort;
  checkpoints: CheckpointPort;
  children: ChildDriver;
  lease: ManagerLease;
  profile: ReleaseProfile;
  activeReleaseId: string;
  checkpoint: CheckpointRef;
  /** Restored latest generation/pause. Boot NEVER restores online intent. */
  intent: ManagerIntent;
  deadlines?: Partial<ManagerDeadlines>;
  now?: () => number;
}

export interface ManagerDeadlines {
  validationMs: number;
  intentMs: number;
  drainMs: number;
  checkpointMs: number;
  cleanupMs: number;
  readinessMs: number;
  commitMs: number;
  noticeMs: number;
  freshnessMs: number;
}
