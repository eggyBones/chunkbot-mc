// MB-SERVER-001: the codec audit counts decoded packets, packets with unread
// trailing bytes, and packets that fail to decode, per protocol state, through
// the production minecraft-protocol deserializer, without altering packets.
import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import minecraftData from 'minecraft-data';
import { CodecAudit, clientboundPacketNames, codecSummary } from '../src/game/codec-audit.ts';

const require = createRequire(import.meta.url);
const mc = require('minecraft-protocol') as {
  createDeserializer(o: object): { parsePacketBuffer(b: Buffer): { metadata: { size: number }; data: { name: string } } };
  createSerializer(o: object): { createPacketBuffer(p: object): Buffer };
};

describe('codec audit', () => {
  for (const version of ['26.1.2', '26.2']) {
    it(`${version}: counts clean, trailing and failed packets and re-wraps on state change`, () => {
      const client = Object.assign(new EventEmitter(), {
        state: 'play',
        deserializer: mc.createDeserializer({ state: 'play', isServer: false, version, noErrorLogging: true }),
      });
      const audit = new CodecAudit(client, clientboundPacketNames(minecraftData(version)?.protocol));
      audit.attach();
      const good = mc.createSerializer({ state: 'play', isServer: true, version }).createPacketBuffer({ name: 'keep_alive', params: { keepAliveId: 7n } });
      const parsed = client.deserializer.parsePacketBuffer(good);
      assert.equal(parsed.data.name, 'keep_alive', 'packets pass through unchanged');
      client.deserializer.parsePacketBuffer(Buffer.concat([good, Buffer.from([1, 2, 3])]));
      assert.throws(() => client.deserializer.parsePacketBuffer(good.subarray(0, 3)));
      let h = audit.health();
      assert.equal(h.decoded, 1);
      assert.deepEqual(h.trailingBytes, { 'play.keep_alive': 1 });
      assert.deepEqual(h.parseFailures, { 'play.keep_alive': 1 });
      assert.match(codecSummary(h), /^codec=decoded:1,trailing:1,failed:1 first=/);

      // New protocol state -> new deserializer -> audited too.
      client.state = 'configuration';
      client.deserializer = mc.createDeserializer({ state: 'configuration', isServer: false, version, noErrorLogging: true });
      client.emit('state', 'configuration', 'play');
      const cfg = mc.createSerializer({ state: 'configuration', isServer: true, version }).createPacketBuffer({ name: 'finish_configuration', params: {} });
      client.deserializer.parsePacketBuffer(cfg);
      h = audit.health();
      assert.equal(h.decoded, 2);
      audit.detach();
      client.deserializer.parsePacketBuffer(cfg);
      assert.equal(audit.health().decoded, 2, 'detached audit stops counting');
    });
  }
});
