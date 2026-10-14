// Owned production entry points. Integration imports this module; it never
// copies schema/storage code into the manager, memory or gameplay services.
export { CheckpointAccounting } from './accounting.ts';
export { ManagedCheckpointStore, CheckpointHeldError } from './store.ts';
export { projectContinuationCheckpoint, projectRouteLineage, type ManagedGoalProjection } from './project.ts';
export { CHECKPOINT_FORMAT, CHECKPOINT_VERSION, CHECKPOINT_SEMANTICS, MAX_CHECKPOINT_BYTES,
  SemanticGoalSchema, ManagedCheckpointSchema, SpendCheckpointSchema,
  canonical, digest, portableOutcome,
  type CheckpointScope, type CheckpointAllowance, type ManagedCheckpoint, type SemanticGoal,
} from './schema.ts';
export type { CheckpointLoad, CheckpointStoreOptions, ResumeView, RestoreCheckpointSpend,
  CheckpointSpendPort, CheckpointDecisionOwner, CreateManagedSession, CaptureManagedGoal,
} from './ports.ts';
