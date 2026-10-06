import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseChatLine, parseTerminalLine } from '../src/commands/parse.ts';
import { routeCommand, type CommandTarget } from '../src/commands/router.ts';

const P = '!chunkbot';

describe('chat command parsing', () => {
  it('routes implicit and explicit-alias instructions to the same goal form, verbatim', () => {
    for (const text of ['collect stone', 'get resources and make armor', 'follow me', 'please light up the cave with torches and then meet me by the boat']) {
      const implicit = parseChatLine(`${P} ${text}`, P);
      const alias = parseChatLine(`${P} goal ${text}`, P);
      assert.deepEqual(implicit, { kind: 'goal', instruction: text, via: 'implicit' });
      assert.deepEqual(alias, { kind: 'goal', instruction: text, via: 'goal_alias' });
    }
  });

  it('recognizes reserved control verbs', () => {
    assert.deepEqual(parseChatLine('!chunkbot stop', P), { kind: 'stop' });
    assert.deepEqual(parseChatLine('!Chunkbot STOP!', P), { kind: 'stop' });
    assert.deepEqual(parseChatLine('!chunkbot status', P), { kind: 'status' });
    assert.deepEqual(parseChatLine('!chunkbot answer iron', P), { kind: 'answer', reply: 'iron' });
    assert.deepEqual(parseChatLine('!chunkbot answer q3 iron please', P), { kind: 'answer', ref: 'q3', reply: 'iron please' });
    assert.deepEqual(parseChatLine('!chunkbot answer Q12: leather', P), { kind: 'answer', ref: 'q12', reply: 'leather' });
    assert.deepEqual(parseChatLine('!chunkbot goal stop by the river', P), { kind: 'goal', instruction: 'stop by the river', via: 'goal_alias' });
  });

  it('ignores chat that is not addressed with the prefix', () => {
    assert.equal(parseChatLine('hello chunkbot, collect stone', P), null);
    assert.equal(parseChatLine('<FixtureOwner> !chunkbot come here', P), null);
    assert.equal(parseChatLine('!chunkbotfoo bar', P), null);
    assert.equal(parseChatLine('', P), null);
  });

  it('passes empty instructions through so the intake can reject them before replacing work', () => {
    assert.deepEqual(parseChatLine('!chunkbot', P), { kind: 'goal', instruction: '', via: 'implicit' });
    assert.deepEqual(parseChatLine('!chunkbot goal', P), { kind: 'goal', instruction: '', via: 'goal_alias' });
  });
});

describe('terminal command parsing', () => {
  it('uses the same language without the prefix and accepts the prefixed form', () => {
    assert.deepEqual(parseTerminalLine('collect stone', P), { kind: 'goal', instruction: 'collect stone', via: 'implicit' });
    assert.deepEqual(parseTerminalLine('!chunkbot collect stone', P), { kind: 'goal', instruction: 'collect stone', via: 'implicit' });
    assert.deepEqual(parseTerminalLine('stop', P), { kind: 'stop' });
    assert.deepEqual(parseTerminalLine('status', P), { kind: 'status' });
    assert.equal(parseTerminalLine('   ', P), null);
  });

  it('keeps operator commands slash-prefixed and terminal-only', async () => {
    assert.deepEqual(parseTerminalLine('/quit', P), { kind: 'operator', verb: 'quit' });
    assert.deepEqual(parseTerminalLine('/exit', P), { kind: 'operator', verb: 'quit' });
    assert.deepEqual(parseTerminalLine('/reconnect', P), { kind: 'operator', verb: 'reconnect' });
    assert.equal(parseTerminalLine('/nuke', P)?.kind, 'invalid');
    // A chat line can never produce an operator command; the router also refuses it.
    assert.equal(parseChatLine('!chunkbot /quit', P)?.kind, 'goal');
    const calls: string[] = [];
    const target: CommandTarget = {
      submitGoal: async () => void calls.push('goal'),
      stop: async () => void calls.push('stop'),
      status: () => void calls.push('status'),
      answer: () => void calls.push('answer'),
      invalid: () => void calls.push('invalid'),
      operator: async () => void calls.push('operator'),
    };
    await routeCommand({ kind: 'operator', verb: 'quit' }, { surface: 'chat', principal: 'owner' }, target);
    assert.deepEqual(calls, ['invalid']);
  });
});
