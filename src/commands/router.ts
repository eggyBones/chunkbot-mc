// Routes parsed commands from both control surfaces to the same application
// operations. Goals from `!chunkbot <text>`, `!chunkbot goal <text>`, and terminal
// lines all reach GoalEngine.submit — the single intake surface.
import type { IntakeOrigin } from '../contracts/index.ts';
import type { ParsedCommand } from './parse.ts';

export interface CommandTarget {
  submitGoal(instruction: string, origin: IntakeOrigin): Promise<void>;
  stop(origin: IntakeOrigin): Promise<void>;
  status(origin: IntakeOrigin): void;
  answer(reply: string, ref: string | undefined, origin: IntakeOrigin): void;
  invalid(detail: string, origin: IntakeOrigin): void;
  operator(verb: 'quit' | 'reconnect' | 'help'): Promise<void>;
  /** Operator mechanic diagnostics (terminal only). */
  diagnostic?(args: string): Promise<void>;
  /** Operator task controller diagnostic (terminal only). */
  task?(args: string): Promise<void>;
}

export async function routeCommand(command: ParsedCommand, origin: IntakeOrigin, target: CommandTarget): Promise<void> {
  switch (command.kind) {
    case 'goal':
      return target.submitGoal(command.instruction, origin);
    case 'stop':
      return target.stop(origin);
    case 'status':
      return target.status(origin);
    case 'answer':
      return target.answer(command.reply, command.ref, origin);
    case 'invalid':
      return target.invalid(command.detail, origin);
    case 'operator':
      // Operator verbs only exist on the local terminal.
      if (origin.surface !== 'terminal') return target.invalid('operator commands are terminal-only', origin);
      return target.operator(command.verb);
    case 'diagnostic':
      if (origin.surface !== 'terminal') return target.invalid('diagnostics are terminal-only', origin);
      if (!target.diagnostic) return target.invalid('mechanic diagnostics are not installed', origin);
      return target.diagnostic(command.args);
    case 'task':
      if (origin.surface !== 'terminal') return target.invalid('task diagnostics are terminal-only', origin);
      if (!target.task) return target.invalid('the task controller diagnostic is not installed', origin);
      return target.task(command.args);
  }
}
