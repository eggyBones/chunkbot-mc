import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, linkSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { ArtifactError } from '../src/updates/artifacts/model.ts';
import { inventory, readRegular, relativePath, treeDigest, assertInventoryPaths } from '../src/updates/artifacts/files.ts';

mkdirSync('var/packaging-tests', { recursive: true });
function sandbox(): string { return mkdtempSync(resolve('var/packaging-tests/case-')); }

test('packaging paths reject traversal, alternate separators, collisions and aliased ancestors', () => {
  for (const path of ['../key', '/key', 'C:/key', 'a\\key', './key', 'a//key', 'a/../key', 'a/secret\0', 'a./key']) {
    assert.throws(() => relativePath(path), ArtifactError);
  }
  const dir = sandbox();
  try {
    mkdirSync(join(dir, 'real')); writeFileSync(join(dir, 'real/file'), 'safe');
    symlinkSync('real', join(dir, 'link'));
    assert.throws(() => readRegular(dir, 'link/file'), ArtifactError);
    assert.throws(() => inventory(join(dir, 'link')), ArtifactError);
    const item = { path: 'File', size: 0, sha256: '0'.repeat(64), executable: false };
    assert.throws(() => assertInventoryPaths([item, { ...item, path: 'file' }]), ArtifactError);
    assert.throws(() => assertInventoryPaths([item, { ...item, path: 'File/child' }]), ArtifactError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('packaging never follows file symlinks or adopts a hardlinked mutable file', () => {
  const dir = sandbox();
  try {
    writeFileSync(join(dir, 'original'), 'safe');
    symlinkSync('original', join(dir, 'symlink'));
    assert.throws(() => readRegular(dir, 'symlink'), ArtifactError);
    linkSync(join(dir, 'original'), join(dir, 'hardlink'));
    assert.throws(() => readRegular(dir, 'hardlink'), ArtifactError);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('tree identity is deterministic and binds bytes, paths and executable bits', () => {
  const a = { path: 'a', size: 1, sha256: 'a'.repeat(64), executable: false };
  const b = { ...a, path: 'b' };
  assert.equal(treeDigest([a, b]), treeDigest([b, a]));
  assert.notEqual(treeDigest([a]), treeDigest([{ ...a, executable: true }]));
  assert.notEqual(treeDigest([a]), treeDigest([{ ...a, sha256: 'b'.repeat(64) }]));
});
