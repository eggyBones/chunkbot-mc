// Microsoft authentication for the BOT's own Minecraft account.
//
// - Tokens are cached under the ignored data directory (never the user's
//   Minecraft folder, which is the library default).
// - Connecting never starts an interactive device-code sign-in. If no valid
//   cached session exists, the connection fails with `auth_required` and tells
//   the operator to run the explicit `auth login` command.
// - There is no automatic downgrade to offline auth.
// - The signed-in profile must differ from the owner's identity.
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import prismarineAuth from 'prismarine-auth';
import { normalizeUuid } from '../config/schema.ts';

const { Authflow, Titles } = prismarineAuth;

/** Matches minecraft-protocol's defaults so the login cache is reused by the connection. */
export const AUTH_FLOW_OPTIONS = {
  authTitle: Titles.MinecraftNintendoSwitch,
  deviceType: 'Nintendo',
  flow: 'live',
} as const;

export class MicrosoftSignInRequiredError extends Error {
  constructor() {
    super('Microsoft sign-in is required for the bot account; run `npm run chunkbot -- auth login` first (no automatic sign-in)');
    this.name = 'MicrosoftSignInRequiredError';
  }
}

export class IdentityConflictError extends Error {
  constructor() {
    super("the signed-in bot profile is the owner's own identity; Chunkbot must use a separate Minecraft account");
    this.name = 'IdentityConflictError';
  }
}

export interface BotProfile {
  name: string;
  uuid: string;
}

export interface DeviceCodePrompt {
  verificationUri: string;
  userCode: string;
  message: string;
}

type AuthflowLike = {
  getMinecraftJavaToken(options: { fetchProfile: boolean }): Promise<{ profile?: { id: string; name: string } | null }>;
};

export type AuthflowFactory = (
  username: string,
  cacheDir: string,
  onCode: (prompt: DeviceCodePrompt) => void,
) => AuthflowLike;

export const defaultAuthflowFactory: AuthflowFactory = (username, cacheDir, onCode) =>
  new Authflow(username, cacheDir, { ...AUTH_FLOW_OPTIONS }, (res) =>
    onCode({ verificationUri: res.verification_uri, userCode: res.user_code, message: res.message }),
  );

function profileFrom(result: { profile?: { id: string; name: string } | null }): BotProfile {
  if (!result.profile?.id || !result.profile.name) {
    throw new Error('the Microsoft account has no Minecraft Java profile (does it own Java Edition?)');
  }
  return { name: result.profile.name, uuid: normalizeUuid(result.profile.id) };
}

/**
 * Non-interactive: uses cached/refreshable tokens only. Throws
 * MicrosoftSignInRequiredError instead of starting a device-code flow.
 */
export async function resolveCachedBotProfile(
  username: string,
  cacheDir: string,
  ownerUuid: string | undefined,
  factory: AuthflowFactory = defaultAuthflowFactory,
): Promise<BotProfile> {
  const flow = factory(username, cacheDir, () => {
    throw new MicrosoftSignInRequiredError();
  });
  const profile = profileFrom(await flow.getMinecraftJavaToken({ fetchProfile: true }));
  if (ownerUuid && profile.uuid === normalizeUuid(ownerUuid)) throw new IdentityConflictError();
  return profile;
}

/** Explicit, operator-initiated device-code sign-in for the bot account. */
export async function interactiveBotLogin(
  username: string,
  cacheDir: string,
  ownerUuid: string | undefined,
  showPrompt: (prompt: DeviceCodePrompt) => void,
  factory: AuthflowFactory = defaultAuthflowFactory,
): Promise<BotProfile> {
  const flow = factory(username, cacheDir, showPrompt);
  const profile = profileFrom(await flow.getMinecraftJavaToken({ fetchProfile: true }));
  if (ownerUuid && profile.uuid === normalizeUuid(ownerUuid)) throw new IdentityConflictError();
  return profile;
}

/** Read-only check used by doctor: does a token cache exist for this bot label? */
export function hasMicrosoftTokenCache(username: string, cacheDir: string): boolean {
  const hash = createHash('sha1').update(username ?? '', 'binary').digest('hex').slice(0, 6);
  return ['live', 'xbl', 'mca'].every((name) => existsSync(join(cacheDir, `${hash}_${name}-cache.json`)));
}
