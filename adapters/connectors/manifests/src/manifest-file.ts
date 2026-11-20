import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CONNECTOR_ID,
  type ConnectorManifest,
  type EgressOptions,
  manifestProblems,
} from "@aep/domain";
import { z } from "zod";

// The file format of a connector manifest (`connectors/<id>/manifest.json`, PRD FR-16). Unknown
// keys are errors, so a misspelt field cannot silently drop a restriction.

const Name = z.string().min(1).max(200);

export const ConnectorManifestFile = z.strictObject({
  id: z.string().regex(CONNECTOR_ID),
  name: Name,
  description: z.string().min(1).max(2_000),
  servers: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/),
        label: Name,
        url: z.url(),
      }),
    )
    .min(1),
  auth: z.strictObject({
    type: z.literal("oauth2"),
    registration: z.enum(["dynamic", "manual"]),
    scopes: z.array(z.string().min(1).max(200)).min(1),
  }),
  tools: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[A-Za-z0-9_.-]{1,128}$/),
        class: z.enum(["read", "write"]),
      }),
    )
    .min(1),
  egressHosts: z.array(z.string().regex(/^[a-z0-9.-]{1,253}$/)).min(1),
  sources: z
    .array(
      z.strictObject({
        claim: z.string().min(1).max(500),
        url: z.url(),
        checkedOn: z.iso.date(),
      }),
    )
    .min(1),
}) satisfies z.ZodType<ConnectorManifest>;

export class ManifestError extends Error {
  readonly source: string;
  readonly problems: readonly string[];

  constructor(source: string, problems: readonly string[]) {
    super(`connector manifest ${source} is invalid: ${problems.join("; ")}`);
    this.name = "ManifestError";
    this.source = source;
    this.problems = problems;
  }
}

/** The manifest, or a ManifestError listing every problem found. */
export function parseConnectorManifest(
  json: unknown,
  source: string,
  options: EgressOptions,
): ConnectorManifest {
  const parsed = ConnectorManifestFile.safeParse(json);
  if (!parsed.success) {
    throw new ManifestError(
      source,
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }
  const problems = manifestProblems(parsed.data, options);
  if (problems.length > 0) throw new ManifestError(source, problems);
  return parsed.data;
}

/**
 * Reads `<dir>/<id>/manifest.json` for every subdirectory. The directory name must match the id,
 * and ids are unique. Any invalid manifest fails the whole load: the API and the worker refuse to
 * start rather than run with a connector half-declared.
 */
export async function loadConnectorManifests(
  dir: string,
  options: EgressOptions,
): Promise<ConnectorManifest[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const manifests: ConnectorManifest[] = [];
  for (const entry of entries
    .filter((e) => e.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const source = join(dir, entry.name, "manifest.json");
    let json: unknown;
    try {
      json = JSON.parse(await readFile(source, "utf8"));
    } catch (error) {
      throw new ManifestError(source, [error instanceof Error ? error.message : String(error)]);
    }
    const manifest = parseConnectorManifest(json, source, options);
    if (manifest.id !== entry.name) {
      throw new ManifestError(source, [
        `id ${manifest.id} does not match the directory ${entry.name}`,
      ]);
    }
    manifests.push(manifest);
  }
  return manifests;
}
