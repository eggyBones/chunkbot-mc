// Dedicated bounded read-only truth journal. No snapshot/handle/planner/actuator API.
import type { ServerVisibilityRead } from './locator-ordinary-oracles.ts';

// Forty minutes of minimum pacing covers the unchanged fourteen-case budgets; no case timeout is extended.
export const VISIBILITY_CAPTURE = { pollMs: 50, maxReads: 48000 } as const;
export function startVisibilityCapture(io: { read(): Promise<ServerVisibilityRead>; wait(ms: number): Promise<void>; record(row: ServerVisibilityRead | { error: string; fromMs: number; toMs: number }): void }) {
  const reads: ServerVisibilityRead[] = [];
  let stopped = false, attempts = 0, settled = false, capped = false, failure: string | null = null;
  const tail = (async () => {
    try {
      while (!stopped) {
        if (attempts >= VISIBILITY_CAPTURE.maxReads) { capped = true; break; }
        attempts++;
        const fromMs = Date.now();
        try { const row = await io.read(); reads.push(row); io.record(row); }
        catch (error) { io.record({ error: error instanceof Error ? error.message : String(error), fromMs, toMs: Date.now() }); }
        if (!stopped) await io.wait(VISIBILITY_CAPTURE.pollMs);
      }
    } catch (error) { failure = error instanceof Error ? error.message : String(error); }
    finally { settled = true; }
  })();
  return { reads, status: () => ({ attempts, settled, capped, failure, retainedReads: reads.length }), stop: async () => { stopped = true; await tail; } };
}
