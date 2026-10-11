import * as p from '@clack/prompts';

import type { Preset } from '../core/presets.ts';

export async function askPreset(initial: Preset = 'minimal'): Promise<Preset | null> {
  const choice = await p.select<Preset>({
    message: 'Which setup do you want?',
    initialValue: initial,
    options: [
      {
        value: 'minimal',
        label: 'minimal',
        hint: '.claudeignore + deny rules, lean CLAUDE.md, edit guardrails',
      },
      {
        value: 'standard',
        label: 'standard',
        hint: '+ context snapshots, memory, docs/ tree, model tiering',
      },
      {
        value: 'full',
        label: 'full',
        hint: '+ subagents, token budget statusline, compression, RAG if large',
      },
    ],
  });
  return p.isCancel(choice) ? null : choice;
}

export async function confirmApply(count: number): Promise<boolean> {
  const ok = await p.confirm({
    message: `Apply ${count} change${count === 1 ? '' : 's'}?`,
    initialValue: true,
  });
  return ok === true;
}
