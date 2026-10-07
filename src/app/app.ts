// Application composition: one bot connection, one owner, one active goal.
// Both control surfaces (owner chat and local terminal) route through the same
// command router into the same goal engine.
import type {
  CapabilityRegistry,
  DecisionPort,
  EvidenceEvent,
  PriorResultRef,
  RegistryFacts,
  PredicateEvaluator,
  TaskExecutionPort,
  TaskMode,
  ChatEnvelope,
  Clock,
  KnowledgePort,
  MemoryPlannerPort,
  ObservationPort,
  PlannerPort,
  SkillExecutor,
  GameLifecycleEvent,
  GamePort,
  IdSource,
  IntakeOrigin,
  ReadyInfo,
  RunStore,
} from '../contracts/index.ts';
import type { ChunkbotConfig } from '../config/schema.ts';
import { parseChatLine, parseTerminalLine, type ParsedCommand } from '../commands/parse.ts';
import { routeCommand, type CommandTarget } from '../commands/router.ts';
import { evaluateOwner, ownerPolicyFromConfig, type OwnerPolicy } from '../game/identity.ts';
import { GoalEngine, type GoalEngineDeps, type GoalTerminalEvent } from '../goals/goal-engine.ts';
import {
  NotReadyDecision,
  NotReadyKnowledge,
  NotReadyObservation,
  NotReadyPlanner,
  NotReadySkillExecutor,
  StaticCapabilityRegistry,
} from '../goals/not-ready.ts';
import { renderStatusChat, renderStatusLines } from './status.ts';

export const TERMINAL_HELP = [
  'Terminal uses the same language as `!chunkbot` chat, without the prefix:',
  '  <any instruction>        new goal (replaces the current one)',
  '  goal <instruction>       explicit goal alias (use for text starting with a reserved word)',
  '  stop                     stop the current goal and any pending instruction (or cancel joining); sets the pause latch',
  '  resume                   clear the pause latch (bare word; nothing is replayed)',
  '  status                   connection/goal/adapter status (no inference)',
  '  answer [qN] <reply>      reply to the pending clarification question',
  'Operator commands: /reconnect  /quit  /help',
  'Mechanic diagnostics (operator-chosen, no model): /diag catalog|observe|knowledge|candidates|run|do|inventory|bind|eval|anchor',
  'Task controller diagnostic (operator-written TaskSpec, REAL Jev choices, not goal planning):',
  '  /task <TaskSpec json>            run until the completion predicate is verified (or blocked/stopped)',
  '  /task maintain <TaskSpec json>   keep the completion predicate as a condition until stopped/blocked',
];

export interface AppDeps {
  config: ChunkbotConfig;
  game: GamePort;
  store: RunStore;
  clock: Clock;
  ids: IdSource;
  /** Terminal output (one line per call). */
  out: (line: string) => void;
  /** Extra run facts for evidence (versions, config summary). */
  runFacts: Record<string, unknown>;
  /** Adapter overrides; later assignments install real adapters through these ports. */
  adapters?: Partial<AppAdapters>;
  /** Without an operator terminal there is nobody to /reconnect: shut down when the connection ends. */
  exitOnConnectionEnd?: boolean;
  /** Skill-layer hooks (MB-V1-02): lifecycle revocation, non-goal control cancellation, diagnostics. */
  extensions?: AppExtensions;
  /** Bounded planner journal (interpretations, proposals, questions/answers, final evidence). */
  journal?: { record(event: EvidenceEvent): void };
  /** Extra status lines (e.g. planner usage); no inference. */
  statusExtras?: () => string[];
}

export interface AppExtensions {
  /** Called first for every lifecycle event (e.g. revoke the actuator lease on death/disconnect). */
  onLifecycle?(event: GameLifecycleEvent): void;
  /** Cancels non-goal actuation (operator diagnostics). Must invalidate ownership synchronously. */
  cancelControl?(reason: string): boolean;
  /** Goal admission ownership (before planning): see GoalEngineDeps.onGoalAdmitted. */
  onGoalAdmitted?(admission: Parameters<NonNullable<GoalEngineDeps['onGoalAdmitted']>>[0]): void;
  /** Goal terminal (after cleanup): see GoalEngineDeps.onGoalTerminal. */
  onGoalTerminal?(end: GoalTerminalEvent): void;
  /** MB-FLOW-001: synchronous pause-latch hook (stop/resume) — see GoalEngineDeps.onLatchChanged. */
  onLatchChanged?: GoalEngineDeps['onLatchChanged'];
  /** MB-FLOW-001: a pending owner instruction ended without admission. */
  onPreparationDiscarded?: GoalEngineDeps['onPreparationDiscarded'];
  /** MB-LOC-001: owner coordinates newly parsed from a clarification answer. */
  onOwnerCoordinates?: GoalEngineDeps['onOwnerCoordinates'];
  /** MB-LOC-001 planner-request views (read-only). */
  routeView?: GoalEngineDeps['routeView'];
  locatorHint?: GoalEngineDeps['locatorHint'];
  /** Optional evaluators installed (proposal validation). */
  installed?: GoalEngineDeps['installed'];
  /** MB-FLOW-003-C5 owned admission barrier (durable recovery authority before any model call/action). */
  admissionBarrier?: GoalEngineDeps['admissionBarrier'];
  /** Extra status lines and chat summary for autonomy/survival/route (read-only; no inference). */
  autonomyStatus?(): { lines: string[]; chat: string } | undefined;
  /** Terminal-only operator mechanic diagnostics (`/diag ...`). */
  diagnostic?(args: string): Promise<void>;
}

/** Exit code used when Chunkbot shuts down because its connection ended (no operator terminal). */
export const EXIT_CONNECTION_ENDED = 3;

export interface AppAdapters {
  planner: PlannerPort;
  knowledge: KnowledgePort;
  observation: ObservationPort;
  capabilities: CapabilityRegistry;
  executor: SkillExecutor;
  /** Generic task runtime (MB-V1-03); absent in the foundation. */
  tasks?: TaskExecutionPort;
  /** Goal-level outcome evaluator for plan windows. */
  outcomes?: PredicateEvaluator;
  /** Jev decision adapter (status/readiness only; the task runtime calls it). */
  decision?: DecisionPort;
  /** Version registry facts for planner reference validation. */
  registry?: RegistryFacts;
  /** Ledger-verified prior results by action id. */
  priorResults?: (actionIds: readonly string[]) => PriorResultRef[];
  /** MB-MEM-001 planner seam (absent: memory not installed). */
  memory?: MemoryPlannerPort;
}

export function foundationAdapters(): AppAdapters {
  return {
    planner: new NotReadyPlanner(),
    knowledge: new NotReadyKnowledge(),
    observation: new NotReadyObservation(),
    capabilities: new StaticCapabilityRegistry(),
    executor: new NotReadySkillExecutor(),
    decision: new NotReadyDecision(),
  };
}

export type ShutdownReason = 'operator_quit' | 'signal' | 'terminal_closed' | 'connect_check' | 'connection_ended';

export class ChunkbotApp implements CommandTarget {
  readonly engine: GoalEngine;
  private readonly decision: DecisionPort;
  private readonly deps: AppDeps;
  private readonly policy: OwnerPolicy;
  private readyInfo: ReadyInfo | undefined;
  private joinAbort: AbortController | undefined;
  private connecting: Promise<ReadyInfo | undefined> | undefined;
  private shutdownPromise: Promise<number> | undefined;
  private readonly unsubscribe: Array<() => void> = [];
  private readonly counters = {
    chatIgnoredUnprefixed: 0,
    chatRejected: 0,
    chatAdmitted: 0,
    terminalCommands: 0,
    connections: 0,
  };
  private lastEnd: { reason: string; detail: string } | undefined;
  private readonly closedSignal = Promise.withResolvers<number>();
  /** Resolves with the exit code once shutdown has fully completed (any path). */
  readonly closed: Promise<number> = this.closedSignal.promise;

  constructor(deps: AppDeps) {
    this.deps = deps;
    this.policy = ownerPolicyFromConfig(deps.config);
    const limits = deps.config.limits;
    const adapters = { ...foundationAdapters(), ...deps.adapters };
    this.decision = adapters.decision ?? new NotReadyDecision();
    const { tasks, outcomes, decision: _decision, registry, priorResults, memory, ...ports } = adapters;
    void _decision;
    this.engine = new GoalEngine({
      ...ports,
      ...(tasks ? { tasks } : {}),
      ...(outcomes ? { outcomes } : {}),
      ...(registry ? { registry } : {}),
      ...(priorResults ? { priorResults } : {}),
      ...(memory ? { memory } : {}),
      ...(deps.journal ? { journal: deps.journal } : {}),
      mechanicsVersion: deps.config.minecraft.version,
      store: deps.store,
      clock: deps.clock,
      ids: deps.ids,
      limits: {
        maxInstructionChars: deps.config.chat.maxInstructionChars,
        plannerTurnsPerGoal: limits.plannerTurnsPerGoal,
        plannerTimeoutMs: limits.plannerTimeoutMs,
        planWindowSteps: limits.planWindowSteps,
        totalTaskCeiling: limits.totalTaskCeiling,
        goalDeadlineMs: limits.goalDeadlineMs,
        cleanupTimeoutMs: limits.cleanupTimeoutMs,
        replans: limits.replans,
        travelRadius: limits.travelRadius,
        observationRadius: limits.observationRadius,
      },
      flow: deps.config.flow,
      connectionEpoch: () => this.deps.game.connectionEpoch,
      notify: (notice) => {
        this.deps.out(`[chunkbot] ${notice.text}`);
        // Terminal-only operator diagnostics are not whispered in game (no chat spam).
        if (notice.audience !== 'operator') this.deps.game.replyToOwner(notice.text);
      },
      isGameReady: () => this.deps.game.state === 'ready',
      onGoalAdmitted: (admission) => this.deps.extensions?.onGoalAdmitted?.(admission),
      onGoalTerminal: (end) => this.deps.extensions?.onGoalTerminal?.(end),
      onLatchChanged: (latch, cause) => this.deps.extensions?.onLatchChanged?.(latch, cause),
      onPreparationDiscarded: (p) => this.deps.extensions?.onPreparationDiscarded?.(p),
      onOwnerCoordinates: (e) => this.deps.extensions?.onOwnerCoordinates?.(e),
      ...(deps.extensions?.routeView ? { routeView: deps.extensions.routeView } : {}),
      ...(deps.extensions?.locatorHint ? { locatorHint: deps.extensions.locatorHint } : {}),
      ...(deps.extensions?.installed ? { installed: deps.extensions.installed } : {}),
      ...(deps.extensions?.admissionBarrier ? { admissionBarrier: deps.extensions.admissionBarrier } : {}),
    });
    this.unsubscribe.push(deps.game.onLifecycle((event) => this.onLifecycle(event)));
    this.unsubscribe.push(deps.game.onChat((envelope) => this.onChat(envelope)));
    deps.store.record({ type: 'run_started', ...deps.runFacts });
  }

  get connectionState(): GamePort['state'] {
    return this.deps.game.state;
  }

  get lastReady(): ReadyInfo | undefined {
    return this.readyInfo;
  }

  get lastConnectionEnd(): { reason: string; detail: string } | undefined {
    return this.lastEnd;
  }

  /** Starts (or restarts) joining. Resolves with ready info, or undefined if the join ended. */
  connect(): Promise<ReadyInfo | undefined> {
    if (this.connecting) return this.connecting;
    if (this.shutdownPromise) return Promise.resolve(undefined);
    const abort = new AbortController();
    this.joinAbort = abort;
    this.counters.connections += 1;
    const { host, port, version } = this.deps.config.minecraft;
    this.deps.out(`[chunkbot] joining ${host}:${port} as ${this.deps.config.bot.auth === 'offline' ? this.deps.config.bot.username : 'the signed-in bot account'} (version ${version}, auth ${this.deps.config.bot.auth})…`);
    this.connecting = this.deps.game
      .connect(abort.signal)
      .then((info) => info)
      .catch(() => undefined)
      .finally(() => {
        this.connecting = undefined;
        if (this.joinAbort === abort) this.joinAbort = undefined;
      });
    return this.connecting;
  }

  // ------------------------------------------------------------ inputs

  async handleTerminalLine(line: string): Promise<void> {
    const command = parseTerminalLine(line, this.deps.config.chat.prefix);
    if (!command) return;
    this.counters.terminalCommands += 1;
    await this.dispatch(command, { surface: 'terminal', principal: 'operator' });
  }

  private onChat(envelope: ChatEnvelope): void {
    // Unaddressed chat is ordinary data: never parsed further, recorded, or sent to a model.
    const command = envelope.kind === 'player' ? parseChatLine(envelope.text, this.deps.config.chat.prefix) : null;
    if (envelope.kind === 'player' && !command) {
      this.counters.chatIgnoredUnprefixed += 1;
      return;
    }
    const looksAddressed = command !== null || envelope.text.toLowerCase().includes(this.deps.config.chat.prefix.toLowerCase());
    if (!looksAddressed) return;
    const decision = evaluateOwner(this.policy, envelope, this.deps.game.admissionContext());
    if (!decision.admitted) {
      this.counters.chatRejected += 1;
      // Rejected text is not stored: unrelated chat stays out of evidence.
      this.deps.store.record({ type: 'chat_rejected', kind: envelope.kind, reason: decision.reason });
      this.deps.out(`[chat] ignored ${envelope.kind} message addressed to Chunkbot (${decision.reason})`);
      return;
    }
    if (!command) return;
    this.counters.chatAdmitted += 1;
    this.deps.store.record({ type: 'chat_admitted', command: command.kind });
    this.deps.out(`[chat] owner: ${envelope.text.slice(0, 200)}`);
    void this.dispatch(command, { surface: 'chat', principal: 'owner' });
  }

  private async dispatch(command: ParsedCommand, origin: IntakeOrigin): Promise<void> {
    try {
      await routeCommand(command, origin, this);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.store.record({ type: 'command_error', command: command.kind, message });
      this.deps.out(`[chunkbot] command failed: ${message}`);
    }
  }

  // ------------------------------------------------------------ CommandTarget

  async submitGoal(instruction: string, origin: IntakeOrigin): Promise<void> {
    // A valid new instruction replaces any operator diagnostic action (one control owner).
    const text = instruction.trim();
    if (text.length > 0 && text.length <= this.deps.config.chat.maxInstructionChars && this.deps.game.state === 'ready') {
      this.deps.extensions?.cancelControl?.('replaced_by_goal');
    }
    await this.engine.submit(instruction, origin);
  }

  async diagnostic(args: string): Promise<void> {
    if (!this.deps.extensions?.diagnostic) {
      this.deps.out('[chunkbot] mechanic diagnostics are not installed');
      return;
    }
    await this.deps.extensions.diagnostic(args);
  }

  /** `/task [maintain] <TaskSpec json>`: operator task diagnostic through the goal engine's ownership path. */
  async task(args: string): Promise<void> {
    const origin: IntakeOrigin = { surface: 'terminal', principal: 'operator' };
    let text = args.trim();
    let mode: TaskMode = 'complete';
    if (/^maintain\s/i.test(text)) {
      mode = 'maintain';
      text = text.slice('maintain'.length).trim();
    }
    let spec: unknown;
    try {
      spec = JSON.parse(text);
    } catch {
      this.deps.out('[chunkbot] usage: /task [maintain] <TaskSpec json>  (see /help)');
      return;
    }
    if (this.deps.game.state === 'ready') this.deps.extensions?.cancelControl?.('replaced_by_task');
    const result = await this.engine.submitOperatorTask(spec, mode, origin);
    if (result.status === 'admitted') this.deps.out(`[task-json] ${JSON.stringify({ kind: 'task_admitted', goalId: result.goal.id, epoch: result.goal.epoch, mode })}`);
  }

  async stop(origin: IntakeOrigin): Promise<void> {
    // Non-goal actuation (diagnostics) is invalidated and its controls cleared first.
    const cancelledControl = this.deps.extensions?.cancelControl?.('operator_stop') ?? false;
    if (this.deps.game.state === 'joining' && this.joinAbort) {
      this.deps.store.record({ type: 'join_cancel_requested', surface: origin.surface });
      this.deps.out('[chunkbot] stop: cancelling join…');
      this.joinAbort.abort();
      await this.connecting;
      await this.engine.stop('owner_stop', origin.surface);
      return;
    }
    const result = await this.engine.stop('owner_stop', origin.surface);
    if (!result.stopped && !cancelledControl) {
      const text = 'Nothing to stop; Chunkbot is idle.';
      this.deps.out(`[chunkbot] ${text}`);
      if (origin.surface === 'chat') this.deps.game.replyToOwner(text);
    }
  }

  resume(origin: IntakeOrigin): void {
    const { wasPaused } = this.engine.resume(origin.surface);
    const text = wasPaused
      ? 'Resumed: automatic work is allowed again. Nothing earlier is replayed and nothing new was started.'
      : 'Automatic work is not paused; nothing to resume.';
    this.deps.out(`[chunkbot] ${text}`);
    if (origin.surface === 'chat') this.deps.game.replyToOwner(text);
  }

  status(origin: IntakeOrigin): void {
    const input = {
      connection: this.deps.game.state,
      ready: this.readyInfo,
      live: this.deps.game.statusInfo(),
      engine: this.engine.status(),
      decision: this.decision.readiness(),
    };
    this.deps.store.record({ type: 'status_requested', surface: origin.surface });
    const autonomy = this.deps.extensions?.autonomyStatus?.();
    for (const line of [...renderStatusLines(input), ...(autonomy?.lines ?? []), ...(this.deps.statusExtras?.() ?? [])]) this.deps.out(`[status] ${line}`);
    if (origin.surface === 'chat') this.deps.game.replyToOwner(`${renderStatusChat(input)}${autonomy ? `; ${autonomy.chat}` : ''}`);
  }

  answer(reply: string, ref: string | undefined, origin: IntakeOrigin): void {
    this.engine.answer(reply, ref, origin.surface);
  }

  invalid(detail: string, origin: IntakeOrigin): void {
    this.deps.store.record({ type: 'command_invalid', surface: origin.surface });
    this.deps.out(`[chunkbot] ${detail}`);
  }

  async operator(verb: 'quit' | 'reconnect' | 'help'): Promise<void> {
    switch (verb) {
      case 'help':
        for (const line of TERMINAL_HELP) this.deps.out(line);
        return;
      case 'reconnect':
        if (this.deps.game.state === 'joining' || this.deps.game.state === 'ready') {
          this.deps.out(`[chunkbot] already ${this.deps.game.state}`);
          return;
        }
        await this.connect();
        return;
      case 'quit':
        await this.shutdown('operator_quit');
        return;
    }
  }

  // ------------------------------------------------------------ lifecycle

  private onLifecycle(event: GameLifecycleEvent): void {
    // Ownership first: the engine's synchronous revocation prefix invalidates the
    // goal/task epoch and aborts provider I/O and the running action BEFORE the
    // skill layer releases actuator/interface resources for the lifecycle event.
    const hadGoal = this.engine.hasActiveGoal;
    if (event.type === 'death') void this.engine.endOwnership('death', 'the bot died');
    else if (event.type === 'dimension_change') void this.engine.endOwnership('dimension_change', `dimension changed from ${event.from} to ${event.to}`);
    else if (event.type === 'ended') void this.engine.endOwnership(event.reason === 'kicked' ? 'kicked' : 'disconnected', `connection ended (${event.reason}): ${event.detail}`);
    this.deps.extensions?.onLifecycle?.(event);
    this.deps.store.record({ ...event, type: `connection_${event.type}` });
    switch (event.type) {
      case 'joining':
        this.readyInfo = undefined;
        return;
      case 'ready':
        this.readyInfo = event.info;
        this.deps.out(
          `[chunkbot] ready: version=${event.info.serverVersion} protocol=${event.info.protocolVersion} dimension=${event.info.dimension} ` +
            `position=${event.info.position.x},${event.info.position.y},${event.info.position.z} gameMode=${event.info.gameMode} ` +
            `serverOnlineMode=${event.info.serverOnlineMode} — idle; no goal is active`,
        );
        return;
      case 'death':
        this.deps.out(`[chunkbot] bot died; ${hadGoal ? 'ending active goal ownership' : 'no active goal'}`);
        return;
      case 'respawn':
        this.deps.out(`[chunkbot] respawned in ${event.dimension}; idle (goals never auto-resume)`);
        return;
      case 'dimension_change':
        this.deps.out(`[chunkbot] dimension changed ${event.from} -> ${event.to}; ${hadGoal ? 'ending active goal ownership' : 'no active goal'}`);
        return;
      case 'ended': {
        this.lastEnd = { reason: event.reason, detail: event.detail };
        const wasReady = this.readyInfo !== undefined;
        this.readyInfo = undefined;
        this.deps.out(`[chunkbot] connection ended (${event.reason}): ${event.detail}`);
        if (!this.shutdownPromise) {
          if (event.reason === 'auth_required') {
            this.deps.out('[chunkbot] Microsoft sign-in required: run `npm run chunkbot -- auth login --config <file>`; Chunkbot never signs in automatically.');
          }
          if (this.deps.exitOnConnectionEnd) {
            this.deps.out(`[chunkbot] ${wasReady ? 'disconnected' : 'join did not complete'}; no operator terminal, shutting down.`);
            void this.shutdown('connection_ended', EXIT_CONNECTION_ENDED);
          } else {
            this.deps.out(`[chunkbot] ${wasReady ? 'disconnected' : 'join did not complete'}; idle. Use /reconnect to join again or /quit to exit.`);
          }
        }
        return;
      }
    }
  }

  /** Cleans up the bot connection, goal ownership, and evidence. Idempotent. */
  shutdown(reason: ShutdownReason, exitCode = 0): Promise<number> {
    this.shutdownPromise ??= (async () => {
      this.deps.out(`[chunkbot] shutting down (${reason})…`);
      this.deps.store.record({ type: 'shutdown_started', reason });
      // Cancel joining first (synchronous), then close goal admission and cancel work.
      this.joinAbort?.abort();
      this.deps.extensions?.cancelControl?.('shutdown');
      await this.engine.shutdown();
      await this.connecting;
      await this.deps.game.disconnect(reason === 'signal' ? 'shutdown_signal' : 'operator_stop', `shutdown (${reason})`);
      for (const off of this.unsubscribe.splice(0)) off();
      const finalStatus = this.engine.status();
      await this.deps.store.close({
        shutdownReason: reason,
        connectionState: this.deps.game.state,
        lastConnectionEnd: this.lastEnd,
        lastGoal: finalStatus.goal
          ? { id: finalStatus.goal.id, state: finalStatus.goal.state, terminal: finalStatus.goal.terminal?.reason }
          : null,
        counters: this.counters,
      });
      this.deps.out('[chunkbot] shutdown complete');
      this.closedSignal.resolve(exitCode);
      return exitCode;
    })();
    return this.shutdownPromise;
  }
}
