# claude-kit

Make any repo cheap and effective to work on with Claude Code: a lean `CLAUDE.md`, enforced read exclusions, and edit guardrails, generated from what's actually in your project.

```bash
npx claude-kit init          # or: bunx claude-kit init
```

## What `init` sets up (minimal preset)

| File | Purpose |
|---|---|
| `.claudeignore` | Paths Claude shouldn't read: build output, caches, lockfiles, secrets, plus your `.gitignore`. |
| `.claude/settings.json` | `permissions.deny` `Read(...)` rules compiled from `.claudeignore` (Claude Code doesn't read `.claudeignore` itself), plus the hook registration. |
| `CLAUDE.md` | Short skeleton: stack, commands, workflow habits, guardrails. Filled in from your manifests. |
| `.claude/hooks/pre-edit.cjs` | `PreToolUse` hook that blocks edits to lockfiles, build output and `.env*`, and tells Claude why. |
| `.claude-kit/manifest.json` | What claude-kit generated, so re-runs never clobber your edits. Commit it. |

### `--preset standard` adds

| File | Purpose |
|---|---|
| `.claude/context/task_context.md` | Current task state Claude keeps up to date; re-injected after compaction by a `SessionStart` hook. |
| `.claude/hooks/context-snapshot.cjs` | Saves each compaction summary to `.claude/context/snapshots/` (git-ignored, last 10 kept). |
| `.claude/context/conversation_memory.md` | Team-shared decisions and lessons, read on demand (never `@imported`, so it can't break caching). |
| `docs/` | `architecture.md` (pre-filled from the repo layout), `api-contracts.md`, `data-models.md`, `debugging.md`. Created once, then yours. |
| `"model": "opusplan"` | Opus in Plan Mode, Sonnet for execution. The cheatsheet sits in a CLAUDE.md HTML comment, which costs no tokens. |

### `--preset full` adds

| File | Purpose |
|---|---|
| `.claude/agents/` | `explorer` (Haiku, read-only search), `reviewer`, `test-writer`. Only their descriptions cost main-context tokens. |
| `.claude/statusline/token-budget.cjs` | Status line: context %, prompt-cache hit ratio, cost; optional `CLAUDE_KIT_BUDGET_USD`. |
| `docs/INDEX.md` | Only for repos over ~200K tokens: a regenerated map of areas and largest files. |
| CLAUDE.md pointer to `claude-kit compress` | So Claude outlines big files instead of reading them whole. |

Supported stacks: Node/Bun (npm, pnpm, yarn, bun), Python (uv, poetry, pipenv, pip), Go, Rust, and their monorepo setups.

## Safe to re-run

- Files you haven't touched are updated when templates change.
- `CLAUDE.md` only changes inside `<!-- claude-kit:begin … -->` regions; everything else is yours.
- JSON and ignore files are 3-way merged: your additions stay, lines you delete stay deleted.
- Files that can't be merged ask first: keep, overwrite, or write a `.claude-kit.new` copy.

## Commands

```
claude-kit init [--preset minimal|standard|full] [--with f] [--without f]
claude-kit sync        # re-apply the recorded setup, e.g. after editing .claudeignore
claude-kit doctor      # audit an existing setup: score + prioritized findings
claude-kit doctor --fix
claude-kit context     # tokens a cold session loads from the repo and ~/.claude
claude-kit context --json > before.json   # …later: claude-kit context --baseline before.json
claude-kit context --exact                # real counts via the Anthropic token-counting API (sends file text)
claude-kit upgrade     # re-apply this version's templates; `npx claude-kit@latest upgrade` for newer ones
claude-kit compress [--outline] <path…>   # strip comments/blank lines, or list declarations with line numbers
claude-kit add mcp <name>                 # MCP server stub in mcp/<name>/ + .mcp.json entry
claude-kit detect      # detected stacks, monorepo layout, repo size
```

Global flags: `--dry-run`, `--yes`, `--force`, `--json`, `--verbose`, `--cwd <dir>`.

### What `doctor` checks

| Rule | Severity |
|---|---|
| `.claudeignore` patterns with no matching `permissions.deny` rule (Claude Code doesn't read the file) | error |
| CLAUDE.md / rules over 200 lines (warn) or 500 lines (error); HTML comments don't count, they're stripped before loading | warn / error |
| `.claude/settings.json` isn't valid JSON | error |
| No read exclusions, no CLAUDE.md | warn |
| Dates or "last updated" markers in always-loaded files; `@imports` of files that change between sessions (prompt-cache breakers) | warn |
| `@imports` pointing at missing files; auto memory `MEMORY.md` past its 200-line load limit | warn |
| No Edit/Write guard hook; `.gitignore` patterns missing from `.claudeignore`; large unscoped rules; oversized docs; MCP servers; repos far larger than the context window | info |

The score starts at 100: −25 per error, −10 per warning. Suggestions are free.

Tune it in `.claude-kit/config.json` (hand-written, never generated):

```json
{
  "rules": { "cache/volatile-content": "info", "mcp/servers": "off" },
  "exclude": ["tests/fixtures/**"]
}
```

### CI

```yaml
# .github/workflows/claude-kit.yml
on: pull_request
jobs:
  claude-kit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npx claude-kit doctor --check --format github   # add --fail-on warn to be strict
```

## Stack packs

Built in: node, python, go, rust. Add others in `.claude-kit/config.json`:

```json
{ "packs": ["claude-kit-pack-elixir", "./tools/my-pack.mjs"] }
```

A pack is an ES module (an installed package or a relative path) whose default export looks like this:

```js
export default {
  id: "elixir",
  label: (stack) => "Elixir",
  detect: (root) => (existsSync(join(root, "mix.exs")) ? { manager: "mix", evidence: ["mix.exs"] } : null),
  ignore: ["_build/", "deps/"],                                   // → .claudeignore + deny rules
  protectedPaths: [{ pattern: "mix.lock", reason: "run mix deps.get instead" }], // → edit guard
  commands: (stack, ctx) => [{ label: "test", cmd: "mix test" }], // → CLAUDE.md
};
```

Packs run as code when claude-kit loads them, so they're only ever read from the project's own config.

## Development

```bash
bun install
bun test
bun run typecheck
bun index.ts detect
bun scripts/build-release.ts --current   # npm layout for this platform in release/npm
bun scripts/publish-release.ts --dry-run
```

### Releasing

1. Bump `version` in package.json and commit.
2. `git tag v<version> && git push origin v<version>`.
3. `.github/workflows/release.yml` tests, cross-compiles all five binaries, smoke-tests each on its own OS (direct run + install through the npm launcher), then publishes the platform packages and `claude-kit` with provenance.

Needs an `NPM_TOKEN` secret in a GitHub environment named `npm`, and the `@claude-kit` npm organization.
