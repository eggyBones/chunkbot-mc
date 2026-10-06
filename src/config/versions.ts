// Version compatibility derived from the INSTALLED protocol stack rather than a
// README range. Two support levels exist and are always reported separately:
//
//   - upstream-tested: minecraft-data has the version's data AND the released
//     Mineflayer lists its major version as tested (26.1.x, protocol 775);
//   - local compatibility (MB-SERVER-001): exactly Minecraft 26.2 (protocol
//     776) through the vendored, integrity-pinned stack built by
//     scripts/vendor-compat.ts. It is admitted ONLY when every vendored package
//     is installed at its recorded build and carries the compatibility marker,
//     so a clean install of anything else fails closed. Mineflayer's own
//     testedVersions is extended by that local build; that entry is excluded
//     from "upstream-tested" and is never reported as Mineflayer testing.
import { createRequire } from 'node:module';
import minecraftData from 'minecraft-data';
import mineflayer from 'mineflayer';

const require = createRequire(import.meta.url);

export const PINNED_PACKAGES = ['mineflayer', 'minecraft-protocol', 'minecraft-data', 'prismarine-auth', 'zod'] as const;

/** The locally verified 26.2 compatibility profile and the vendored builds it requires. */
export const LOCAL_COMPAT_PROFILE = {
  id: 'MB-SERVER-001',
  minecraftVersion: '26.2',
  protocolVersion: 776,
  packages: {
    'minecraft-data': '3.117.0+chunkbot.26.2.1',
    'prismarine-chunk': '1.41.0+chunkbot.26.2.1',
    'prismarine-physics': '1.11.1+chunkbot.26.2.1',
    mineflayer: '4.39.0+chunkbot.26.2.1',
  },
} as const;

export type SupportLevel = 'upstream-tested' | 'local-compat';

export function installedPackageVersion(name: string): string | undefined {
  try {
    const pkg = require(`${name}/package.json`) as { version?: string };
    return pkg.version;
  } catch {
    return undefined;
  }
}

function compatMarker(name: string): { id?: string; profile?: string } | undefined {
  try {
    return (require(`${name}/package.json`) as { chunkbotCompat?: { id?: string; profile?: string } }).chunkbotCompat;
  } catch {
    return undefined;
  }
}

/** Mineflayer's testedVersions as installed (may include a locally admitted entry). */
export function testedMinecraftVersions(): string[] {
  const tested = (mineflayer as unknown as { testedVersions?: unknown }).testedVersions;
  return Array.isArray(tested) ? tested.filter((v): v is string => typeof v === 'string') : [];
}

/** Versions the RELEASED Mineflayer tested: the installed list minus any locally admitted profile. */
export function upstreamTestedVersions(): string[] {
  const local = compatMarker('mineflayer')?.profile;
  return testedMinecraftVersions().filter((v) => v !== local);
}

export interface VersionProfile {
  requested: string;
  dataVersion: string;
  majorVersion: string;
  protocolVersion: number;
}

export function resolveVersionProfile(version: string): VersionProfile | undefined {
  const data = minecraftData(version);
  const { minecraftVersion, majorVersion, version: protocolVersion } = data?.version ?? {};
  if (!minecraftVersion || !majorVersion || typeof protocolVersion !== 'number') return undefined;
  return { requested: version, dataVersion: minecraftVersion, majorVersion, protocolVersion };
}

/** Problem with the installed local compatibility stack, or undefined when it is exactly the recorded build. */
export function localCompatProblem(): string | undefined {
  for (const [name, want] of Object.entries(LOCAL_COMPAT_PROFILE.packages)) {
    const got = installedPackageVersion(name);
    const marker = compatMarker(name);
    if (got !== want || marker?.id !== LOCAL_COMPAT_PROFILE.id || marker.profile !== LOCAL_COMPAT_PROFILE.minecraftVersion) {
      return `local ${LOCAL_COMPAT_PROFILE.minecraftVersion} compatibility stack (${LOCAL_COMPAT_PROFILE.id}) requires ${name}@${want}; installed ${got ?? 'missing'}${marker ? '' : ' without the compatibility marker'} (run npm ci with the vendored lockfile)`;
    }
  }
  return undefined;
}

/** Support level for an exact version, or undefined when unsupported. */
export function supportLevel(version: string): SupportLevel | undefined {
  const profile = resolveVersionProfile(version);
  if (!profile) return undefined;
  const testedMajors = new Set(upstreamTestedVersions().map((v) => resolveVersionProfile(v)?.majorVersion ?? v));
  if (testedMajors.has(profile.majorVersion)) return 'upstream-tested';
  if (
    version === LOCAL_COMPAT_PROFILE.minecraftVersion &&
    profile.dataVersion === LOCAL_COMPAT_PROFILE.minecraftVersion &&
    profile.protocolVersion === LOCAL_COMPAT_PROFILE.protocolVersion &&
    !localCompatProblem()
  ) {
    return 'local-compat';
  }
  return undefined;
}

/** Human-readable support description for doctor/status. */
export function supportDescription(version: string): string {
  const level = supportLevel(version);
  if (level === 'upstream-tested') {
    const installed = installedPackageVersion('mineflayer') ?? '?';
    const base = installed.split('+')[0];
    return `upstream-tested by the released Mineflayer ${base}${base !== installed ? ` (installed as local build ${installed}; its upstream testedVersions are unchanged for this release)` : ''}`;
  }
  if (level === 'local-compat') {
    return `LOCAL compatibility profile ${LOCAL_COMPAT_PROFILE.id} (vendored, integrity-pinned 26.2 stack verified against official 26.2 reports and the local 26.2 fixture; NOT an upstream release and NOT Mineflayer-tested)`;
  }
  return checkVersionSupport(version) ?? 'unsupported';
}

/** Returns a problem description, or undefined when the version is supported. */
export function checkVersionSupport(version: string): string | undefined {
  const profile = resolveVersionProfile(version);
  const upstream = upstreamTestedVersions();
  const newest = upstream.at(-1) ?? 'unknown';
  if (!profile) {
    return `version ${version} has no data in the installed minecraft-data ${installedPackageVersion('minecraft-data') ?? '?'}; newest upstream Mineflayer-tested version is ${newest}${version.startsWith(`${LOCAL_COMPAT_PROFILE.minecraftVersion}.`) ? `; the local compatibility profile admits exactly ${LOCAL_COMPAT_PROFILE.minecraftVersion}` : ''}`;
  }
  if (supportLevel(version)) return undefined;
  if (version === LOCAL_COMPAT_PROFILE.minecraftVersion) {
    return localCompatProblem() ?? `version ${version} does not match the local compatibility profile (protocol ${profile.protocolVersion})`;
  }
  return `version ${version} (protocol ${profile.protocolVersion}) is not in the released Mineflayer ${installedPackageVersion('mineflayer') ?? '?'}'s tested versions (newest ${newest}) and is not the local ${LOCAL_COMPAT_PROFILE.minecraftVersion} compatibility profile`;
}
