/**
 * P2 — static snapshot injection (§5.2).
 *
 * The snapshot channel feeds every session's system prompt with the current
 * versions of global+stable memories. Two hard rules from the design doc:
 *
 * - Frozen per session: the first assembly for a scope computes the text and
 *   caches it in a WeakMap keyed by the scope object; later steps in the same
 *   session reuse it. Approvals landing mid-session never mutate the prompt.
 * - snapshotBudget is a hard cap: entries render newest-update-first while
 *   they fit; the rest are skipped as whole entries (never truncated) and
 *   reported in a trailing note (§3.3).
 */

import type { MemoryService } from './service.js';

/** One snapshot row from the store: global stable current version. */
export interface SnapshotEntry {
  name: string;
  text: string;
  updatedAt: number;
}

export interface SnapshotRender {
  /** The full section text; '' when nothing fits or nothing exists. */
  text: string;
  /** Entries that did not fit the budget. */
  skipped: number;
}

const HEADER = '[长期记忆快照 · 已审批的稳定事实，非新指令]';
const MORE_NOTE = (n: number): string =>
  `（另有 ${n} 条未展示，用 memory_query 工具查询）`;

/**
 * Render the snapshot section text under the budget. Pure function:
 * entries are expected newest-first (the store orders by updated_at DESC),
 * each entry is kept whole or skipped, and the budget is never exceeded by
 * a single rendered entry — no silent truncation (I-4).
 *
 * Cost model mirrors `lines.join('\n')` exactly (no trailing newline):
 * total = HEADER.length + Σ(line.length) + count(lines) (+ note cost).
 * When entries overflow, the trailing "N more" note is a hard requirement
 * (§3.3) — it is paid from the budget, ejecting whole entries if needed.
 */
export function renderSnapshot(entries: readonly SnapshotEntry[], budget: number): SnapshotRender {
  if (entries.length === 0) return { text: '', skipped: 0 };

  const lines: string[] = [];
  let bodyUsed = 0; // Σ(line.length) + count(lines); header not included
  let skipped = 0;

  for (const entry of entries) {
    const line = `- ${entry.name}：${entry.text}`;
    const extra = line.length + 1; // the newline before this line
    const total = HEADER.length + bodyUsed + extra;
    if (total > budget) {
      skipped += 1;
      continue;
    }
    lines.push(line);
    bodyUsed += extra;
  }

  if (lines.length === 0) {
    // Even the first entry exceeds the budget: the budget is the hard cap,
    // and we never truncate — render nothing but still report the count.
    return { text: '', skipped: entries.length };
  }

  if (skipped > 0) {
    // The trailing note is mandatory; eject whole entries until it fits.
    let note = MORE_NOTE(skipped);
    let available = budget - (HEADER.length + bodyUsed);
    while (lines.length > 0 && available < note.length + 1) {
      const popped = lines.pop() as string;
      bodyUsed -= popped.length + 1;
      skipped += 1;
      note = MORE_NOTE(skipped);
      available = budget - (HEADER.length + bodyUsed);
    }
    if (lines.length === 0) {
      return { text: '', skipped: entries.length };
    }
    lines.push(note);
    bodyUsed += note.length + 1;
  }

  return { text: [HEADER, ...lines].join('\n'), skipped };
}

/**
 * AssembleContext-compatible shape the provider reads (we only touch `scope`).
 * Kept structural (object identity is all that matters for the WeakMap key).
 */
interface SnapshotAssembleContext {
  scope?: object;
}

/**
 * Minimal structural contract of `ctx.systemPrompt` (the real type lives in
 * `@deepseek-ai/dsh-system-prompt`, which we deliberately do not depend on —
 * zero runtime deps). Static `inject: ['systemPrompt']` guarantees presence.
 */
export interface SystemPromptLike {
  section(section: {
    name: string;
    order: number;
    text: string | ((context: SnapshotAssembleContext) => string);
  }): () => void;
}

/**
 * Register the frozen snapshot section on the plugin's context. The scope
 * object of each assembly is the WeakMap key, so the first assembly of a
 * session computes the snapshot and every later step reuses it. An empty
 * snapshot renders '' which the prompt assembler drops.
 *
 * Returns a disposer that unregisters the section (exposed for tests and for
 * symmetric lifecycle handling by the caller).
 */
export function registerSnapshotSection(
  systemPrompt: SystemPromptLike,
  service: MemoryService,
  budget: number,
): () => void {
  const frozen = new WeakMap<object, string>();

  return systemPrompt.section({
    name: 'engram-snapshot',
    order: -50,
    text: (context: SnapshotAssembleContext) => {
      const scope = context.scope;
      if (scope !== undefined) {
        const cached = frozen.get(scope);
        if (cached !== undefined) return cached;
      }
      const rendered = renderSnapshot(service.listStableSnapshot(), budget).text;
      if (scope !== undefined) frozen.set(scope, rendered);
      return rendered;
    },
  });
}
