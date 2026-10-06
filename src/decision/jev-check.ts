// `chunkbot jev-check`: ONE minimal live decision through the real adapter
// (same request building, price ceiling, reservation, validation and evidence
// as gameplay). Reads the key from the configured environment variable; the
// value is never printed or stored. Spends about USD 0.00002. It proves the
// provider route/model/billing fields only; it does not prove gameplay.
import type { LoadedConfig } from '../config/load.ts';
import { randomIds, systemClock, type ActionCandidate, type DecisionRequest } from '../contracts/index.ts';
import { FileRunStore } from '../telemetry/run-store.ts';
import { isDecisionError } from './errors.ts';
import { JevDecisionAdapter } from './jev-adapter.ts';
import { SpendLedger } from './spend.ts';

export interface JevCheckIo {
  json: boolean;
  out: (line: string) => void;
  err: (line: string) => void;
  exit: { ok: number; decisionNotConfigured: number; decisionFailed: number };
}

function probeCandidate(id: string, capability: string, description: string): ActionCandidate {
  return { id, capability, parameters: {}, snapshotId: 'snap-jevcheck', connectionEpoch: 0, goalEpoch: 0, description, criteria: [], preconditions: [], timeoutMs: 1_000 };
}

export async function runJevCheck(loaded: LoadedConfig, io: JevCheckIo): Promise<number> {
  const { config } = loaded;
  const d = config.models.decision;
  const store = new FileRunStore({ runsDir: loaded.runsDir, runId: randomIds.next('run'), clock: systemClock, maxEvents: 200, maxEventChars: config.storage.maxEventChars, keepRuns: config.storage.keepRuns });
  const spend = new SpendLedger(config.limits.openRouterSpendCapUsd);
  const adapter = new JevDecisionAdapter({
    endpoint: d.endpoint,
    model: d.model,
    apiKeyEnv: d.apiKeyEnv,
    env: () => process.env,
    expectedProvider: d.expectedProvider,
    spend,
    store,
    clock: systemClock,
    timeoutMs: config.limits.decisionTimeoutMs,
    minIntervalMs: config.limits.decisionMinIntervalMs,
    attemptsPerGoal: 2,
  });
  const wait = probeCandidate('act-jevcheckwait', 'probe_wait', 'Wait and take no action.');
  const move = probeCandidate('act-jevcheckmove', 'probe_move', 'Move the player.');
  const request: DecisionRequest = {
    requestId: randomIds.next('req'),
    goalId: 'goal-jevcheck',
    goalEpoch: 0,
    taskId: 'task-jevcheck',
    connectionEpoch: 0,
    snapshotId: 'snap-jevcheck',
    objective: 'Provider diagnostic: wait without changing the world.',
    instruction: 'Pick the option that waits without changing the world.',
    state: { fixture: 'chunkbot jev-check provider diagnostic (no game)', instruction: 'Pick the option that waits without changing the world.' },
    candidates: [move, wait],
  };
  io.out(`[jev-check] endpoint=${d.endpoint} model=${d.model} expectedProvider=${d.expectedProvider} keyEnv=${d.apiKeyEnv} (${process.env[d.apiKeyEnv] ? 'set' : 'NOT set'}; value never printed) evidence=${store.eventsPath}`);
  const started = Date.now();
  try {
    const choice = await adapter.choose(request, new AbortController().signal);
    const report = {
      ok: true,
      requestedModel: choice.requestedModel,
      model: choice.model,
      provider: choice.provider,
      generationId: choice.generationId ?? null,
      choice: choice.candidateId === wait.id ? 'wait' : 'move',
      choseExpected: choice.candidateId === wait.id,
      probabilities: { wait: choice.probabilities[wait.id], move: choice.probabilities[move.id] },
      confidence: choice.confidence,
      usage: choice.usage,
      latencyMs: choice.latencyMs,
      attempts: choice.attempts,
      spend: spend.snapshot(),
      wallMs: Date.now() - started,
    };
    io.out(io.json ? JSON.stringify(report, null, 2) : `[jev-check] OK ${JSON.stringify(report)}`);
    await store.close({ jevCheck: report });
    return io.exit.ok;
  } catch (error) {
    const failure = isDecisionError(error) ? error.failure : { kind: 'runtime', detail: error instanceof Error ? error.message : String(error), attempts: 0 };
    const report = { ok: false, failure, spend: spend.snapshot(), wallMs: Date.now() - started };
    io.err(io.json ? JSON.stringify(report, null, 2) : `[jev-check] FAILED ${JSON.stringify(report)}`);
    await store.close({ jevCheck: report });
    return failure.kind === 'not_configured' ? io.exit.decisionNotConfigured : io.exit.decisionFailed;
  }
}
