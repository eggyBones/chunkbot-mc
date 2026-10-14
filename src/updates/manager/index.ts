export * from './ports.ts';
export * from './manager.ts';
export * from './native-child.ts';
export * from './lease.ts';
export * from './child-endpoint.ts';

import { ReleaseManager } from './manager.ts';
import { NativeChildDriver, type NativeChildOptions } from './native-child.ts';
import type { ManagerOptions } from './ports.ts';

/** Integration entry point: artifact/checkpoint adapters plus one native driver. */
export function createNativeReleaseManager(options: Omit<ManagerOptions, 'children'> & { nativeChild: NativeChildOptions }): ReleaseManager {
  const { nativeChild, ...manager } = options;
  return new ReleaseManager({ ...manager, children: new NativeChildDriver(nativeChild) });
}
