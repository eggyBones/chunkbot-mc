// MB-LOC-002 D1 (coordinator-authorized): the DEFAULT owner-statement age limit
// is the bounded maximum (600 s), so an owner who stands still far away (the
// official server sends nothing new for a stationary block/chunk statement) is
// still found. Withdrawal is unchanged: untrack, logout (identity no longer
// listed), dimension change/respawn and a new connection remove the cue at ANY
// age; an explicitly configured shorter limit stays binding; age and remaining
// freshness are reported honestly. No hidden coordinate outlives these fences.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { DEFAULT_LOCATOR_CONFIG, LocatorConfigSchema } from '../src/contracts/locator.ts';
import { runRoute } from '../src/locator/route-runner.ts';
import { sim } from './locator-sim.ts';

const MAX = 600_000;
/** A stationary owner 200 blocks east: chunk precision in the simulator (view distance 10 chunks). */
const OWNER = { x: 200.5, y: 64, z: 0.5 };
const seek = (s: ReturnType<typeof sim>) => runRoute(s.env, { kind: 'owner' }, { within: 3, durationMs: 8_000 }, { routes: s.routes, locator: s.locator });

describe('MB-LOC-002 D1 locator freshness at the accepted default', () => {
  it('the default is the bounded maximum (600 s); an explicitly configured limit is binding', () => {
    assert.equal(DEFAULT_LOCATOR_CONFIG.hintMaxAgeMs, MAX);
    assert.equal(LocatorConfigSchema.parse({}).hintMaxAgeMs, MAX);
    assert.equal(LocatorConfigSchema.parse({ hintMaxAgeMs: 60_000 }).hintMaxAgeMs, 60_000);
    assert.equal(LocatorConfigSchema.safeParse({ hintMaxAgeMs: 600_001 }).success, false, 'never beyond the bounded maximum');
  });

  it('a stationary owner (no new statement for 5 minutes) is still found, with honest age and remaining freshness', async () => {
    const s = sim({ ownerAt: OWNER });
    assert.equal(s.locator.status().counters.byVariant.chunk, 1);
    s.clock.t += 300_000;
    const h = s.locator.ownerHint();
    assert.ok(h.actionable, h.note);
    assert.equal(h.ageMs, 300_000);
    assert.equal(h.expiresInMs, MAX - 300_000);
    assert.equal(h.direction, 'east');
    const r = await seek(s);
    assert.ok(s.moves > 0 && s.self.x > 5, `the bot seeks the stationary owner (${r.status}/${r.reason}, x ${s.self.x.toFixed(1)})`);
  });

  it('older than the default limit with no new statement: expired, nothing moves', async () => {
    const s = sim({ ownerAt: OWNER });
    s.clock.t += MAX + 1;
    const h = s.locator.ownerHint();
    assert.equal(h.actionable, false);
    assert.equal(h.reason, 'expired');
    assert.equal(h.ageMs, MAX + 1);
    const r = await seek(s);
    assert.equal(r.reason, 'no_actionable_hint');
    assert.equal(s.moves, 0);
  });

  it('withdrawal is immediate at any age: untrack (hiding/range/locator bar off), logout, dimension change, a new connection', () => {
    // untrack
    const a = sim({ ownerAt: OWNER });
    a.clock.t += 10_000;
    a.owner.hidden = true;
    a.serverEmit();
    assert.equal(a.locator.ownerHint().reason, 'untracked');
    // logout: the identity is no longer listed by the server
    const b = sim({ ownerAt: OWNER });
    b.clock.t += 10_000;
    b.bot.players = {};
    assert.equal(b.locator.ownerHint().reason, 'owner_identity_unverified');
    // dimension change / respawn
    const c = sim({ ownerAt: OWNER });
    c.client.emit('respawn', {});
    assert.equal(c.locator.ownerHint().reason, 'dimension_changed');
    const d = sim({ ownerAt: OWNER });
    d.locator.onLifecycle({ type: 'dimension_change', connectionEpoch: 1, dimension: 'minecraft:the_nether' } as never);
    assert.equal(d.locator.ownerHint().actionable, false);
    // a new connection starts empty (a fresh broadcast is required)
    const e = sim({ ownerAt: OWNER });
    e.locator.attach(new EventEmitter(), 1);
    assert.equal(e.locator.ownerHint().actionable, false);
  });

  it('an explicitly configured short limit is never extended by the new default', async () => {
    const s = sim({ ownerAt: OWNER, locatorConfig: LocatorConfigSchema.parse({ hintMaxAgeMs: 60_000 }) });
    s.clock.t += 59_000;
    assert.equal(s.locator.ownerHint().expiresInMs, 1_000);
    s.clock.t += 1_001;
    assert.equal(s.locator.ownerHint().reason, 'expired');
    const r = await seek(s);
    assert.equal(r.reason, 'no_actionable_hint');
    assert.equal(s.moves, 0);
  });

  it('a new server statement (the owner moved) restarts the age honestly', () => {
    const s = sim({ ownerAt: OWNER });
    s.clock.t += 400_000;
    s.owner.at = { x: 216.5, y: 64, z: 0.5 }; // next chunk east
    s.serverEmit();
    const h = s.locator.ownerHint();
    assert.ok(h.actionable);
    assert.equal(h.ageMs, 0);
    assert.equal(h.expiresInMs, MAX);
  });
});
