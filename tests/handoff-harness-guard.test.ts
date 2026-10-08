import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PROJECT_ROOT } from '../src/app/fixture-layout.ts';
import { verifyDeathContinuation } from '../scripts/handoff-live-check.ts';

const script = join(PROJECT_ROOT, 'scripts/handoff-live-check.ts');
const source = readFileSync(script, 'utf8');
const live = join(PROJECT_ROOT, 'var/live-check');
const dirs = () => existsSync(live) ? readdirSync(live).filter((d) => d.endsWith('-handoff')).sort() : [];
const original = { type: 'goal_admitted', goalId: 'goal-original', epoch: 15, instruction: 'follow me' };
const pending = { intentId: 'intent-discarded' };
const semantic = { outcomeCanonical: 'persistent owner proximity', caps: { plannerTurnsPerGoal: 20 }, deadlineAtMs: 99999, admissionBaseline: { counts: { 'minecraft:bread': 8 } } };
const events = () => [
  { type: 'preparation_discarded', reason: 'lifecycle', intentId: pending.intentId, t: '2026-10-08T00:00:01Z' },
  { type: 'continuation_checkpoint', goalId: original.goalId, state: 'held', counters: { plannerTurns: 2, tasksAdmitted: 1 }, ...semantic },
  { ...original, epoch: 17, t: '2026-10-08T00:00:02Z', continuation: { number: 1, counters: { plannerTurns: 2, tasksAdmitted: 1 } } },
  { type: 'goal_continuation_bound', goalId: original.goalId, epoch: 17, carriedTasks: 0, carriedHandles: 0, ...semantic },
];

describe('handoff harness boundaries and death oracle', () => {
  it('imports without starting a harness and rejects missing/invalid leases before side effects', () => {
    const main = source.slice(source.indexOf('async function main()'));
    assert.ok(main.indexOf("argv.indexOf('--fixture-lease')") < main.indexOf('mkdirSync('));
    assert.ok(main.indexOf('process.exitCode = 2; return') < main.indexOf('password = rconPassword()'));
    const before = dirs();
    for (const args of [[], ['--fixture-lease'], ['--fixture-lease', '../bad']]) {
      const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 60_000 });
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /refusing to run/);
    }
    assert.deepEqual(dirs(), before);
  });

  it('accepts the original logical follow at a fresh epoch after exact draft discard', () => {
    const r = verifyDeathContinuation(events(), original, pending, 'dig a well');
    assert.equal(r.bound.epoch, 17);
  });

  it('rejects draft replay, another goal, refilled counters, changed outcome and task replay', () => {
    for (const change of [
      { intentId: pending.intentId }, { instruction: 'dig a well' }, { goalId: 'goal-other' }, { epoch: 15 },
      { continuation: { number: 1, counters: { plannerTurns: 0, tasksAdmitted: 1 } } },
    ]) {
      const ev = events(); ev[2] = { ...ev[2], ...change } as typeof ev[2];
      assert.throws(() => verifyDeathContinuation(ev, original, pending, 'dig a well'));
    }
    for (const change of [{ outcomeCanonical: 'another outcome' }, { carriedTasks: 1 }, { carriedHandles: 1 }]) {
      const ev = events(); ev[3] = { ...ev[3], ...change } as typeof ev[3];
      assert.throws(() => verifyDeathContinuation(ev, original, pending, 'dig a well'));
    }
  });
});
