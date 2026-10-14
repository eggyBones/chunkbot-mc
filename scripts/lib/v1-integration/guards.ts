import type { Artifact, Fixture, Grant } from './types.ts';

export function parseOptions(argv: readonly string[]) {
  const values = new Map<string, string>();
  let stage = false;
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!;
    if (key === '--stage' && !stage) { stage = true; continue; }
    if (!['--fixture', '--fixture-lease', '--grant-file', '--only', '--composition-file'].includes(key) || values.has(key) || !argv[i + 1] || argv[i + 1]!.startsWith('--')) throw new Error(`invalid argument ${key}`);
    values.set(key, argv[++i]!);
  }
  const fixture = values.get('--fixture') ?? '26.1.2';
  if (fixture !== '26.1.2' && fixture !== '26.2') throw new Error('unsupported fixture');
  const leaseId = values.get('--fixture-lease');
  if (!stage && (!leaseId || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(leaseId) || !values.get('--grant-file'))) throw new Error('live execution requires a named coordinator fixture lease and --grant-file');
  if (stage && (leaseId || values.has('--grant-file'))) throw new Error('--stage cannot carry live authority');
  return { stage, fixture: fixture as Fixture, leaseId, grantFile: values.get('--grant-file'), only: values.get('--only')?.split(','), compositionFile: values.get('--composition-file') };
}

export function verifyGrant(value: unknown, fixture: Fixture, leaseId: string, artifact: Artifact, now: number, keyInjected: boolean): Grant {
  const g = value as Partial<Grant> | null;
  if (!g || g.version !== 1 || g.leaseId !== leaseId || g.fixture !== fixture || g.realProviders !== true || !Number.isSafeInteger(g.expiresAtMs) || g.expiresAtMs! <= now) throw new Error('absent, expired or mismatched coordinator grant');
  if (!keyInjected) throw new Error('coordinator key injection is absent');
  if (artifact.dirty || !artifact.distSha256 || !g.artifact || g.artifact.dirty || g.artifact.head !== artifact.head || g.artifact.sourceSha256 !== artifact.sourceSha256 || g.artifact.distSha256 !== artifact.distSha256) throw new Error('source/build do not match the clean frozen granted artifact');
  return g as Grant;
}
