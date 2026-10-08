import assert from 'node:assert/strict';
import { it } from 'node:test';
import { SafetyFluidFactSchema } from '../src/contracts/safety.ts';
import { self } from './safety-helpers.ts';

it('W-C11-R7 column evidence is optional for old readers and explicit for new readers', () => {
  const old = self().fluid;
  assert.deepEqual(SafetyFluidFactSchema.parse(old), old);
  for (const columnFluid of ['water', 'lava', 'none', 'unknown']) {
    assert.equal(SafetyFluidFactSchema.parse({ ...old, columnFluid }).columnFluid, columnFluid);
  }
  assert.equal(SafetyFluidFactSchema.safeParse({ ...old, columnFluid: 'dry_shore' }).success, false);
});
