import { setTimeout as delay } from 'node:timers/promises';
import { VanillaControlBridge, type BridgeHealth, type BridgeOptions } from './bridge.ts';
import { createPrivateRconTransport, type PrivateRconOptions } from './rcon.ts';

export { VanillaControlBridge } from './bridge.ts';
export type { BridgeHealth, BridgeOptions } from './bridge.ts';
export { createPrivateRconTransport } from './rcon.ts';
export type { PrivateRconOptions } from './rcon.ts';
export { installationCommand } from './protocol.ts';
export type { BridgeBinding, BridgeIntentRequest, BridgeIntentReceipt, BridgeManagerPort, BridgeManagerStatus, BridgeTransport } from './types.ts';
export { BridgeBindingSchema } from './types.ts';

export interface ManagedBridgeOptions extends Omit<BridgeOptions, 'transport'> {
  rcon: PrivateRconOptions;
  signal: AbortSignal;
  onHealth?: (health: BridgeHealth) => void;
}
export interface ManagedBridgeHandle {
  status(): BridgeHealth;
  done: Promise<void>;
  stop(): Promise<void>;
}

/** Owned real entry point for the SINGLE manager's composition root. Remains
 * running through child on/off; stops with the manager, not with the bot child.
 * The integration-owned CLI/config supplies a reviewed binding and manager port.
 * Calling it never installs the datapack, launches a manager, or signs in. */
export async function startManagedVanillaBridge(options: ManagedBridgeOptions): Promise<ManagedBridgeHandle> {
  const controller = new AbortController();
  const signal = AbortSignal.any([options.signal, controller.signal]);
  const bridge = new VanillaControlBridge({ ...options, transport: createPrivateRconTransport(options.rcon) });
  const abort = () => { void bridge.stop(); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) { signal.removeEventListener('abort', abort); throw new Error('bridge start cancelled'); }
  const first = await bridge.start();
  options.onHealth?.(first);
  const done = (async () => {
    try {
      let health = first;
      while (!signal.aborted && health.state === 'ready') {
        await delay(250, undefined, { signal });
        health = await bridge.poll();
        options.onHealth?.(health);
      }
    } catch { /* Abort stops only the owned bridge; no runtime process signalling. */ }
    finally { signal.removeEventListener('abort', abort); await bridge.stop(); }
  })();
  return { status: () => bridge.status(), done, stop: async () => { controller.abort(); await done; } };
}
