// PlannerPort backed by the Codex SUBSCRIPTION CLI (managed ChatGPT sign-in).
//
// One bounded, fresh, ephemeral turn per planner request: the gameplay-only
// instructions, the generated strict output schema for the current catalog,
// and the bounded JSON input rendered from contract data. The reply is parsed,
// scanned for forbidden content and converted to the shared proposal
// contract; the goal engine then validates references and semantics before
// any action. The planner only proposes; it never controls Minecraft, edits
// files or launches anything.
//
// Failures are typed (auth, quota, model_unavailable, model_mismatch,
// prohibited_event, invalid_output, timeout, process_error, aborted). A model
// reroute or a prohibited tool/agent event disables the planner for the rest
// of the application run. There is never a planner model/provider/billing
// fallback; quota/auth errors carry actionable subscription evidence.
import { subjectRef, type EvidenceEvent, type PlannerPort, type PlannerProposal, type PlannerRequest, type Readiness, type RunStore } from '../contracts/index.ts';
import { CODEX_PROFILE, checkManagedAuthAsync, execArgs, verifyIsolation, writeOwnedFile, type IsolationCheck, type PlannerEffort, type VerifiedIsolation } from './codex-cli.ts';
import { PlannerError, isPlannerError, plannerFailureAdvice } from './errors.ts';
import type { ProcessTable } from './process.ts';
import { PLANNER_INSTRUCTIONS, PLANNER_INSTRUCTIONS_VERSION, renderRequest } from './prompt.ts';
import { runCodexTurn, type TurnResult, type TurnUsage } from './transport.ts';
import { WireError, plannerOutputSchema, proposalFromWire, schemaDigest } from './wire.ts';
import { createHash } from 'node:crypto';
import type { CliRunner } from './codex-cli.ts';

export interface CodexPlannerOptions {
  command: string;
  model: string;
  effort: PlannerEffort;
  /** Source environment (scrubbed to an allowlist before reaching the CLI). */
  env: NodeJS.ProcessEnv;
  /** Env NAMES that must never reach the planner (e.g. the configured Jev key name). */
  denyEnv: readonly string[];
  store: RunStore;
  /** Bounded planner journal (interpretations, proposals, usage); defaults to the run store. */
  journal?: { record(event: EvidenceEvent): void };
  timeoutMs: number;
  windowSteps: number;
  neutralDir?: string;
  runner?: CliRunner;
  table?: ProcessTable;
}

export interface PlannerUsageTotals {
  turns: number;
  completedTurns: number;
  failedTurns: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
}

const digest = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 12);

export class CodexPlanner implements PlannerPort {
  private readonly options: CodexPlannerOptions;
  private iso: VerifiedIsolation | undefined;
  private gate: { ok: boolean; detail: string; checks: IsolationCheck[] } = { ok: false, detail: 'isolation gate not run yet', checks: [] };
  private disabled: string | undefined;
  private instructionsPath: string | undefined;
  private readonly schemaPaths = new Map<string, { path: string; digest: string }>();
  private inFlight = 0;
  readonly totals: PlannerUsageTotals = { turns: 0, completedTurns: 0, failedTurns: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };

  constructor(options: CodexPlannerOptions) {
    this.options = options;
  }

  /** Runs the versioned isolation gate and materializes the app-owned files. Read-only towards Codex settings. */
  prepare(): { ok: boolean; detail: string; checks: IsolationCheck[] } {
    const r = verifyIsolation(
      {
        command: this.options.command,
        model: this.options.model,
        effort: this.options.effort,
        env: this.options.env,
        denyEnv: this.options.denyEnv,
        ...(this.options.neutralDir ? { neutralDir: this.options.neutralDir } : {}),
        ...(this.options.runner ? { runner: this.options.runner } : {}),
      },
      true,
    );
    if (!r.ok) {
      this.iso = undefined;
      this.gate = { ok: false, detail: r.detail, checks: r.checks };
    } else {
      this.iso = r.isolation;
      this.instructionsPath = writeOwnedFile(r.isolation.neutralDir, `instructions-${PLANNER_INSTRUCTIONS_VERSION}-${digest(PLANNER_INSTRUCTIONS)}.txt`, PLANNER_INSTRUCTIONS);
      this.gate = { ok: true, detail: 'isolation verified', checks: r.isolation.checks };
    }
    this.options.store.record({
      type: 'planner_isolation',
      ok: this.gate.ok,
      detail: this.gate.detail,
      checks: this.gate.checks,
      ...(this.iso
        ? {
            cliVersion: this.iso.cliVersion,
            selectedModel: this.iso.model,
            effort: this.iso.effort,
            catalogDigest: this.iso.catalogDigest,
            bundledModelDigest: this.iso.bundledModelDigest,
            featureStages: this.iso.featureStages,
            envNames: Object.keys(this.iso.env).sort(),
            instructions: PLANNER_INSTRUCTIONS_VERSION,
            identity: 'selected model only: the CLI JSON stream does not echo a server-resolved model; any reroute event rejects the turn',
          }
        : {}),
    });
    return this.gate;
  }

  get isolation(): VerifiedIsolation | undefined {
    return this.iso;
  }

  readiness(): Readiness {
    if (this.disabled) return { ready: false, detail: `Codex subscription planner disabled for this run: ${this.disabled}` };
    if (!this.iso) return { ready: false, detail: `Codex subscription planner not ready: ${this.gate.detail}` };
    return {
      ready: true,
      detail: `Codex subscription planner (codex-cli ${this.iso.cliVersion}, selected ${this.iso.model}/${this.iso.effort}; server-resolved identity is not echoed by the CLI) with verified isolation: no tools/agents/MCP/skills/project docs, read-only, ephemeral, neutral cwd`,
    };
  }

  /** Disables the planner for the rest of the run (isolation breach / model reroute). */
  disable(reason: string): void {
    this.disabled ??= reason;
    this.options.store.record({ type: 'planner_disabled_for_run', reason });
  }

  private schemaFor(request: PlannerRequest): { path: string; digest: string } {
    const cached = this.schemaPaths.get(request.catalog.catalogVersion);
    if (cached) return cached;
    const schema = plannerOutputSchema(request.catalog);
    const d = schemaDigest(schema);
    const path = writeOwnedFile(this.iso!.neutralDir, `output-schema-${request.catalog.catalogVersion}-${d}.json`, `${JSON.stringify(schema)}\n`);
    const entry = { path, digest: d };
    this.schemaPaths.set(request.catalog.catalogVersion, entry);
    return entry;
  }

  async propose(request: PlannerRequest, signal: AbortSignal): Promise<PlannerProposal> {
    if (this.disabled) throw new PlannerError('not_ready', `planner disabled for this run: ${this.disabled}`);
    if (!this.iso || !this.instructionsPath) throw new PlannerError('not_ready', this.gate.detail);
    if (this.inFlight > 0) throw new PlannerError('process_error', 'another planner turn is already in flight (one turn at a time)');
    const iso = this.iso;
    const schema = this.schemaFor(request);
    const prompt = renderRequest(request, request.limits?.planWindowSteps ?? this.options.windowSteps);
    const journal = this.options.journal ?? this.options.store;
    const base = { requestId: request.requestId, ...(request.subject.kind === 'goal' ? { goalId: request.subject.goalId } : { intentId: request.subject.intentId, generation: request.subject.generation }), subject: subjectRef(request.subject), turn: request.turn, turnKind: request.turnKind ?? 'initial' };
    this.inFlight += 1;
    // MB-PLAN-002: re-verify the managed ChatGPT subscription login before EVERY turn
    // (a login changed after startup is caught before inference). Mode only, read-only.
    let auth: Awaited<ReturnType<typeof checkManagedAuthAsync>>;
    try {
      auth = await checkManagedAuthAsync(iso.command, iso.env, iso.neutralDir);
    } catch (error) {
      this.inFlight -= 1;
      throw error;
    }
    if (!auth.ok || signal.aborted) {
      this.inFlight -= 1;
      if (signal.aborted) throw new PlannerError('aborted', 'the owning goal was revoked before the turn started');
      this.options.store.record({ type: 'planner_auth_rejected', ...base, authMode: auth.mode, advice: plannerFailureAdvice('auth') });
      throw new PlannerError('auth', auth.detail);
    }
    this.totals.turns += 1;
    this.options.store.record({ type: 'planner_turn_started', ...base, authMode: auth.mode, promptChars: prompt.length, promptDigest: digest(prompt), schemaDigest: schema.digest, catalogVersion: request.catalog.catalogVersion, snapshotId: request.observation?.id ?? null, selectedModel: iso.model, effort: iso.effort });
    let turn: TurnResult;
    try {
      turn = await runCodexTurn({
        command: iso.command,
        args: execArgs(iso, schema.path, this.instructionsPath),
        cwd: iso.neutralDir,
        env: iso.env,
        prompt,
        timeoutMs: this.options.timeoutMs,
        signal,
        ...(this.options.table ? { table: this.options.table } : {}),
        onCleanup: (c) => this.options.store.record({ type: 'planner_process_cleanup', ...base, ...c }),
      });
    } catch (error) {
      this.totals.failedTurns += 1;
      if (isPlannerError(error)) {
        const f = error.failure;
        if (f.kind === 'model_mismatch' || f.kind === 'prohibited_event') this.disable(`${f.kind}: ${f.detail}`);
        this.options.store.record({ type: 'planner_turn_failed', ...base, kind: f.kind, detail: f.detail, advice: plannerFailureAdvice(f.kind) });
      }
      throw error;
    } finally {
      this.inFlight -= 1;
    }
    this.totals.completedTurns += 1;
    this.addUsage(turn.usage);
    const evidence = {
      ...base,
      elapsedMs: turn.elapsedMs,
      pid: turn.pid,
      threadId: turn.threadId,
      usage: turn.usage,
      eventCounts: turn.eventCounts,
      warnings: turn.warnings,
      selectedModel: iso.model,
      effort: iso.effort,
      resolvedModel: 'not echoed by the CLI (no reroute event observed)',
      finalChars: turn.finalText.length,
    };
    this.options.store.record({ type: 'planner_turn_completed', ...evidence });
    let raw: unknown;
    try {
      raw = JSON.parse(turn.finalText);
    } catch {
      throw this.invalid(base, ['the final message is not JSON']);
    }
    let proposal: PlannerProposal;
    try {
      proposal = proposalFromWire(raw);
    } catch (error) {
      if (error instanceof WireError) throw this.invalid(base, error.problems);
      throw error;
    }
    journal.record({ type: 'planner_proposal_raw', ...base, usage: turn.usage, elapsedMs: turn.elapsedMs, proposal: proposal as unknown as Record<string, unknown> });
    return proposal;
  }

  private invalid(base: Record<string, unknown>, problems: string[]): PlannerError {
    this.options.store.record({ type: 'planner_output_rejected', ...base, problems: problems.slice(0, 12) });
    return new PlannerError('invalid_output', problems.slice(0, 3).join('; '), problems.slice(0, 12));
  }

  private addUsage(u: TurnUsage | null): void {
    if (!u) return;
    this.totals.inputTokens += u.inputTokens;
    this.totals.cachedInputTokens += u.cachedInputTokens;
    this.totals.outputTokens += u.outputTokens;
    this.totals.reasoningOutputTokens += u.reasoningOutputTokens;
  }

  /** Static description for status/doctor (no inference). */
  describe(): string {
    return `codex-cli ${this.iso?.cliVersion ?? '?'} ${this.options.model}/${this.options.effort} (pinned profile ${CODEX_PROFILE.cliVersion})`;
  }
}
