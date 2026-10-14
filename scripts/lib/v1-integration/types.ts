// Acceptance-only ports; these never change the application's contracts.
export type Fixture = '26.1.2' | '26.2';
export type Vec = { x: number; y: number; z: number };
export type Event = Record<string, unknown> & { type: string; t?: string; goalId?: string };
export type Phase = 'planned' | 'staged' | 'executed' | 'verified' | 'failed' | 'deferred';
export interface Scenario {
  id: string;
  criteria: readonly string[];
  family: 'resource' | 'movement' | 'equipment' | 'composition' | 'replan' | 'stop' | 'lifecycle' | 'privacy';
  instruction: string;
  supplies: Readonly<Record<string, number>>;
  outputs: Readonly<Record<string, number>>;
  trigger?: 'planner' | 'decision' | 'movement' | 'mining' | 'crafting' | 'furnace' | 'disconnect' | 'restart' | 'remove_target';
  persistent?: boolean;
}
export interface Artifact {
  head: string;
  dirty: boolean;
  sourceSha256: string;
  distSha256: string | null;
}
export interface Grant {
  version: 1;
  leaseId: string;
  fixture: Fixture;
  expiresAtMs: number;
  realProviders: true;
  artifact: Artifact;
}
export interface Intervention { atMs: number; kind: 'setup' | 'fault' | 'rescue'; detail: string }
export interface PayloadCapture {
  provider: 'planner' | 'jev';
  requestId: string;
  goalId: string;
  atMs: number;
  body: string;
}
export interface Evidence {
  goalId: string;
  epoch: number;
  events: Event[];
  journal: Event[];
  lines: string[];
  baseline: Record<string, number>;
  inventory: Record<string, number>;
  equipped: Record<string, string>;
  position: Vec;
  ownerPosition: Vec;
  interventions: Intervention[];
  captures: PayloadCapture[];
  captureComplete: boolean;
  hiddenFacts: string[];
  freshIdle?: { sinceMs: number; untilMs: number; events: Event[] };
  stop?: { sentAtMs: number; activeAtMs: number; family: NonNullable<Scenario['trigger']> };
}
export interface Result {
  id: string;
  phase: Phase;
  stagedAtMs?: number;
  executedAtMs?: number;
  verifiedAtMs?: number;
  problems: string[];
  autonomous: boolean;
  evidence?: Evidence;
}
export interface Cleanup {
  reconciled: boolean;
  steps: Array<{ step: string; ok: boolean; detail: string }>;
}
export interface Session {
  stage(scenario: Scenario): Promise<void>;
  execute(scenario: Scenario): Promise<Evidence>;
  close(): Promise<Cleanup>;
}
export interface RunReport {
  version: 1;
  mode: 'preparation' | 'real';
  fixture: Fixture;
  artifact: Artifact;
  leaseId: string | null;
  results: Result[];
  cleanup: Cleanup | null;
  acceptance: boolean;
  blockers: string[];
}
