// N1-H5: current scoped lifecycle/control oracles and lease guard. Only missing
// or invalid lease children run; importing the harness performs no operation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { PROJECT_ROOT } from '../src/app/fixture-layout.ts';
import { IDLE_RESPAWN_NOTICE, RETIRED_REPLY_NOTICE, verifyIdleRespawn, verifyNoQuestionOrReplay, verifyStaleReply } from '../scripts/live-check.ts';

const script = join(PROJECT_ROOT, 'scripts/live-check.ts');
const source = readFileSync(script, 'utf8');
const reply = '[chunkbot] Reply not applied: no question is pending: Chunkbot does not ask follow-up questions, so this reply was not applied and nothing changed. Send a new instruction to change what Chunkbot is doing.';
const status = '[status] goal: goal-abcd blocked "Original job" — planner_not_ready; planner turns 0, tasks 0';
const retired = { type: 'answer_retired', surface: 'chat', ref: 'q1', activeGoalId: null, pendingIntentId: null };
const lifecycle = [{ type: 'connection_death' }, { type: 'connection_respawn' }, { type: 'connection_dimension_change' }];
const lifecycleLines = ['[chunkbot] bot died; no active goal', '[chunkbot] respawned in overworld; idle (nothing to continue)', status];

describe('foundation lifecycle harness scoped current oracles', () => {
  it('accepts the exact current declarative reply and positively recorded retirement with unchanged status', () => {
    assert.equal(RETIRED_REPLY_NOTICE.test(reply), true);
    assert.equal(RETIRED_REPLY_NOTICE.test('[chunkbot] Answer not applied: there is no pending question'), false);
    assert.equal(RETIRED_REPLY_NOTICE.test(reply + ' extra unknown behavior'), false);
    verifyStaleReply(status, status, [reply, status], [retired], { surface: 'chat', ref: 'q1' });
    verifyStaleReply(status, status, [reply, status], [{ ...retired, surface: 'terminal', ref: null }], { surface: 'terminal', ref: null });
    for (const events of [[], [retired, retired], [{ ...retired, activeGoalId: 'goal-new' }], [{ ...retired, pendingIntentId: 'intent-new' }], [{ ...retired, ref: 'q2' }], [retired, { type: 'task_admitted' }]]) {
      assert.throws(() => verifyStaleReply(status, status, [reply], events, { surface: 'chat', ref: 'q1' }));
    }
    assert.throws(() => verifyStaleReply(status, status + ' changed counters', [reply], [retired], { surface: 'chat', ref: 'q1' }));
    assert.throws(() => verifyStaleReply(status, status, ['unknown reply'], [retired], { surface: 'chat', ref: 'q1' }));
  });

  it('idle respawn needs death/respawn evidence and no checkpoint/task/goal replay, rather than a universal no-resume claim', () => {
    assert.equal(IDLE_RESPAWN_NOTICE.test(lifecycleLines[1]!), true);
    assert.equal(IDLE_RESPAWN_NOTICE.test('[chunkbot] respawned in overworld; idle (goals never auto-resume)'), false);
    verifyIdleRespawn(status, status, lifecycleLines, [{ type: 'goal_admitted', goalId: 'goal-original' }, { type: 'goal_terminal' }], lifecycle);
    assert.throws(() => verifyIdleRespawn(status, status, lifecycleLines, [{ type: 'continuation_checkpoint', state: 'held' }], lifecycle));
    assert.throws(() => verifyIdleRespawn(status, status, lifecycleLines, [], lifecycle.filter((e) => e.type !== 'connection_respawn')));
    assert.throws(() => verifyIdleRespawn(status, status, [lifecycleLines[0]!, status], [], lifecycle));
    assert.throws(() => verifyIdleRespawn(status, status + ' changed', lifecycleLines, [], lifecycle));
    for (const type of ['goal_admitted', 'task_admitted', 'task_action', 'planner_request', 'goal_continuation_bound', 'continuation_checkpoint', 'continuation_readiness']) {
      assert.throws(() => verifyIdleRespawn(status, status, lifecycleLines, [], [...lifecycle, { type }]));
    }
    for (const line of ['[chunkbot] Question q1: Which target?', '[status] goal: goal-abcd awaiting_owner', '[status] task: task-old', '[status] owner job goal-abcd: held', '[status] pending instruction: intent-old']) {
      assert.throws(() => verifyNoQuestionOrReplay([line], []));
    }
  });

  it('imports safely and refuses missing/invalid leases before creating reports or reading fixture secrets', () => {
    const dir = join(PROJECT_ROOT, 'var/live-check');
    const list = () => existsSync(dir) ? readdirSync(dir).sort() : [];
    const before = list();
    for (const args of [[], ['--fixture-lease'], ['--fixture-lease', '../invalid']]) {
      const child = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 30_000 });
      assert.equal(child.status, 2, child.stderr);
      assert.match(child.stderr, /refusing to run: pass --fixture-lease/);
    }
    assert.deepEqual(list(), before);
    assert.ok(!source.includes('goals never auto-resume'));
    assert.ok(!source.includes('Answer not applied: there is no pending question'));
    assert.ok(source.indexOf('mkdirSync(outDir') > source.indexOf('async function main()'));
    assert.ok(source.indexOf("process.argv.indexOf('--fixture-lease')") < source.lastIndexOf('main().catch'));
    assert.match(source, /dataDir: join\(outDir, 'data'\)/);
    assert.match(source, /verifyStaleReply\(before, after/);
    assert.match(source, /verifyIdleRespawn\(before, after/);
  });
});
