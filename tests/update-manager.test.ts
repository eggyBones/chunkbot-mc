import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, it } from 'node:test';
import {
  acquireManagerLease, attachManagedChild, createNativeReleaseManager, ManagerFault, nativeProcessInspector, NativeChildDriver, ReleaseManager,
  type AcceptedRelease, type ArtifactPort, type CheckpointPort, type CheckpointRef,
  type ChildDriver, type ChildRegistration, type DrainEvidence, type GoneEvidence,
  type ManagedChildServices, type ManagedReply, type ManagedRequest, type ManagerIntent, type ManagerOptions, type OperationFence, type ReadinessEvidence,
} from '../src/updates/manager/index.ts';

const PROFILE = { worldProfile: 'credential-free-test-world', botProfile: 'dummy-bot', ownerProfile: 'dummy-owner', serverVersion: '26.2', protocol: 776 };
const CHECKPOINT: CheckpointRef = { id: 'durable-budget-original', sessionId: 'test-session', schema: 1 };
const RELEASES: Record<string, AcceptedRelease> = Object.fromEntries(['A', 'B', 'C'].map((id, index) => [id, {
  id, digest: String(index + 1).repeat(64), summary: `${id} verified feature`, profile: { ...PROFILE },
  checkpointSchema: 1, artifactRoot: '/fake-accepted-artifact', entrypoint: '/fake-accepted-artifact/cli.js',
}]));
const deadlines = { validationMs: 300, intentMs: 300, drainMs: 300, checkpointMs: 300,
  cleanupMs: 300, readinessMs: 300, commitMs: 300, noticeMs: 100, freshnessMs: 1_000 };
function deferred<T>() { return Promise.withResolvers<T>(); }
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('test condition deadline');
    await sleep(5);
  }
}

function fixture(overrides: Partial<ManagerOptions> = {}) {
  const events: string[] = [];
  const children = new Map<string, ChildRegistration>();
  let sequence = 0;
  let maxLive = 0;
  let active = 'A';
  let persisted: ManagerIntent = { sessionId: CHECKPOINT.sessionId, generation: 0, paused: false, online: false };
  let hook: (event: string, signal: AbortSignal) => Promise<void> = async () => undefined;
  const readyChanges = new Map<string, Partial<ReadinessEvidence>>();
  const failures = new Map<string, ManagerFault>();
  const intentByChild = new Map<string, ManagerIntent>();
  const lossListeners = new Set<(child: ChildRegistration, reason: import('../src/updates/manager/ports.ts').FailureCode) => void>();
  const step = async (event: string, signal: AbortSignal) => {
    events.push(event);
    await hook(event, signal);
    const fault = failures.get(event);
    if (fault) throw fault;
  };
  const artifacts: ArtifactPort = {
    async validate(id, signal) {
      await step(`validate:${id}`, signal);
      const release = RELEASES[id];
      if (!release) throw new ManagerFault('artifact_invalid', 'no accepted receipt');
      return structuredClone(release);
    },
    async commitActive(release, fence, signal) {
      await step(`commit:${release.id}`, signal);
      if (signal.aborted || fence.commandGeneration !== persisted.generation || !persisted.online) throw new ManagerFault('superseded', 'durable intent won atomic CAS');
      active = release.id;
    },
  };
  const checkpoints: CheckpointPort = {
    async persistIntent(intent, signal) {
      await step(`intent:${intent.generation}`, signal);
      if (intent.generation <= persisted.generation) throw new ManagerFault('intent_failed', 'non-monotonic intent');
      persisted = { ...intent };
    },
    async capture(_child, drain, signal) {
      await step('capture', signal);
      // Budget reservations/counters are opaque and retained, never re-created by the manager.
      return structuredClone(drain.checkpoint);
    },
  };
  const driver: ChildDriver = {
    onLoss(listener) { lossListeners.add(listener); return () => lossListeners.delete(listener); },
    launch(release, checkpoint, intent, fence) {
      assert.equal(children.size, 0, 'never launch before root/descendant/socket cleanup');
      assert.deepEqual(checkpoint, CHECKPOINT, 'same session accounting reference on B and rollback');
      const child = { id: `child-${++sequence}`, pid: sequence + 10_000, releaseId: release.id, digest: release.digest, fence: { ...fence } };
      children.set(child.id, child); intentByChild.set(child.id, { ...intent });
      events.push(`launch:${release.id}`); maxLive = Math.max(maxLive, children.size);
      return child;
    },
    async drain(child, fence, signal) {
      await step(`drain:${child.releaseId}`, signal);
      return { childId: child.id, fence, admissionClosed: true, preparationsSettled: true, providersSettled: true,
        actuatorsReleased: true, interfacesSettled: true, socketClosed: true, socketClosedAtMs: Date.now(), checkpoint: { ...CHECKPOINT } };
    },
    async terminate(child, signal) {
      await step(`terminate:${child.releaseId}`, signal);
      children.delete(child.id);
      return gone(child);
    },
    async proveGone(child, signal) { await step(`gone:${child.releaseId}`, signal); return gone(child); },
    async readiness(child, fence, signal) {
      await step(`ready:${child.releaseId}`, signal);
      return { childId: child.id, fence, releaseId: child.releaseId, digest: child.digest, profile: { ...PROFILE }, checkpointId: CHECKPOINT.id,
        connectionEpoch: sequence, spawnValid: true, spawnedAtMs: Date.now(), dimension: 'overworld', observedAtMs: Date.now(),
        inventoryServerConfirmed: true, observationServerConfirmed: true, capabilitiesRegistered: true, authReady: true,
        providersReady: true, paused: intentByChild.get(child.id)!.paused, admissionClosed: true, ...readyChanges.get(child.releaseId) };
    },
    async activate(child, intent, _fence, signal) { await step(`activate:${child.releaseId}:${intent.paused}`, signal); },
    async pause(child, intent, signal) { await step(`pause:${child.releaseId}:${intent.paused}`, signal); },
    async announce(child, _fence, text, signal) { await step(`notice:${child.releaseId}:${text}`, signal); return 'sent'; },
  };
  const options: ManagerOptions = { artifacts, checkpoints, children: driver, lease: { assertHeld() {} }, profile: PROFILE,
    activeReleaseId: 'A', checkpoint: CHECKPOINT, intent: persisted, deadlines, ...overrides };
  const manager = new ReleaseManager(options);
  return { manager, driver, artifacts, checkpoints, options, events, children, readyChanges, failures,
    lose(reason: import('../src/updates/manager/ports.ts').FailureCode) { for (const listener of lossListeners) listener(manager.status().child!, reason); },
    hook(value: typeof hook) { hook = value; }, get maxLive() { return maxLive; }, get active() { return active; }, get persisted() { return persisted; } };
}
function gone(child: ChildRegistration): GoneEvidence {
  return { childId: child.id, rootGone: true, descendantsGone: true, inspectionSucceeded: true, socketClosed: true };
}

describe('bounded release manager, offline/fault integration', () => {
  it('offline promotion stages only; explicit on verifies/commits once; duplicate promotion cannot reconnect/announce', async () => {
    const f = fixture();
    assert.equal((await f.manager.promote('B')).phase, 'staged');
    assert.equal(f.children.size, 0);
    const online = await f.manager.on(1);
    assert.equal(online.phase, 'ready'); assert.equal(f.active, 'B');
    const before = [...f.events];
    await f.manager.promote('B');
    assert.deepEqual(f.events, before);
    assert.equal(f.events.some((event) => event.startsWith('notice:')), false);
    assert.equal((await f.manager.off(2)).phase, 'offline');
  });

  it('drains/checkpoints A, proves closure, verifies B, commits and activates before exactly one truthful notice', async () => {
    const f = fixture(); await f.manager.on(1);
    const status = await f.manager.promote('B');
    assert.equal(status.phase, 'ready'); assert.equal(status.activeReleaseId, 'B');
    assert.equal(status.notice, 'sent'); assert.equal(f.maxLive, 1);
    assert.ok(status.downtimeMs !== null && status.downtimeMs >= 0);
    const order = ['drain:A', 'capture', 'terminate:A', 'gone:A', 'launch:B', 'ready:B', 'commit:B', 'activate:B:false', 'notice:B:Updated: B verified feature'];
    let previous = -1;
    for (const event of order) { const index = f.events.indexOf(event); assert.ok(index > previous, event); previous = index; }
    await f.manager.off(2);
  });

  it('reported downtime includes the socket-closed checkpoint/cleanup interval before the next valid spawn', async () => {
    const f = fixture(); await f.manager.on(1);
    let closedAt = 0;
    const drain = f.driver.drain;
    f.driver.drain = async (...args) => { const proof = await drain(...args); closedAt = proof.socketClosedAtMs; await sleep(40); return proof; };
    f.hook(async (event) => { if (event === 'capture') await sleep(40); });
    const result = await f.manager.promote('B');
    assert.ok(result.downtimeMs !== null && result.downtimeMs >= 75, `socket-to-spawn interval ${result.downtimeMs}`);
    assert.ok(closedAt > 0); await f.manager.off(2);
  });

  it('failed/tampered/incompatible validation leaves the current child untouched', async () => {
    for (const code of ['artifact_invalid', 'incompatible'] as const) {
      const f = fixture(); await f.manager.on(1);
      f.failures.set('validate:B', new ManagerFault(code, 'validator rejected candidate'));
      const before = f.events.filter((event) => /launch|drain|terminate/.test(event));
      assert.equal((await f.manager.promote('B')).failure, code);
      assert.deepEqual(f.events.filter((event) => /launch|drain|terminate/.test(event)), before);
      assert.equal(f.children.size, 1); await f.manager.off(2);
    }
  });

  it('stop stays paused across accepted B and rollback, without a fresh budget or action replay', async () => {
    const f = fixture(); await f.manager.on(1); await f.manager.stop(2);
    assert.equal((await f.manager.promote('B')).intent.paused, true);
    assert.ok(f.events.includes('activate:B:true'));
    f.readyChanges.set('C', { spawnValid: false });
    const rollback = await f.manager.promote('C');
    assert.equal(rollback.phase, 'rollback'); assert.equal(rollback.activeReleaseId, 'B');
    assert.equal(rollback.intent.paused, true); assert.equal(f.maxLive, 1);
    assert.equal(f.events.filter((event) => event === 'launch:C').length, 1);
    assert.equal(f.events.filter((event) => event === 'launch:B').length, 2);
    assert.ok(!f.events.some((event) => event.startsWith('notice:C')));
    await f.manager.off(3);
  });

  for (const boundary of ['validate:B', 'drain:A', 'capture', 'gone:A', 'ready:B', 'commit:B']) {
    for (const control of ['off', 'stop'] as const) {
      it(`${control} wins during ${boundary}; no late commit, notice or rollback reconnect`, async () => {
        const f = fixture(); await f.manager.on(1);
        const entered = deferred<void>(); const release = deferred<void>();
        let used = false;
        f.hook(async (event) => { if (event === boundary && !used) { used = true; entered.resolve(); await release.promise; } });
        const promotion = f.manager.promote('B'); await entered.promise;
        const command = f.manager[control](2); release.resolve();
        await promotion; const status = await command;
        assert.equal(status.intent.paused, control === 'stop');
        assert.equal(status.intent.online, control === 'stop');
        assert.equal(f.active, 'A');
        assert.equal(f.events.some((event) => event.startsWith('notice:')), false);
        assert.equal(f.events.filter((event) => event === 'launch:A').length, 1, 'no stale rollback');
        if (control === 'off') { assert.equal(status.phase, 'offline'); assert.equal(f.children.size, 0); }
        else await f.manager.off(3);
      });
    }
  }

  it('readiness failure tears B down then restores A once; a second failure stays stopped', async () => {
    const f = fixture(); await f.manager.on(1);
    f.readyChanges.set('B', { inventoryServerConfirmed: false });
    f.readyChanges.set('A', { observationServerConfirmed: false });
    const status = await f.manager.promote('B');
    assert.equal(status.phase, 'blocked'); assert.equal(f.children.size, 0);
    assert.deepEqual(f.events.filter((event) => event.startsWith('launch:')), ['launch:A', 'launch:B', 'launch:A']);
    assert.equal(f.events.some((event) => event.startsWith('notice:')), false);
    await sleep(30); assert.equal(f.children.size, 0, 'no restart timer');
  });

  it('external auth/server/identity/protocol failures never use code rollback as a reconnect loop', async () => {
    for (const code of ['auth_required', 'whitelist_denied', 'server_unavailable', 'identity_conflict', 'protocol_mismatch'] as const) {
      const f = fixture(); await f.manager.on(1);
      f.failures.set('ready:B', new ManagerFault(code, 'external failure'));
      const status = await f.manager.promote('B');
      assert.equal(status.failure, code); assert.equal(f.children.size, 0);
      assert.deepEqual(f.events.filter((event) => event.startsWith('launch:')), ['launch:A', 'launch:B']);
    }
  });

  it('natural child/connection loss revokes ready status and never restarts; stale registration stays until proved cleanup', async () => {
    const f = fixture(); await f.manager.on(1);
    f.lose('server_unavailable');
    assert.equal(f.manager.status().phase, 'blocked'); assert.equal(f.manager.status().failure, 'server_unavailable');
    assert.ok(f.manager.status().child, 'loss event alone is not disconnect/process proof');
    await sleep(20);
    assert.equal(f.events.filter((event) => event.startsWith('launch:')).length, 1);
    await f.manager.off(2); assert.equal(f.manager.status().phase, 'offline');
  });

  it('connection loss during candidate verification blocks rollback/reconnect for an unrelated server failure', async () => {
    const f = fixture(); await f.manager.on(1);
    const entered = deferred<void>(); const released = deferred<void>();
    f.hook(async (event) => { if (event === 'ready:B') { entered.resolve(); await released.promise; } });
    const update = f.manager.promote('B'); await entered.promise;
    f.lose('server_unavailable'); released.resolve();
    const result = await update;
    assert.equal(result.failure, 'server_unavailable'); assert.equal(f.children.size, 0);
    assert.deepEqual(f.events.filter((event) => event.startsWith('launch:')), ['launch:A', 'launch:B']);
    assert.equal(f.events.some((event) => event.startsWith('notice:')), false);
  });

  it('unproven cleanup holds the registration and prohibits a second child', async () => {
    const f = fixture(); await f.manager.on(1);
    f.driver.proveGone = async (child) => ({ ...gone(child), descendantsGone: false });
    assert.equal((await f.manager.promote('B')).failure, 'cleanup_unproven');
    assert.equal(f.events.includes('launch:B'), false);
    assert.ok(f.manager.status().child, 'unproved registration retained');
    await f.manager.on(2); assert.equal(f.events.includes('launch:B'), false);
  });

  it('checkpoint failure fully tears down but never launches with a fresh allowance', async () => {
    const f = fixture(); await f.manager.on(1);
    f.failures.set('capture', new ManagerFault('checkpoint_failed', 'accounting corrupt'));
    assert.equal((await f.manager.promote('B')).failure, 'checkpoint_failed');
    assert.equal(f.children.size, 0); assert.equal(f.events.includes('launch:B'), false);
    f.failures.delete('capture'); await f.manager.on(2);
    assert.equal(f.events.includes('launch:B'), false, 'corrupt accounting cannot acquire a fresh allowance through explicit on');
  });

  it('repeated on during joining is idempotent and consumes stale delivery order without aborting startup', async () => {
    const f = fixture(); const entered = deferred<void>(); const release = deferred<void>();
    f.hook(async (event) => { if (event === 'ready:A') { entered.resolve(); await release.promise; } });
    const first = f.manager.on(1); await entered.promise;
    await f.manager.on(5); await f.manager.off(4); release.resolve();
    assert.equal((await first).phase, 'ready');
    assert.equal(f.events.filter((event) => event === 'launch:A').length, 1);
    await f.manager.off(6); assert.equal(f.children.size, 0);
  });

  it('explicit on during offline staging waits for cancelled preparation and starts once; a newer off still wins', async () => {
    for (const cancel of [false, true]) {
      const f = fixture(); const entered = deferred<void>(); const release = deferred<void>();
      f.hook(async (event) => { if (event === 'validate:B') { entered.resolve(); await release.promise; } });
      const stage = f.manager.promote('B'); await entered.promise;
      const start = f.manager.on(1);
      const stop = cancel ? f.manager.off(2) : Promise.resolve();
      release.resolve(); await stage; await start; await stop;
      assert.equal(f.children.size, cancel ? 0 : 1);
      assert.equal(f.events.filter((event) => event.startsWith('launch:')).length, cancel ? 0 : 1);
      if (!cancel) await f.manager.off(2);
    }
  });

  it('a fresh on request that expires during artifact validation never joins after the delay', async () => {
    const f = fixture(); const entered = deferred<void>(); const release = deferred<void>();
    f.hook(async (event) => { if (event === 'validate:A') { entered.resolve(); await release.promise; } });
    const now = Date.now();
    const start = f.manager.control({ action: 'on', profile: PROFILE, sessionId: CHECKPOINT.sessionId,
      controlSessionId: f.manager.status().controlSessionId, generation: 1, issuedAtMs: now - 1, expiresAtMs: now + 20 });
    await entered.promise; await sleep(30); release.resolve();
    assert.equal((await start).failure, 'request_invalid'); assert.equal(f.children.size, 0);
  });

  it('durable intent failure and unresolved intent writes cannot launch or reset accounting', async () => {
    const f = fixture(); f.failures.set('intent:1', new ManagerFault('intent_failed', 'store unavailable'));
    assert.equal((await f.manager.on(1)).failure, 'intent_failed');
    f.failures.clear(); await f.manager.on(2);
    assert.equal(f.children.size, 0);
  });

  it('logout retains the same durable budget checkpoint for the next explicit start; resume alone never joins', async () => {
    const f = fixture(); await f.manager.on(1); await f.manager.off(2);
    assert.ok(f.events.includes('capture'));
    await f.manager.resume(3); assert.equal(f.children.size, 0);
    await f.manager.on(4); assert.equal(f.children.size, 1);
    assert.equal(f.events.filter((event) => event.startsWith('launch')).length, 2);
    await f.manager.off(5);
  });

  it('trusted control seam rejects expired, future, overlong, wrong-profile and wrong-session requests without joining', async () => {
    const f = fixture(); const now = Date.now();
    const request = { action: 'on', profile: PROFILE, sessionId: CHECKPOINT.sessionId, controlSessionId: f.manager.status().controlSessionId,
      generation: 1, issuedAtMs: now - 1, expiresAtMs: now + 10_000 } as const;
    for (const invalid of [ { ...request, expiresAtMs: now - 1 }, { ...request, issuedAtMs: now + 60_000 },
      { ...request, expiresAtMs: now + 60_000 }, { ...request, sessionId: 'foreign' }, { ...request, controlSessionId: 'previous-manager' },
      { ...request, profile: { ...PROFILE, worldProfile: 'foreign' } } ]) {
      assert.equal((await f.manager.control(invalid)).failure, 'request_invalid');
    }
    assert.equal(f.children.size, 0); assert.equal((await f.manager.control(request)).phase, 'ready');
    await f.manager.off(2);
  });

  it('timeout keeps the real unresolved settlement tail as a launch barrier', async () => {
    const f = fixture({ deadlines: { ...deadlines, readinessMs: 30 } }); await f.manager.on(1);
    const late = deferred<void>();
    f.hook(async (event) => { if (event === 'ready:B') await late.promise; });
    const result = await f.manager.promote('B');
    assert.equal(result.failure, 'ownership_unproven');
    assert.deepEqual(f.events.filter((event) => event.startsWith('launch:')), ['launch:A', 'launch:B']);
    assert.equal((await f.manager.promote('C')).failure, 'busy');
    late.resolve(); await sleep(10);
    assert.equal(f.events.some((event) => event.startsWith('notice:')), false);
  });

  it('stale/future/wrong readiness evidence cannot commit or announce the candidate', async () => {
    const mutations: Partial<ReadinessEvidence>[] = [
      { digest: '0'.repeat(64) }, { childId: 'foreign' }, { checkpointId: 'fresh-budget' },
      { observedAtMs: Date.now() - 60_000 }, { observedAtMs: Date.now() + 60_000 },
      { spawnedAtMs: Date.now() - 60_000 },
      { connectionEpoch: 0 },
      { admissionClosed: false }, { capabilitiesRegistered: false }, { providersReady: false },
      { fence: { sessionId: CHECKPOINT.sessionId, commandGeneration: 99, deploymentGeneration: 99 } },
    ];
    for (const change of mutations) {
      const f = fixture(); await f.manager.on(1); f.readyChanges.set('B', change);
      const status = await f.manager.promote('B');
      assert.equal(status.phase, 'rollback'); assert.equal(f.active, 'A');
      assert.equal(f.events.includes('commit:B'), false);
      assert.equal(f.events.some((event) => event.startsWith('notice:B')), false);
      await f.manager.off(2);
    }
  });

  it('notice failure preserves verified active status and never retries or repeats', async () => {
    const f = fixture(); await f.manager.on(1);
    f.failures.set('notice:B:Updated: B verified feature', new ManagerFault('timeout', 'chat absent'));
    const status = await f.manager.promote('B');
    assert.equal(status.activeReleaseId, 'B'); assert.equal(status.phase, 'ready'); assert.equal(status.notice, 'unavailable');
    await f.manager.promote('B');
    assert.equal(f.events.filter((event) => event.startsWith('notice:B')).length, 1);
    await f.manager.off(2);
  });

  it('readiness auth/profile/protocol flags classify external failures and never restore code to repair them', async () => {
    for (const [change, code] of [
      [{ authReady: false }, 'auth_required'], [{ profile: { ...PROFILE, botProfile: 'foreign-bot' } }, 'identity_conflict'],
      [{ profile: { ...PROFILE, protocol: 775 } }, 'protocol_mismatch'],
    ] as const) {
      const f = fixture(); await f.manager.on(1); f.readyChanges.set('B', change);
      const result = await f.manager.promote('B');
      assert.equal(result.failure, code); assert.equal(f.children.size, 0);
      assert.deepEqual(f.events.filter((event) => event.startsWith('launch:')), ['launch:A', 'launch:B']);
    }
  });

  it('new manager boot ignores saved online intent; stale control generations cannot clear pause or join', async () => {
    const f = fixture({ intent: { sessionId: CHECKPOINT.sessionId, generation: 7, paused: true, online: true } });
    assert.equal(f.manager.status().intent.online, false);
    await f.manager.on(7); await f.manager.resume(6);
    assert.equal(f.children.size, 0); assert.equal(f.manager.status().intent.paused, true);
  });
});

const fakeChildSource = `
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { attachManagedChild } from ${JSON.stringify(pathToFileURL(resolve('src/updates/manager/child-endpoint.ts')).href)};
let initial;
const record = operation => appendFileSync(process.env.FAKE_JOURNAL, JSON.stringify({operation,pid:process.pid})+'\\n');
attachManagedChild({
  async initialize(context) {
    initial=context; record('initialize');
    if (process.env.FAKE_LEAK === '1') {
      const leak=spawn('/bin/sleep',['30'],{detached:true,stdio:'ignore'});
      appendFileSync(process.env.FAKE_JOURNAL,JSON.stringify({operation:'descendant',pid:leak.pid})+'\\n');
      await new Promise(r=>setTimeout(r,250));
    }
  },
  async readiness() {
    record('readiness'); await new Promise(r=>setTimeout(r,30));
    const r=initial.release,c=initial.checkpoint,i=initial.intent;
    return {releaseId:r.id,digest:r.digest,profile:r.profile,checkpointId:c.id,connectionEpoch:1,spawnValid:true,spawnedAtMs:Date.now(),dimension:'fake-overworld',observedAtMs:Date.now(),inventoryServerConfirmed:true,observationServerConfirmed:true,capabilitiesRegistered:true,authReady:true,providersReady:true,paused:i.paused,admissionClosed:true};
  },
  async drain() { record('drain'); return {admissionClosed:true,preparationsSettled:true,providersSettled:true,actuatorsReleased:true,interfacesSettled:true,socketClosed:true,socketClosedAtMs:Date.now(),checkpoint:initial.checkpoint}; },
  async activate() { record('activate'); },
  async pause() { record('pause'); },
  async announce() { record('announce'); return 'sent'; },
}, {
  on:(event,handler)=>process.on(event,handler), off:(event,handler)=>process.off(event,handler),
  send:reply=> {
    if (reply.value?.digest) process.send({...reply,fence:{...reply.fence,commandGeneration:999},value:{...reply.value,digest:'0'.repeat(64)}});
    process.send(reply);
  },
});
`;

describe('native registered fake children (no Minecraft or inference)', () => {
  it('owned entry point drives real fake children A/B, fences stale IPC, proves teardown, and leaves an unrelated sentinel alive', async () => {
    const directory = mkdtempSync(resolve('var/manager-native-'));
    const childFile = join(directory, 'fake-child.mjs');
    const journal = join(directory, 'journal.jsonl');
    writeFileSync(childFile, fakeChildSource); writeFileSync(journal, '');
    const lease = acquireManagerLease(join(directory, 'profile-lease'));
    const sentinel = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
    const f = fixture();
    const native = createNativeReleaseManager({ ...f.options, lease,
      artifacts: { ...f.artifacts, async validate(id, signal) { return { ...await f.artifacts.validate(id, signal), artifactRoot: directory, entrypoint: childFile }; } },
      deadlines: { ...deadlines, readinessMs: 3_000, cleanupMs: 3_000, drainMs: 1_000 },
      nativeChild: { nodeExecutable: process.execPath, configPath: join(directory, 'dummy-config.json'), env: { PATH: '/bin:/usr/bin', FAKE_JOURNAL: journal }, termGraceMs: 100 },
    });
    try {
      assert.equal((await native.on(1)).phase, 'ready');
      const a = native.status().child!;
      const update = await native.promote('B');
      assert.equal(update.phase, 'ready'); assert.equal(update.activeReleaseId, 'B'); assert.equal(update.notice, 'sent');
      assert.throws(() => process.kill(a.pid, 0), 'A really exited');
      assert.equal((await native.off(2)).phase, 'offline');
      assert.doesNotThrow(() => process.kill(sentinel.pid!, 0), 'unrelated process survived');
      const rows = readFileSync(journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { operation: string; pid: number });
      assert.equal(rows.filter((row) => row.operation === 'initialize').length, 2);
      assert.equal(rows.filter((row) => row.operation === 'announce').length, 1);
      assert.ok(rows.findIndex((row) => row.operation === 'readiness') < rows.findIndex((row) => row.operation === 'activate'));
    } finally {
      await native.off(3); sentinel.kill('SIGKILL');
      if (!native.status().child) lease.release();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('exclusive profile lease rejects a second manager and never reclaims stale/foreign ownership automatically', () => {
    const directory = mkdtempSync(resolve('var/manager-lease-'));
    const path = join(directory, 'lease'); const lease = acquireManagerLease(path);
    try {
      assert.throws(() => acquireManagerLease(path), /already exists/);
      writeFileSync(join(path, 'owner.json'), JSON.stringify({ token: 'foreign', pid: process.pid }));
      assert.throws(() => lease.assertHeld(), /ownership lost/);
      assert.throws(() => lease.release(), /ownership lost/);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('never signals or adopts an unregistered process identity', async () => {
    const driver = new NativeChildDriver({ nodeExecutable: process.execPath, configPath: '/dummy-config', env: {} });
    const foreign: ChildRegistration = { id: 'foreign', pid: process.pid, releaseId: 'A', digest: '1'.repeat(64), fence: { sessionId: 'foreign', commandGeneration: 1, deploymentGeneration: 1 } };
    assert.throws(() => driver.terminate(foreign, new AbortController().signal), /not this driver/);
  });

  it('retains and terminates a fake child’s descendant after it leaves the process group; inspection failure never proves absence', async () => {
    const directory = mkdtempSync(resolve('var/manager-descendant-'));
    const childFile = join(directory, 'fake-child.mjs'); const journal = join(directory, 'journal.jsonl');
    writeFileSync(childFile, fakeChildSource); writeFileSync(journal, '');
    let unavailable = false;
    const driver = new NativeChildDriver({ nodeExecutable: process.execPath, configPath: join(directory, 'dummy.json'),
      env: { PATH: '/bin:/usr/bin', FAKE_JOURNAL: journal, FAKE_LEAK: '1' }, observeMs: 30, termGraceMs: 100,
      inspector: { list() { if (unavailable) throw new Error('ps unavailable'); return nativeProcessInspector.list(); } } });
    const fence = { sessionId: CHECKPOINT.sessionId, deploymentGeneration: 1, commandGeneration: 1 };
    const child = driver.launch({ ...RELEASES['A']!, artifactRoot: directory, entrypoint: childFile }, CHECKPOINT,
      { sessionId: CHECKPOINT.sessionId, generation: 1, online: true, paused: false }, fence);
    let descendant = 0;
    try {
      await driver.readiness(child, fence, new AbortController().signal);
      descendant = (readFileSync(journal, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { operation: string; pid: number }).find((row) => row.operation === 'descendant'))!.pid;
      process.kill(descendant, 0);
      unavailable = true;
      const unproven = await driver.proveGone(child, new AbortController().signal);
      assert.equal(unproven.inspectionSucceeded, false); assert.equal(unproven.socketClosed, false);
      unavailable = false;
      const proof = await driver.terminate(child, new AbortController().signal);
      assert.equal(proof.inspectionSucceeded, false, 'audit loss remains conservatively latched');
      await until(() => { try { process.kill(descendant, 0); return false; } catch { return true; } });
      assert.throws(() => process.kill(child.pid, 0));
    } finally {
      for (const pid of [child.pid, descendant]) if (pid) { try { process.kill(pid, 'SIGKILL'); } catch { /* task-owned fake already reaped */ } }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('a reused PID/birth identity is never signalled or treated as the registered process', async () => {
    const directory = mkdtempSync(resolve('var/manager-reused-pid-'));
    const childFile = join(directory, 'fake-child.mjs'); const journal = join(directory, 'journal.jsonl');
    writeFileSync(childFile, fakeChildSource); writeFileSync(journal, '');
    let changed = false; let rootPid = 0;
    const driver = new NativeChildDriver({ nodeExecutable: process.execPath, configPath: join(directory, 'dummy.json'),
      env: { PATH: '/bin:/usr/bin', FAKE_JOURNAL: journal }, observeMs: 30, termGraceMs: 30, killGraceMs: 30,
      inspector: { list() { return nativeProcessInspector.list().map((row) => changed && row.pid === rootPid ? { ...row, startMs: row.startMs + 60_000, command: 'unrelated-reused-pid' } : row); } } });
    const fence = { sessionId: CHECKPOINT.sessionId, deploymentGeneration: 1, commandGeneration: 1 };
    const child = driver.launch({ ...RELEASES['A']!, artifactRoot: directory, entrypoint: childFile }, CHECKPOINT,
      { sessionId: CHECKPOINT.sessionId, generation: 1, online: true, paused: false }, fence);
    rootPid = child.pid;
    try {
      await driver.readiness(child, fence, new AbortController().signal);
      changed = true;
      const proof = await driver.terminate(child, new AbortController().signal);
      assert.equal(proof.rootGone, false); assert.equal(proof.socketClosed, false);
      assert.doesNotThrow(() => process.kill(child.pid, 0), 'identity mismatch was not signalled');
    } finally {
      changed = false;
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* this test’s registered dummy child only */ }
      await until(asyncProof);
      await driver.proveGone(child, new AbortController().signal);
      rmSync(directory, { recursive: true, force: true });
    }
    function asyncProof() { try { process.kill(child.pid, 0); return false; } catch { return true; } }
  });
});

describe('actual managed child endpoint lifecycle', () => {
  it('drain preempts initialization and waits for its real settlement; no stale readiness/activation or second initialization', async () => {
    const ipc = new EventEmitter(); const replies: ManagedReply[] = [];
    const started = deferred<void>(); const settled = deferred<void>(); const events: string[] = [];
    const services: ManagedChildServices = {
      async initialize(_context, _fence, signal) { events.push('initialize'); started.resolve(); await settled.promise; assert.equal(signal.aborted, true); },
      async readiness() { throw new Error('stale readiness must not run'); },
      async drain() { events.push('drain'); return { admissionClosed: true, preparationsSettled: true, providersSettled: true, actuatorsReleased: true, interfacesSettled: true, socketClosed: true, socketClosedAtMs: Date.now(), checkpoint: CHECKPOINT }; },
      async activate() { throw new Error('stale activation must not run'); }, async pause() {}, async announce() { return 'unavailable'; },
    };
    const endpoint = attachManagedChild(services, { on: (event, listener) => ipc.on(event, listener), off: (event, listener) => ipc.off(event, listener), send(reply) { if (reply.kind === 'chunkbot_manager_reply') replies.push(reply); } });
    const base: Omit<ManagedRequest, 'operation' | 'payload' | 'requestId'> = { version: 1, kind: 'chunkbot_manager_request', childId: 'registered-fake', fence: { sessionId: CHECKPOINT.sessionId, deploymentGeneration: 1, commandGeneration: 1 } };
    ipc.emit('message', { ...base, requestId: 'init', operation: 'initialize', payload: { release: RELEASES['A'], checkpoint: CHECKPOINT, intent: { sessionId: CHECKPOINT.sessionId, generation: 1, online: true, paused: false } } });
    await started.promise;
    ipc.emit('message', { ...base, requestId: 'duplicate-init', operation: 'initialize', payload: null });
    ipc.emit('message', { ...base, requestId: 'drain', operation: 'drain', payload: null, fence: { ...base.fence, commandGeneration: 2 } });
    await sleep(10); assert.deepEqual(events, ['initialize']);
    settled.resolve(); await until(() => replies.some((reply) => reply.requestId === 'drain'));
    assert.deepEqual(events, ['initialize', 'drain']);
    assert.equal(replies.find((reply) => reply.requestId === 'init')!.ok, false);
    assert.equal(replies.find((reply) => reply.requestId === 'duplicate-init')!.ok, false);
    assert.equal(replies.find((reply) => reply.requestId === 'drain')!.ok, true);
    await endpoint.close();
  });
});
