import * as p from "@clack/prompts";
import type { Change, Resolution, Resolver } from "../core/writer.ts";
import { NEW_SUFFIX } from "../core/writer.ts";
import { formatDiff } from "../utils/diff.ts";

/** Ask per conflicting file, showing the diff first. Ctrl-C keeps the file. */
export const interactiveResolver: Resolver = async (change: Change): Promise<Resolution> => {
  p.note(formatDiff(change.before ?? "", change.after), `${change.plan.path} — ${change.reason}`);
  const choice = await p.select<Resolution>({
    message: `How should claude-kit handle ${change.plan.path}?`,
    initialValue: "keep",
    options: [
      { value: "keep", label: "Keep my version", hint: "nothing is written" },
      { value: "new", label: `Write alongside as ${change.plan.path}${NEW_SUFFIX}`, hint: "compare and merge by hand" },
      { value: "overwrite", label: "Overwrite with generated version" },
    ],
  });
  return p.isCancel(choice) ? "keep" : choice;
};
