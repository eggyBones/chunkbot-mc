// MB-UI-001-C4/C5: the REAL browser script (APP_JS) runs against a minimal fake
// DOM. Under the strict `style-src 'self'` CSP an inline `style` attribute is
// rejected, so the renderer must never set one; dynamic widths/hues go through
// CSSOM properties (allowed by CSP). Tiny charges render at full precision in a
// card grid that reflows instead of clipping.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { DashboardStatus, RemoteMetadata } from '../src/contracts/dashboard.ts';
import { APP_CSS, APP_JS } from '../src/dashboard/assets/page.ts';
import { DashboardStatusPublisher } from '../src/dashboard/publisher.ts';
import { remoteMetadata } from '../src/dashboard/remote.ts';
import { StatusFollower, buildViewModel, type ViewModel } from '../src/dashboard/viewmodel.ts';
import { SpendLedger } from '../src/decision/spend.ts';
import { FakeConnection, stack, window0 } from './dashboard-fakes.ts';

class FakeStyle {
  readonly props: Record<string, string> = {};
  setProperty(k: string, v: string): void {
    this.props[k] = v;
  }
}

class FakeEl {
  readonly children: Array<FakeEl | FakeText> = [];
  readonly attrs: Record<string, string> = {};
  readonly style = new FakeStyle();
  className = '';
  textContent = '';
  readonly tagName: string;
  private readonly violations: string[];
  constructor(tagName: string, violations: string[]) {
    this.tagName = tagName;
    this.violations = violations;
  }
  setAttribute(k: string, v: unknown): void {
    if (k.toLowerCase() === 'style') this.violations.push(String(v));
    this.attrs[k] = String(v);
  }
  appendChild<T extends FakeEl | FakeText>(c: T): T {
    this.children.push(c);
    return c;
  }
  replaceChildren(...c: Array<FakeEl | FakeText>): void {
    this.children.splice(0, this.children.length, ...c);
  }
  querySelectorAll(): FakeEl[] {
    return [];
  }
  querySelector(): null {
    return null;
  }
  remove(): void {}
}
class FakeText {
  readonly textContent: string;
  constructor(textContent: string) {
    this.textContent = textContent;
  }
}

function walk(n: FakeEl | FakeText, out: FakeEl[] = []): FakeEl[] {
  if (n instanceof FakeEl) {
    out.push(n);
    for (const c of n.children) walk(c, out);
  }
  return out;
}
const text = (n: FakeEl | FakeText): string => (n instanceof FakeText ? n.textContent : n.textContent + n.children.map(text).join(''));

async function renderInFakeDom(vm: ViewModel) {
  const violations: string[] = [];
  const root = new FakeEl('div', violations);
  const body = new FakeEl('body', violations);
  const document = {
    title: '',
    body,
    getElementById: () => root,
    createElement: (t: string) => new FakeEl(t, violations),
    createElementNS: (_ns: string, t: string) => new FakeEl(t, violations),
    createTextNode: (s: string) => new FakeText(s),
  };
  const listeners: Record<string, (e: { data: string }) => void> = {};
  class ES {
    onerror: (() => void) | null = null;
    addEventListener(name: string, fn: (e: { data: string }) => void): void {
      listeners[name] = fn;
    }
  }
  const fetchStub = () => Promise.resolve({ json: () => Promise.resolve(vm) });
  new Function('document', 'fetch', 'EventSource', 'setInterval', APP_JS)(document, fetchStub, ES, () => 0);
  await new Promise((r) => setTimeout(r, 0));
  listeners['state']?.({ data: JSON.stringify(vm) }); // a streamed refresh renders again
  return { root, violations, all: walk(root) };
}

function liveVm(): ViewModel {
  const clock = { t: 7_000_000 };
  const game = new FakeConnection(clock);
  const spend = new SpendLedger(1);
  const pub = new DashboardStatusPublisher({ statusPath: '/dev/null/never', runId: 'run-client01', pid: 1, now: () => clock.t, game, profile: { version: '26.2', supportLevel: 'local-compat' }, spend: () => spend.snapshot() });
  pub.start();
  game.join();
  game.ready();
  game.health(20, 20);
  game.xp(4, 0.429, 70);
  game.windowItems(0, window0({ 36: stack(6, 1) }));
  const r1 = spend.reserve(0.001344, 'a')!;
  spend.reconcile(r1, 0.000558642);
  spend.reserve(0.001344, 'b'); // pending
  const r3 = spend.reserve(0.001344, 'c')!;
  spend.retain(r3);
  const f = new StatusFollower();
  const s: DashboardStatus = pub.snapshot();
  f.accept({ kind: 'ok', status: { ...s, publisher: { ...s.publisher, seq: 1 } } });
  const base = remoteMetadata({});
  const remote: RemoteMetadata = { ...base, codexQuota: { status: 'fresh', scope: 'codex_account', checkedAtMs: clock.t, lastSuccessAtMs: clock.t, detail: 'ok', windows: [{ bucket: 'codex:primary', usedPercent: 41, windowDurationMins: 10080, resetsAtMs: clock.t + 86_400_000 }] } };
  pub.stop('t');
  return buildViewModel({ follower: f, now: clock.t, pidAlive: () => true, history: undefined, remote, timeZone: 'UTC', cadence: 'per source' });
}

describe('dashboard browser script under the strict CSP (C4)', () => {
  it('never sets an inline style attribute, on first render or refresh', async () => {
    const { violations } = await renderInFakeDom(liveVm());
    assert.deepEqual(violations, []);
    assert.doesNotMatch(APP_JS, /setAttribute\(\s*'style'/);
  });

  it('XP and quota fills get their real widths through CSSOM, matching the text', async () => {
    const vm = liveVm();
    assert.match(vm.world.xp.text, /^42% to level 5/);
    const { all } = await renderInFakeDom(vm);
    const fills = all.filter((e) => e.className === 'fill');
    assert.equal(fills.length, 2, 'one XP fill and one quota fill');
    assert.equal(fills[0]!.style.props['width'], '42.9%');
    assert.equal(fills[1]!.style.props['width'], '59%', 'remaining share of the returned window');
    const bars = all.filter((e) => e.attrs['role'] === 'progressbar');
    assert.deepEqual(bars.map((b) => b.attrs['aria-valuenow']), ['43', '59']);
    // A fill without a width defaults to empty (never a misleading full bar).
    assert.match(APP_CSS, /\.xpbar > \.fill \{[^}]*width: 0;/);
    assert.match(APP_CSS, /\.qbar > \.fill \{[^}]*width: 0;/);
  });

  it('item tiles carry their hue as a CSS custom property, not an inline style', async () => {
    const { all } = await renderInFakeDom(liveVm());
    const tile = all.find((e) => e.className.startsWith('slot') && e.style.props['--hue'] !== undefined);
    assert.ok(tile, 'occupied slot has a --hue property');
    assert.match(APP_CSS, /hsl\(var\(--hue/);
  });
});

describe('dashboard money cards (C5)', () => {
  it('render exact tiny charges, with retained and pending as separate cards', async () => {
    const vm = liveVm();
    assert.deepEqual(vm.usage.jevSplit.map((r) => [r.label, r.value]), [
      ['Confirmed charges', '$0.000558642'],
      ['Retained (uncertain)', '$0.001344'],
      ['Pending reservation', '$0.001344'],
    ]);
    const { all } = await renderInFakeDom(vm);
    const vals = all.filter((e) => e.className.startsWith('val')).map(text);
    assert.deepEqual(vals, ['$0.000558642', '$0.001344', '$0.001344']);
  });

  it('the card grid reflows and long values wrap instead of being clipped', () => {
    assert.match(APP_CSS, /\.split \{[^}]*repeat\(auto-fit, minmax\(/);
    assert.doesNotMatch(APP_CSS, /\.split \{[^}]*repeat\(3,/);
    assert.match(APP_CSS, /\.split \.val \{[^}]*overflow-wrap: anywhere/);
    assert.match(APP_CSS, /\.split > div \{[^}]*min-width: 0/);
  });
});
