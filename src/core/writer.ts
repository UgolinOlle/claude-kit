/**
 * The only module that writes project files. Generators return FilePlans; the writer
 * decides per file whether to create, update, merge or ask — so re-running never clobbers edits.
 */
import { readText, resolveInside, sha256, writeAtomic } from "../utils/fsSafe.ts";
import { loadManifest, saveManifest, type Manifest } from "./manifest.ts";
import { mergeContent, type MergeStrategy } from "./merge.ts";

export interface FilePlan {
  /** Relative to project root, POSIX separators. */
  path: string;
  content: string;
  strategy: MergeStrategy;
  templateId: string;
  templateVersion: number;
}

export type Action = "create" | "update" | "merge" | "unchanged" | "conflict";

export interface Change {
  plan: FilePlan;
  action: Action;
  before: string | null;
  /** Content that will be written (for conflicts: the generated content on offer). */
  after: string;
  /** Whether `after` is pure generated output. */
  owned: boolean;
  reason: string;
}

export type Resolution = "keep" | "overwrite" | "new";
export type Resolver = (change: Change) => Promise<Resolution>;

export const keepAll: Resolver = async () => "keep";
export const overwriteAll: Resolver = async () => "overwrite";

export const NEW_SUFFIX = ".claude-kit.new";

export async function planChanges(root: string, plans: FilePlan[], manifest: Manifest): Promise<Change[]> {
  const changes: Change[] = [];
  for (const plan of plans) {
    const before = await readText(resolveInside(root, plan.path));
    const entry = manifest.files[plan.path];
    const base = { plan, before };

    if (before === null) {
      changes.push({ ...base, action: "create", after: plan.content, owned: true, reason: "new file" });
      continue;
    }

    if (plan.strategy === "seed") {
      changes.push({ ...base, action: "unchanged", after: before, owned: false, reason: "exists (yours after creation)" });
      continue;
    }

    const untouched = entry !== undefined && sha256(before) === entry.hash;

    if (untouched && entry.owned) {
      const same = before === plan.content;
      changes.push({ ...base, action: same ? "unchanged" : "update", after: plan.content, owned: true, reason: same ? "up to date" : "template changed, file not edited" });
      continue;
    }

    if (before === plan.content) {
      changes.push({ ...base, action: "unchanged", after: before, owned: true, reason: "already matches" });
      continue;
    }

    const why = entry ? "edited since last run" : "existing file not created by claude-kit";

    if (plan.strategy === "replace") {
      changes.push({ ...base, action: "conflict", after: plan.content, owned: true, reason: why });
      continue;
    }

    try {
      const merged = mergeContent(plan.strategy, before, plan.content, entry?.lastGenerated);
      changes.push({ ...base, action: merged === before ? "unchanged" : "merge", after: merged, owned: false, reason: `${why}; ${plan.strategy} merge` });
    } catch (err) {
      changes.push({ ...base, action: "conflict", after: plan.content, owned: true, reason: `${why}; merge failed: ${(err as Error).message}` });
    }
  }
  return changes;
}

export interface ApplyResult {
  written: string[];
  kept: string[];
  sidecars: string[];
  unchanged: string[];
}

function record(manifest: Manifest, plan: FilePlan, content: string, owned: boolean) {
  manifest.files[plan.path] = {
    templateId: plan.templateId,
    templateVersion: plan.templateVersion,
    hash: sha256(content),
    owned,
    ...(plan.strategy === "replace" || plan.strategy === "seed" ? {} : { lastGenerated: plan.content }),
  };
}

export async function applyChanges(
  root: string,
  changes: Change[],
  manifest: Manifest,
  resolve: Resolver,
): Promise<ApplyResult> {
  const result: ApplyResult = { written: [], kept: [], sidecars: [], unchanged: [] };

  for (const change of changes) {
    const { plan } = change;
    const abs = resolveInside(root, plan.path);

    if (change.action === "unchanged") {
      record(manifest, plan, change.after, change.owned);
      result.unchanged.push(plan.path);
      continue;
    }

    if (change.action === "conflict") {
      const choice = await resolve(change);
      if (choice === "keep") {
        result.kept.push(plan.path);
        continue;
      }
      if (choice === "new") {
        await writeAtomic(abs + NEW_SUFFIX, change.after);
        result.sidecars.push(plan.path + NEW_SUFFIX);
        continue;
      }
    }

    await writeAtomic(abs, change.after);
    record(manifest, plan, change.after, change.owned);
    result.written.push(plan.path);
  }
  return result;
}

export interface RunOptions {
  dryRun?: boolean;
  resolve?: Resolver;
}

/** Load manifest → plan → (apply → save manifest). With dryRun, nothing touches disk. */
export async function runPlans(root: string, plans: FilePlan[], opts: RunOptions = {}) {
  const manifest = await loadManifest(root);
  const changes = await planChanges(root, plans, manifest);
  if (opts.dryRun) return { changes, result: null };
  const result = await applyChanges(root, changes, manifest, opts.resolve ?? keepAll);
  await saveManifest(root, manifest);
  return { changes, result };
}
