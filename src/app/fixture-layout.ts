// Paths and pins for the trusted local test fixtures (separate vanilla Java
// servers on loopback). All fixture data lives under the ignored `var/` tree.
//
// Two independent fixture PROFILES exist. The default (`26.1.2`) is the
// accepted fixture at 127.0.0.1:25566 under var/fixture/. The `26.2` profile
// (MB-SERVER-001) is a DISTINCT server at 127.0.0.1:25567 under
// var/fixture-26.2/ with its own world, RCON password and PID file. Profiles
// never share a world, server directory or PID guard; they share only the
// checksum-pinned Temurin JRE archive (same release, verified separately).
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const JRE = {
  javaMajor: 25,
  jreRelease: 'jdk-25.0.4.1+1',
  jreUrl:
    'https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.4.1%2B1/OpenJDK25U-jre_aarch64_mac_hotspot_25.0.4.1_1.tar.gz',
  jreSha256: '5b02bcc908da092e7e00b9772d4f9bbb87f44a60b7c90f7cf5a91a1d98f37e1b',
} as const;

export interface FixturePins {
  /** Profile id (`26.1.2` default, `26.2`). */
  profile: FixtureProfileId;
  minecraftVersion: string;
  /** Protocol version the official jar reports in its status response. */
  protocolVersion: number;
  serverJarUrl: string;
  serverJarSha1: string;
  javaMajor: number;
  jreRelease: string;
  jreUrl: string;
  jreSha256: string;
  host: '127.0.0.1';
  port: number;
  rconPort: number;
  /** Directory under var/ that holds this profile's JRE, server, world and PID file. */
  varDir: string;
  /** Fixture configuration examples (real planner / inference-free) for this profile. */
  config: string;
  inferenceFreeConfig: string;
}

export const FIXTURE_PROFILES = {
  '26.1.2': {
    profile: '26.1.2',
    minecraftVersion: '26.1.2',
    protocolVersion: 775,
    serverJarUrl: 'https://piston-data.mojang.com/v1/objects/97ccd4c0ed3f81bbb7bfacddd1090b0c56f9bc51/server.jar',
    serverJarSha1: '97ccd4c0ed3f81bbb7bfacddd1090b0c56f9bc51',
    ...JRE,
    host: '127.0.0.1',
    port: 25566,
    rconPort: 25576,
    varDir: 'fixture',
    config: 'config/examples/fixture.json',
    inferenceFreeConfig: 'config/examples/fixture-inference-free.json',
  },
  // Official Mojang 26.2 server: version manifest entry 26.2.json
  // (sha1 c7868781b30aaf24be0dac894c94a34e5d6df10d) -> downloads.server; javaVersion 25.
  '26.2': {
    profile: '26.2',
    minecraftVersion: '26.2',
    protocolVersion: 776,
    serverJarUrl: 'https://piston-data.mojang.com/v1/objects/823e2250d24b3ddac457a60c92a6a941943fcd6a/server.jar',
    serverJarSha1: '823e2250d24b3ddac457a60c92a6a941943fcd6a',
    ...JRE,
    host: '127.0.0.1',
    port: 25567,
    rconPort: 25577,
    varDir: 'fixture-26.2',
    config: 'config/examples/fixture-26.2.json',
    inferenceFreeConfig: 'config/examples/fixture-26.2-inference-free.json',
  },
} as const satisfies Record<string, FixturePins>;

export type FixtureProfileId = '26.1.2' | '26.2';

export const DEFAULT_FIXTURE_PROFILE: FixtureProfileId = '26.1.2';

/** The default (accepted 26.1.2) fixture pins. */
export const FIXTURE_PINS: FixturePins = FIXTURE_PROFILES[DEFAULT_FIXTURE_PROFILE];

export function isFixtureProfile(value: string): value is FixtureProfileId {
  return Object.hasOwn(FIXTURE_PROFILES, value);
}

export function fixturePins(profile: FixtureProfileId = DEFAULT_FIXTURE_PROFILE): FixturePins {
  return FIXTURE_PROFILES[profile];
}

/**
 * Selects a fixture profile from `--fixture <id>` in argv (harnesses and the
 * fixture helper). Absent -> the default 26.1.2 profile. Unknown -> throws.
 */
export function fixtureProfileFromArgv(argv: readonly string[]): FixtureProfileId {
  const i = argv.indexOf('--fixture');
  if (i < 0) return DEFAULT_FIXTURE_PROFILE;
  const value = argv[i + 1] ?? '';
  if (!isFixtureProfile(value)) {
    throw new Error(`unknown fixture profile '${value}'; expected one of ${Object.keys(FIXTURE_PROFILES).join(', ')}`);
  }
  return value;
}

/** The fixture profile whose loopback endpoint and version exactly match a configuration, if any. */
export function fixtureProfileFor(host: string, port: number, version: string): FixturePins | undefined {
  return Object.values(FIXTURE_PROFILES).find((p) => p.host === host && p.port === port && p.minecraftVersion === version);
}

export function fixturePaths(root: string = PROJECT_ROOT, pins: FixturePins = FIXTURE_PINS) {
  const base = join(root, 'var', pins.varDir);
  return {
    base,
    downloads: join(base, 'downloads'),
    jreDir: join(base, 'jre'),
    java: join(base, 'jre', `${pins.jreRelease}-jre`, 'Contents', 'Home', 'bin', 'java'),
    serverDir: join(base, 'server'),
    serverJar: join(base, 'server', `server-${pins.minecraftVersion}.jar`),
    /** The inner jar the vanilla bundler unpacks on first start (used by version-data extraction). */
    innerJar: join(base, 'server', 'versions', pins.minecraftVersion, `server-${pins.minecraftVersion}.jar`),
    properties: join(base, 'server', 'server.properties'),
    pidFile: join(base, 'server.pid'),
    consoleLog: join(base, 'server', 'console.log'),
    latestLog: join(base, 'server', 'logs', 'latest.log'),
  };
}
