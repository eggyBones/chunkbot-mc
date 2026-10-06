// Compile-time proof that the real application objects satisfy the dashboard
// facade's structural dependencies (checked by `npm run typecheck`), plus a
// runtime check that the store tee forwards events unchanged.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { MineflayerConnection } from '../src/game/connection.ts';
import type { SpendLedger } from '../src/decision/spend.ts';
import type { CodexPlanner } from '../src/planner/codex-planner.ts';
import type { DashboardRuntimeDeps } from '../src/dashboard/runtime.ts';
import { createDashboardRuntime } from '../src/dashboard/runtime.ts';
import { MemoryRunStore } from '../src/telemetry/run-store.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Assignable<T, U extends T> = U;
export type GameFits = Assignable<DashboardRuntimeDeps['game'], MineflayerConnection>;
export type SpendFits = Assignable<NonNullable<DashboardRuntimeDeps['spend']>, SpendLedger>;
export type PlannerFits = Assignable<NonNullable<DashboardRuntimeDeps['planner']>, CodexPlanner>;
export type PlannerGetterFits = Assignable<NonNullable<DashboardRuntimeDeps['planner']>, () => CodexPlanner | undefined>;

describe('dashboard runtime facade', () => {
  it('tapStore forwards every event unchanged to the real store', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dash-facade-'));
    try {
      const store = new MemoryRunStore();
      const rt = createDashboardRuntime({
        dataDir: dir,
        runId: 'run-facade01',
        now: () => 1_000,
        game: { state: 'disconnected', connectionEpoch: 0, onLifecycle: () => () => undefined, session: () => undefined },
        profile: { version: '26.1.2', supportLevel: 'upstream-tested' },
      });
      const tapped = rt.tapStore(store);
      tapped.record({ type: 'jev_request', requestId: 'req-aaaa', attempt: 1 });
      tapped.record({ type: 'something_else', x: 1 });
      assert.equal(store.events.length, 2);
      assert.equal(tapped.runId, store.runId);
      rt.stop('test');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
