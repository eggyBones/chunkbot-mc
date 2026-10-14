// PRIVATE packaging proposal. Shared release/manager contracts are coordinator-owned.
import { z } from 'zod';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.number().int().positive();
const label = z.string().min(1).max(160).regex(/^[a-zA-Z0-9_.: /+-]+$/);

export const FileIdentitySchema = z.strictObject({
  path: z.string().min(1).max(1024),
  size: z.number().int().min(0).max(64 * 1024 * 1024),
  sha256: digest,
  executable: z.boolean(),
});
export type FileIdentity = z.infer<typeof FileIdentitySchema>;

export const DataVersionsSchema = z.strictObject({
  checkpoint: version,
  session: version,
  memory: version.nullable(),
});
export type DataVersions = z.infer<typeof DataVersionsSchema>;

export const CompatibilitySchema = z.strictObject({
  node: z.strictObject({ major: z.literal(24), version: z.string().regex(/^24\.\d+\.\d+$/) }),
  platform: z.enum(['darwin', 'linux', 'win32']),
  arch: z.enum(['arm64', 'x64']),
  minecraft: z.array(z.union([
    z.strictObject({ version: z.literal('26.1.2'), protocol: z.literal(775), support: z.literal('upstream-tested') }),
    z.strictObject({ version: z.literal('26.2'), protocol: z.literal(776), support: z.literal('local-compat'), profile: z.literal('MB-SERVER-001') }),
  ])).length(2),
  dataVersions: DataVersionsSchema,
  planner: z.strictObject({ cliVersion: z.literal('0.160.0'), model: z.literal('gpt-6.1-sol'), effort: z.literal('low') }),
});
export type ArtifactCompatibility = z.infer<typeof CompatibilitySchema>;

const tree = z.strictObject({ sha256: digest, files: z.array(FileIdentitySchema).min(1).max(50_000) });
export const ArtifactManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  artifactSha256: digest,
  entryPoint: z.literal('dist/cli.js'),
  source: z.strictObject({ commit: z.string().regex(/^[a-f0-9]{40}$/), tree }),
  build: tree,
  dependencies: tree,
  data: tree,
  inputs: tree,
  compatibility: CompatibilitySchema,
  files: z.array(FileIdentitySchema).min(1).max(50_000),
});
export type ArtifactManifest = z.infer<typeof ArtifactManifestSchema>;

// An external trust input, NEVER read from an artifact's self-declaration.
// Its supply/authorization belongs to the coordinator and manager composition.
export const CoordinatorAcceptanceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  receiptId: label,
  acceptedBy: z.literal('coordinator'),
  artifactSha256: digest,
  acceptedAt: z.iso.datetime(),
  featureSummary: z.array(label).min(1).max(12),
  evidence: z.array(z.strictObject({ criterion: label, reference: label, sha256: digest, exitCode: z.literal(0) })).min(1).max(100),
});
export type CoordinatorAcceptance = z.infer<typeof CoordinatorAcceptanceSchema>;

export type ArtifactErrorCode = 'unsafe_path' | 'source_dirty' | 'build_incomplete' | 'dependency_mismatch' |
  'manifest_invalid' | 'artifact_incomplete' | 'artifact_tampered' | 'incompatible' | 'not_accepted' | 'output_exists' | 'io_error';

export class ArtifactError extends Error {
  readonly code: ArtifactErrorCode;
  constructor(code: ArtifactErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'ArtifactError';
  }
}

export interface PackageReleaseOptions {
  sourceDir: string;
  outputDir: string;
  // Coordinator-owned durable schema decisions; packaging does not guess them.
  dataVersions: DataVersions;
}

export interface VerifiedArtifact {
  directory: string;
  entryPoint: string;
  manifest: ArtifactManifest;
}

export interface PromotionPolicy {
  // Trusted external receipts. An empty list fails closed, even after tests pass.
  acceptedReceipts: readonly CoordinatorAcceptance[];
  requiredCriteria: readonly string[];
  minecraftVersion: '26.1.2' | '26.2';
  dataVersions: DataVersions;
}

export interface PromotableArtifact extends VerifiedArtifact {
  acceptance: CoordinatorAcceptance;
}
