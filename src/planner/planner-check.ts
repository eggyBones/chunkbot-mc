// `chunkbot planner-check`: verifies the Codex planner isolation gate and runs ONE
// small isolated subscription planner turn through the real CodexPlanner
// (same instructions, generated schema, transport, event validation and wire
// conversion as gameplay), with no Minecraft connection. `--probe` adds:
//   * a tool-exposure probe: the same isolated turn configuration asks the
//     model to list callable tools (expects none) and records input tokens —
//     corroborating evidence next to the supported config/feature gate;
//   * an in-flight cancellation probe: a turn is aborted after `turn.started`;
//     the owned process group must be gone and no final output used.
// Subscription usage only; it never uses an API key or another model.
import type { LoadedConfig } from '../config/load.ts';
import { randomIds, systemClock, type PlannerRequest } from '../contracts/index.ts';
import { SkillRegistry } from '../execution/registry.ts';
import { allSkills } from '../skills/index.ts';
import { FileRunStore } from '../telemetry/run-store.ts';
import { CodexPlanner } from './codex-planner.ts';
import { execArgs, writeOwnedFile } from './codex-cli.ts';
import { isPlannerError } from './errors.ts';
import { PLANNER_INSTRUCTIONS, PLANNER_INSTRUCTIONS_VERSION } from './prompt.ts';
import { runCodexTurn } from './transport.ts';
import { createHash } from 'node:crypto';

export interface PlannerCheckIo {
  json: boolean;
  probe: boolean;
  out: (line: string) => void;
  err: (line: string) => void;
  exit: { ok: number; plannerNotReady: number; plannerFailed: number };
}

export async function runPlannerCheck(loaded: LoadedConfig, io: PlannerCheckIo): Promise<number> {
  const { config } = loaded;
  const p = config.models.planner;
  if (p.mode !== 'codex') {
    io.err('[planner-check] models.planner.mode is "disabled" in this configuration; nothing to check');
    return io.exit.plannerNotReady;
  }
  const store = new FileRunStore({ runsDir: loaded.runsDir, runId: randomIds.next('run'), clock: systemClock, maxEvents: 400, maxEventChars: config.storage.maxEventChars, keepRuns: config.storage.keepRuns });
  const planner = new CodexPlanner({ command: p.command, model: p.model, effort: p.reasoningEffort, env: process.env, denyEnv: [config.models.decision.apiKeyEnv], store, timeoutMs: config.limits.plannerTimeoutMs, windowSteps: config.limits.planWindowSteps });
  const gate = planner.prepare();
  io.out(`[planner-check] gate ${gate.ok ? 'PASSED' : 'FAILED'}: ${gate.detail}`);
  for (const c of gate.checks) io.out(`[planner-check]   ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}`);
  if (!gate.ok || !planner.isolation) {
    await store.close({ plannerCheck: { ok: false, gate } });
    return io.exit.plannerNotReady;
  }
  const iso = planner.isolation;
  io.out(`[planner-check] env passed to the CLI: ${Object.keys(iso.env).sort().join(', ')} (allowlist; ${config.models.decision.apiKeyEnv} and all key/token/session/billing inputs excluded)`);
  const catalog = new SkillRegistry(allSkills()).catalog();
  const report: Record<string, unknown> = { gate: gate.checks, selectedModel: iso.model, effort: iso.effort, cliVersion: iso.cliVersion, identity: 'selected model only; the CLI does not echo a server-resolved model; no reroute event accepted' };

  // 1. one real planning turn (no game connected)
  const request: PlannerRequest = {
    requestId: randomIds.next('req'),
    subject: { kind: 'goal', goalId: 'goal-plannercheck', goalEpoch: 0 },
    instruction: 'craft a wooden pickaxe',
    turn: 1,
    maxTurns: config.limits.plannerTurnsPerGoal,
    catalog,
    observation: null,
    knowledge: [],
    turnKind: 'initial',
    admission: { capturedAtMs: Date.now(), counts: [], detail: 'planner-check diagnostic: no game is connected; empty inventory assumed' },
    mechanicsVersion: config.minecraft.version,
    limits: { travelRadius: config.limits.travelRadius, observationRadius: config.limits.observationRadius, planWindowSteps: config.limits.planWindowSteps },
  };
  const started = Date.now();
  try {
    const proposal = await planner.propose(request, new AbortController().signal);
    report['turn'] = { ok: true, wallMs: Date.now() - started, disposition: proposal.disposition, interpretation: proposal.interpretation, usage: planner.totals, ...(proposal.disposition === 'needs_information' ? { queries: proposal.queries } : {}), ...(proposal.disposition === 'plan' ? { tasks: proposal.tasks.length } : {}) };
    io.out(`[planner-check] turn OK in ${Date.now() - started} ms: ${proposal.disposition} — ${proposal.interpretation.slice(0, 160)}`);
  } catch (error) {
    const failure = isPlannerError(error) ? error.failure : { kind: 'process_error', detail: error instanceof Error ? error.message : String(error) };
    report['turn'] = { ok: false, failure };
    io.err(`[planner-check] turn FAILED: ${JSON.stringify(failure)}`);
    await store.close({ plannerCheck: report });
    return io.exit.plannerFailed;
  }

  if (io.probe) {
    // 2. tool-exposure self-report under the identical isolation configuration
    const probeSchema = { type: 'object', additionalProperties: false, properties: { callableTools: { type: 'array', items: { type: 'string' } } }, required: ['callableTools'] };
    const schemaPath = writeOwnedFile(iso.neutralDir, 'probe-tools-schema.json', `${JSON.stringify(probeSchema)}\n`);
    const instructionsPath = writeOwnedFile(iso.neutralDir, `instructions-${PLANNER_INSTRUCTIONS_VERSION}-${createHash('sha256').update(PLANNER_INSTRUCTIONS).digest('hex').slice(0, 12)}.txt`, PLANNER_INSTRUCTIONS);
    try {
      const t = await runCodexTurn({ command: iso.command, args: execArgs(iso, schemaPath, instructionsPath), cwd: iso.neutralDir, env: iso.env, prompt: 'Diagnostic: list the exact names of every tool or function you can call in this conversation (an empty list if none). Do not call anything.', timeoutMs: config.limits.plannerTimeoutMs, signal: new AbortController().signal });
      const tools = (JSON.parse(t.finalText) as { callableTools?: string[] }).callableTools ?? [];
      report['toolProbe'] = { callableTools: tools, usage: t.usage, eventCounts: t.eventCounts, note: 'model self-report; corroborates the supported config/feature gate (prose alone is not isolation)' };
      io.out(`[planner-check] tool probe: callableTools=${JSON.stringify(tools)} inputTokens=${t.usage?.inputTokens ?? '?'} events=${JSON.stringify(t.eventCounts)}`);
      if (tools.length > 0) {
        await store.close({ plannerCheck: report });
        io.err('[planner-check] tool probe reports callable tools: isolation NOT confirmed');
        return io.exit.plannerFailed;
      }
    } catch (error) {
      report['toolProbe'] = { ok: false, failure: isPlannerError(error) ? error.failure : String(error) };
      io.err(`[planner-check] tool probe failed: ${JSON.stringify(report['toolProbe'])}`);
      await store.close({ plannerCheck: report });
      return io.exit.plannerFailed;
    }
    // 3. in-flight cancellation of an owned turn
    const abort = new AbortController();
    let startedAt = 0;
    let cleanup: unknown = null;
    const t0 = Date.now();
    try {
      await runCodexTurn({
        command: iso.command,
        args: execArgs(iso, schemaPath, instructionsPath),
        cwd: iso.neutralDir,
        env: iso.env,
        prompt: 'Diagnostic: list the exact names of every tool or function you can call in this conversation (an empty list if none).',
        timeoutMs: config.limits.plannerTimeoutMs,
        signal: abort.signal,
        onEvent: (type) => {
          if (type === 'turn.started' && !startedAt) {
            startedAt = Date.now();
            abort.abort();
          }
        },
        onCleanup: (c) => (cleanup = c),
      });
      report['cancelProbe'] = { ok: false, detail: 'the turn completed before it could be cancelled' };
    } catch (error) {
      const kind = isPlannerError(error) ? error.failure.kind : 'unknown';
      const c = cleanup as { remaining?: number[]; elapsedMs?: number; signals?: string[]; pid?: number } | null;
      report['cancelProbe'] = { ok: kind === 'aborted' && Boolean(c) && (c?.remaining?.length ?? 1) === 0, kind, turnStartedAfterMs: startedAt ? startedAt - t0 : null, cleanup };
      io.out(`[planner-check] cancel probe: ${kind} after turn.started; pid ${c?.pid} signals ${JSON.stringify(c?.signals)} cleanup ${c?.elapsedMs} ms; remaining owned pids ${JSON.stringify(c?.remaining)}`);
    }
    if (!(report['cancelProbe'] as { ok: boolean }).ok) {
      await store.close({ plannerCheck: report });
      io.err(`[planner-check] cancel probe did not verify: ${JSON.stringify(report['cancelProbe'])}`);
      return io.exit.plannerFailed;
    }
  }
  if (io.json) io.out(JSON.stringify(report, null, 2));
  await store.close({ plannerCheck: report });
  io.out(`[planner-check] OK; evidence ${store.eventsPath}`);
  return io.exit.ok;
}
