// MB-UI-001-C1 (shared planner fix): token usage is never invented. Missing or
// invalid core input/output counts make the whole turn usage unknown (null);
// missing cached/reasoning breakdowns stay null; totals add only known counts
// and report how many turns each value covers. Stream validation is unchanged.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { plannerEnv } from '../src/planner/codex-cli.ts';
import { addTurnUsage, type PlannerUsageTotals } from '../src/planner/codex-planner.ts';
import { isPlannerError } from '../src/planner/errors.ts';
import { parseTurnUsage, runCodexTurn } from '../src/planner/transport.ts';
import { setFaultTurns, writeFaultCodex, type FaultTurn } from '../scripts/lib/fault-codex.ts';

const proposal = { disposition: 'needs_information', interpretation: 'x', queries: [{ kind: 'recipe', key: 'minecraft:stick' }] };
function run(turn: FaultTurn) {
  const dir = mkdtempSync(join(tmpdir(), 'chunkbot-usage-'));
  const command = writeFaultCodex(dir, '/nonexistent/codex');
  setFaultTurns(dir, '/nonexistent/codex', [turn]);
  return runCodexTurn({ command, args: ['exec', '--json', '-'], cwd: tmpdir(), env: plannerEnv(process.env, []), prompt: 'p', timeoutMs: 5_000, signal: new AbortController().signal });
}
const zero = (): PlannerUsageTotals => ({ turns: 0, completedTurns: 0, failedTurns: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, usageKnownTurns: 0, cachedInputKnownTurns: 0, reasoningKnownTurns: 0 });

describe('planner token usage (nullable, never invented)', () => {
  it('parses complete, partial and invalid usage objects', () => {
    assert.deepEqual(parseTurnUsage({ input_tokens: 100, cached_input_tokens: 40, output_tokens: 7, reasoning_output_tokens: 3 }), { inputTokens: 100, cachedInputTokens: 40, outputTokens: 7, reasoningOutputTokens: 3 });
    assert.deepEqual(parseTurnUsage({ input_tokens: 100, output_tokens: 7 }), { inputTokens: 100, cachedInputTokens: null, outputTokens: 7, reasoningOutputTokens: null });
    assert.deepEqual(parseTurnUsage({ input_tokens: 100, output_tokens: 7, cached_input_tokens: -1, reasoning_output_tokens: 1.5 }), { inputTokens: 100, cachedInputTokens: null, outputTokens: 7, reasoningOutputTokens: null });
    for (const bad of [undefined, null, {}, [], { input_tokens: 5 }, { output_tokens: 5 }, { input_tokens: '5', output_tokens: 1 }, { input_tokens: -1, output_tokens: 1 }, { input_tokens: Number.NaN, output_tokens: 1 }]) {
      assert.equal(parseTurnUsage(bad), null, JSON.stringify(bad));
    }
  });

  it('a turn without usage (or with only a subset) is reported as unknown, not zero', async () => {
    assert.equal((await run({ kind: 'proposal', proposal, usage: null })).usage, null);
    assert.equal((await run({ kind: 'proposal', proposal, usage: { output_tokens: 9 } })).usage, null);
    assert.deepEqual((await run({ kind: 'proposal', proposal, usage: { input_tokens: 12, output_tokens: 9 } })).usage, { inputTokens: 12, cachedInputTokens: null, outputTokens: 9, reasoningOutputTokens: null });
  });

  it('missing usage does not relax stream validation: a tool event still rejects the turn', async () => {
    try {
      await run({ kind: 'tool', proposal });
      assert.fail('expected rejection');
    } catch (e) {
      assert.ok(isPlannerError(e));
      assert.equal(e.failure.kind, 'prohibited_event');
    }
  });

  it('totals add only known counts and record per-value coverage', () => {
    const t = zero();
    addTurnUsage(t, { inputTokens: 100, cachedInputTokens: 40, outputTokens: 10, reasoningOutputTokens: 5 });
    addTurnUsage(t, { inputTokens: 50, cachedInputTokens: null, outputTokens: 4, reasoningOutputTokens: null });
    addTurnUsage(t, null);
    assert.deepEqual(t, { ...zero(), inputTokens: 150, cachedInputTokens: 40, outputTokens: 14, reasoningOutputTokens: 5, usageKnownTurns: 2, cachedInputKnownTurns: 1, reasoningKnownTurns: 1 });
  });
});
