// Maintained regressions for the coordinator review findings MB-JEV-001/002
// (docs/v1-jev-controller-plan.md). MB-JEV-001 boundary tests live in
// tests/jev-adapter.test.ts ("MB-JEV-001 ..."); this file covers MB-JEV-002
// through the actual GoalEngine operator-task intake and registered catalog.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AdmittedTask, TaskExecutionPort, TaskResult, TaskSpec } from '../src/contracts/index.ts';
import { SkillRegistry } from '../src/execution/registry.ts';
import { allSkills } from '../src/skills/index.ts';
import { makeEngine, tick, until } from './helpers.ts';

const TERMINAL = { surface: 'terminal', principal: 'operator' } as const;
const SPEC: TaskSpec = {
  objective: 'Inspect current inventory',
  decisionInstruction: 'Choose a valid inspection',
  allowedCapabilities: ['inspect_inventory'],
  targetSelectors: [],
  parameters: {},
  completion: { predicate: 'inventory_amount', selector: 'minecraft:stone', atLeast: 1, mode: 'possess' },
};

function controlledTasks() {
  const pending: Array<{ task: AdmittedTask; resolve: (r: TaskResult) => void }> = [];
  const port: TaskExecutionPort = {
    readiness: () => ({ ready: true, detail: 'controlled task fixture' }),
    // Deliberately ignores cancellation so its result can arrive after bounded cleanup.
    run: (task) => new Promise((resolve) => pending.push({ task, resolve })),
  };
  return { port, pending };
}

function result(task: AdmittedTask, status: TaskResult['status'], detail = 'controlled result'): TaskResult {
  return {
    taskId: task.taskId,
    status,
    reason: status === 'completed' ? 'completion_verified' : 'ownership_revoked',
    detail,
    rounds: 1,
    decisions: 1,
    actions: 1,
    localContinuations: 0,
    feedback: { taskId: task.taskId, objective: task.spec.objective, status, reason: 'fixture', detail, unavailable: [], recentOutcomes: [], exhaustedTargets: [], completion: null },
  };
}

describe('MB-JEV-002 late task results never touch replacement state', () => {
  it('an old task resolving after cleanup and replacement is discarded: no lastTask, progress or terminal change on the replacement', async () => {
    const { port, pending } = controlledTasks();
    const h = makeEngine({ tasks: port, capabilities: new SkillRegistry(allSkills()) });
    await h.engine.submitOperatorTask(SPEC, 'complete', TERMINAL);
    await until(() => pending.length === 1);
    await h.engine.submitOperatorTask({ ...SPEC, objective: 'Replacement task' }, 'complete', TERMINAL); // waits the bounded cleanup (200 ms)
    await until(() => pending.length === 2);
    const before = h.engine.status();
    assert.equal(before.goal?.id, 'goal-0002');
    assert.equal(before.task?.taskId, pending[1]!.task.taskId);
    pending[0]!.resolve(result(pending[0]!.task, 'completed', 'OLD task result'));
    await tick(10);
    const after = h.engine.status();
    assert.equal(after.goal?.id, 'goal-0002', 'replacement still owns control');
    assert.equal(after.goal?.state, 'executing');
    assert.equal(after.lastTask, undefined, 'old result not published as the last task');
    assert.equal(after.task?.taskId, pending[1]!.task.taskId, 'replacement task still current');
    assert.doesNotMatch(after.goal?.progress ?? '', /OLD task result/);
    const discarded = h.store.ofType('task_result_discarded');
    assert.equal(discarded.length, 1);
    assert.equal(discarded[0]?.['taskId'], pending[0]!.task.taskId);
    // The replacement's own result is still published normally.
    pending[1]!.resolve(result(pending[1]!.task, 'completed', 'replacement result'));
    await until(() => h.engine.status().goal?.state === 'completed');
    const done = h.engine.status();
    assert.equal(done.lastTask?.taskId, pending[1]!.task.taskId);
    assert.match(done.goal?.progress ?? '', /replacement result/);
    assert.equal(done.goal?.terminal?.reason, 'outcome_verified');
  });

  it('a task result arriving after stop is discarded; ordinary completion of a current task publishes status', async () => {
    const { port, pending } = controlledTasks();
    const h = makeEngine({ tasks: port, capabilities: new SkillRegistry(allSkills()) });
    await h.engine.submitOperatorTask(SPEC, 'complete', TERMINAL);
    await until(() => pending.length === 1);
    await h.engine.stop('owner_stop');
    assert.equal(h.engine.status().goal?.state, 'cancelled');
    pending[0]!.resolve(result(pending[0]!.task, 'completed', 'late after stop'));
    await tick(10);
    assert.equal(h.engine.status().goal?.state, 'cancelled', 'a late completion cannot revive or complete a stopped goal');
    assert.equal(h.engine.status().lastTask, undefined);
    // Ordinary path.
    await h.engine.submitOperatorTask(SPEC, 'complete', TERMINAL);
    await until(() => pending.length === 2);
    pending[1]!.resolve(result(pending[1]!.task, 'completed', 'normal'));
    await until(() => h.engine.status().goal?.state === 'completed');
    assert.equal(h.engine.status().lastTask?.status, 'completed');
  });
});
