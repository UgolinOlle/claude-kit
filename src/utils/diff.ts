import { c } from "./logger.ts";

type Op = { kind: " " | "-" | "+"; line: string };

const MAX_CELLS = 4_000_000;

/** Line-level LCS diff. Falls back to "replace everything" for very large inputs. */
export function diffLines(before: string, after: string): Op[] {
  const a = before.split("\n");
  const b = after.split("\n");
  if (a.length * b.length > MAX_CELLS) {
    return [
      ...a.map((line) => ({ kind: "-" as const, line })),
      ...b.map((line) => ({ kind: "+" as const, line })),
    ];
  }
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j]
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i++]! });
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      ops.push({ kind: "-", line: a[i++]! });
    } else {
      ops.push({ kind: "+", line: b[j++]! });
    }
  }
  while (i < n) ops.push({ kind: "-", line: a[i++]! });
  while (j < m) ops.push({ kind: "+", line: b[j++]! });
  return ops;
}

/** Render a compact unified-style diff with `context` lines around each change. */
export function formatDiff(before: string, after: string, context = 3): string {
  const ops = diffLines(before, after);
  const keep: boolean[] = Array.from({ length: ops.length }, () => false);
  ops.forEach((op, idx) => {
    if (op.kind === " ") return;
    for (
      let k = Math.max(0, idx - context);
      k <= Math.min(ops.length - 1, idx + context);
      k++
    )
      keep[k] = true;
  });
  const out: string[] = [];
  let skipped = false;
  ops.forEach((op, idx) => {
    if (!keep[idx]) {
      if (!skipped) out.push(c.dim("…"));
      skipped = true;
      return;
    }
    skipped = false;
    const text = `${op.kind} ${op.line}`;
    out.push(
      op.kind === "+"
        ? c.green(text)
        : op.kind === "-"
          ? c.red(text)
          : c.dim(text),
    );
  });
  return out.join("\n");
}
