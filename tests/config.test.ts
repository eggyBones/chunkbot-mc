import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ConfigError, loadConfigFile, parseConfig } from '../src/config/load.ts';
import { isLoopbackHost } from '../src/config/schema.ts';
import { checkVersionSupport } from '../src/config/versions.ts';

const fixture = () => ({
  minecraft: { host: '127.0.0.1', port: 25566, version: '26.1.2' },
  bot: { auth: 'offline', username: 'Chunkbot', trustedOfflineFixture: true },
  owner: { name: 'FixtureOwner' },
});

const online = () => ({
  minecraft: { host: 'mc.example.net', version: '26.1.2' },
  bot: { auth: 'microsoft', username: 'chunkbot' },
  owner: { uuid: '0123456789ABCDEF0123456789abcdef' },
});

function problems(raw: unknown): string[] {
  try {
    parseConfig(raw);
  } catch (error) {
    assert.ok(error instanceof ConfigError);
    return error.problems;
  }
  assert.fail('expected a ConfigError');
}

describe('configuration validation', () => {
  it('loads both checked-in examples', () => {
    const fx = loadConfigFile('config/examples/fixture.json');
    assert.equal(fx.config.bot.auth, 'offline');
    assert.match(fx.runsDir, /\/var\/runs$/);
    const ms = loadConfigFile('config/examples/microsoft.json');
    assert.equal(ms.config.bot.auth, 'microsoft');
    assert.match(ms.authDir, /\/var\/auth\/microsoft$/);
  });

  it('applies architecture limits as defaults and normalizes owner UUIDs', () => {
    const cfg = parseConfig(online());
    assert.equal(cfg.limits.plannerTurnsPerGoal, 20);
    assert.equal(cfg.limits.goalDeadlineMs, 1_200_000);
    assert.equal(cfg.chat.prefix, '!chunkbot');
    assert.equal(cfg.owner.uuid, '01234567-89ab-cdef-0123-456789abcdef');
  });

  it('requires an explicit trusted flag and a loopback host for offline auth', () => {
    const noFlag = fixture();
    noFlag.bot.trustedOfflineFixture = false;
    assert.match(problems(noFlag).join('\n'), /bot\.trustedOfflineFixture: offline auth requires trustedOfflineFixture: true/);

    const remote = fixture();
    remote.minecraft.host = 'mc.example.net';
    assert.match(problems(remote).join('\n'), /minecraft\.host: offline auth is only allowed for a loopback host/);
  });

  it('requires an owner UUID for Microsoft auth and forbids the offline flag there', () => {
    const missing = online() as Record<string, unknown>;
    missing['owner'] = { name: 'Jake' };
    assert.match(problems(missing).join('\n'), /owner\.uuid: microsoft auth requires the owner UUID/);
    const flagged = online();
    (flagged.bot as Record<string, unknown>)['trustedOfflineFixture'] = true;
    assert.match(problems(flagged).join('\n'), /trustedOfflineFixture only applies to offline auth/);
  });

  it("refuses a bot identity equal to the owner's", () => {
    const same = fixture();
    same.bot.username = 'fixtureowner';
    assert.match(problems(same).join('\n'), /bot identity must differ/);
  });

  it('rejects unknown fields (e.g. pasted secrets) without echoing their values', () => {
    const raw = fixture() as Record<string, unknown>;
    raw['models'] = { decision: { provider: 'openrouter', apiKey: 'sk-or-v1-supersecretvalue1234567890' } };
    const list = problems(raw);
    assert.match(list.join('\n'), /unknown field\(s\): apiKey/);
    assert.ok(!list.join('\n').includes('supersecret'), 'secret value must not appear in errors');
  });

  it('accepts only environment variable names for model keys', () => {
    const raw = fixture() as Record<string, unknown>;
    raw['models'] = { decision: { provider: 'openrouter', apiKeyEnv: 'sk-or-v1-abcdef' } };
    const list = problems(raw).join('\n');
    assert.match(list, /environment variable NAME/);
    assert.ok(!list.includes('abcdef'));
  });

  it('rejects an unknown auth mode instead of letting the library fall back to offline', () => {
    const raw = fixture();
    (raw.bot as Record<string, unknown>)['auth'] = 'mojang';
    assert.match(problems(raw).join('\n'), /bot\.auth/);
  });

  it('rejects versions the installed protocol stack does not support', () => {
    const raw = fixture();
    raw.minecraft.version = '26.3';
    assert.match(problems(raw).join('\n'), /minecraft\.version: version 26\.3 /);
    raw.minecraft.version = '26.2.1';
    assert.match(problems(raw).join('\n'), /minecraft\.version: version 26\.2\.1 has no data.*admits exactly 26\.2/);
    assert.equal(checkVersionSupport('26.1.2'), undefined);
    assert.equal(checkVersionSupport('26.1'), undefined);
    // MB-SERVER-001: exactly 26.2 is admitted through the vendored local compatibility stack.
    assert.equal(checkVersionSupport('26.2'), undefined);
  });

  it('fails before connecting on unreadable or malformed files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chunkbot-config-'));
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ not json');
    assert.throws(() => loadConfigFile(bad), /not valid JSON/);
    assert.throws(() => loadConfigFile(join(dir, 'missing.json')), /cannot read configuration file \(ENOENT\)/);
  });

  it('recognizes loopback hosts', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', '::1', 'localhost', 'LOCALHOST']) assert.equal(isLoopbackHost(host), true, host);
    for (const host of ['10.0.0.1', '192.168.1.2', 'mc.example.net', '0.0.0.0']) assert.equal(isLoopbackHost(host), false, host);
  });
});
