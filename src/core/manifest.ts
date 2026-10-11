import { join } from 'node:path';

import pkg from '../../package.json' with { type: 'json' };
import { readJson, writeAtomic } from '../utils/fsSafe.ts';

export const MANIFEST_PATH = '.claude-kit/manifest.json';
export const MANIFEST_SCHEMA = 1;

export interface ManifestEntry {
  templateId: string;
  templateVersion: number;
  /** sha256 of the content claude-kit last wrote. A mismatch on disk means the user edited it. */
  hash: string;
  /**
   * True when the file is 100% generated output. Only owned + unedited files may be
   * regenerated wholesale; anything else is merged so user content survives.
   */
  owned: boolean;
  /**
   * What claude-kit generated last time (merge strategies only). This is the "base" of a
   * 3-way merge, so user deletions stick and dropped template content is cleaned up.
   */
  lastGenerated?: string;
}

export interface Manifest {
  schema: number;
  cliVersion: string;
  preset?: string;
  /** Features enabled by the last init, so `sync` can re-run non-interactively. */
  features?: string[];
  files: Record<string, ManifestEntry>;
}

export function emptyManifest(): Manifest {
  return { schema: MANIFEST_SCHEMA, cliVersion: pkg.version, files: {} };
}

export async function loadManifest(root: string): Promise<Manifest> {
  const data = await readJson<Manifest>(join(root, MANIFEST_PATH));
  if (!data || typeof data.files !== 'object') return emptyManifest();
  if (data.schema > MANIFEST_SCHEMA) {
    throw new Error(
      `${MANIFEST_PATH} was written by a newer claude-kit (schema ${data.schema}). Upgrade claude-kit to continue.`,
    );
  }
  return data;
}

export async function saveManifest(root: string, manifest: Manifest): Promise<void> {
  const sorted = Object.fromEntries(
    Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b)),
  );
  const out: Manifest = { ...manifest, cliVersion: pkg.version, files: sorted };
  await writeAtomic(join(root, MANIFEST_PATH), JSON.stringify(out, null, 2) + '\n');
}
