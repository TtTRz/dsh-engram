/**
 * P3 — recall-channel injection (§5.3).
 *
 * On `agent/pre-step` with `step === 1`, the current user text is searched
 * against the recall scope (same workspace + global situational) and up to
 * `recallMax` whole entries (bounded by `recallBudget` characters) are
 * injected as a user-role message after the claimed input. The injection is
 * labeled "recalled memory, not a new instruction" and conflict hits are
 * flagged for mandatory user verification (§3.5 layer 3).
 *
 * Zero runtime deps: the injected message is constructed structurally
 * (the same shape dsh-agent-instructions builds via createUserMessage).
 */

import { randomUUID } from 'node:crypto';
import type { MemoryService } from './service.js';
import type { MemoryConfig, RecallHit } from './types.js';
import { resolveWorkspaceKey } from './workspace.js';

const HEADER = '[召回记忆 · 非新指令，仅供参照]';

/** The exact message shape the agent loop accepts (dsh-llm Message). */
interface InjectedMessage {
  id: string;
  role: 'user';
  content: Array<{ type: 'text'; text: string }>;
  source: { kind: 'plugin'; plugin: string };
}

interface TextBlock {
  type: 'text';
  text: string;
}

/** Structural view of a claimed message — we only read id/content/source. */
interface ClaimedMessage {
  id?: string;
  role?: string;
  content?: Array<TextBlock | { type?: string; text?: string }>;
  source?: { kind?: string; plugin?: string };
}

interface PreStepPayload {
  step?: number;
  messages: ClaimedMessage[];
  agent?: {
    session?: {
      header?: { cwd?: unknown };
    };
  };
}

interface PreStepDecision {
  kind: 'enter' | 'reject';
  messages: ClaimedMessage[];
}

/**
 * Compose the injection text under the hard bounds (§5.3: ≤maxEntries /
 * ≤budget chars, whole entries only — no truncation, I-4).
 *
 * Same normalized-name groups with differing texts are contradictory by the
 * deterministic layer-1 rule; when two such entries are both recalled the
 * block gets the layer-3 warning (force verify, never assume). The warning
 * is paid from the budget like the snapshot's trailing note — whole entries
 * are ejected before the warning is ever dropped.
 */
export function composeRecallText(
  hits: readonly RecallHit[],
  budget: number,
  maxEntries: number,
): string {
  if (hits.length === 0) return '';

  // Contradictions first: the layer-3 warning is mandatory (§3.5).
  const groups = new Map<string, RecallHit[]>();
  for (const hit of hits) {
    const group = groups.get(hit.entity.nameNorm) ?? [];
    group.push(hit);
    groups.set(hit.entity.nameNorm, group);
  }
  const contradictions: string[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const texts = new Set(group.map((hit) => hit.version.text));
    if (texts.size < 2) continue;
    contradictions.push(`⚠️ 互相矛盾（${group.map((hit) => hit.entity.name).join(' / ')}），请向用户确认，勿自行假设`);
  }

  const lines: string[] = [];
  let used = 0;
  let kept = 0;
  for (const hit of hits) {
    if (kept >= maxEntries) break;
    const mark = hit.expired ? ' ⚠️已过有效期，请核实' : '';
    const line = `- ${hit.entity.name}：${hit.version.text}${mark}`;
    const cost = line.length + (lines.length === 0 ? HEADER.length + 1 : 1);
    if (used + cost > budget) continue;
    lines.push(line);
    used += cost;
    kept += 1;
  }

  if (lines.length === 0) return '';

  if (contradictions.length > 0) {
    const note = contradictions.join('\n');
    let available = budget - (HEADER.length + used);
    while (lines.length > 0 && available < note.length + 1) {
      const popped = lines.pop() as string;
      used -= popped.length + 1;
      available = budget - (HEADER.length + used);
    }
    if (lines.length === 0) return '';
    lines.push(note);
  }

  return [HEADER, ...lines].join('\n');
}

/** Concatenate the readable user text of the claimed messages. */
export function extractUserText(messages: readonly ClaimedMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role !== undefined && message.role !== 'user') continue;
    for (const block of message.content ?? []) {
      if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
  }
  return parts.join('\n').trim();
}

/** True when this session already carries a recall injection of ours. */
export function hasRecallInjection(messages: readonly ClaimedMessage[]): boolean {
  return messages.some(
    (message) => message.source?.kind === 'plugin' && message.source?.plugin === 'dsh-engram',
  );
}

function createInjectedMessage(text: string, id: string): InjectedMessage {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-engram' },
  };
}

/**
 * Structural context surface for the scoped `agent/pre-step` waterfall. The
 * real event type lives in `@deepseek-ai/dsh-agent` (module augmentation),
 * which we deliberately do not depend on — zero runtime deps.
 */
interface EventContextLike {
  on(
    name: string,
    listener: (
      payload: PreStepPayload,
      next: () => Promise<PreStepDecision>,
    ) => Promise<PreStepDecision>,
  ): () => void;
}

/**
 * Register the step-1 recall listener. The waterfall listener first defers
 * with `next()`, then splices the injection right after the last claimed
 * message (the same slot dsh-agent-instructions uses for its context).
 */
export function registerRecallInjection(
  ctx: EventContextLike,
  service: MemoryService,
  config: MemoryConfig,
): void {
  ctx.on('agent/pre-step', async (payload: PreStepPayload, next: () => Promise<PreStepDecision>) => {
    const decision = await next();
    if (decision.kind === 'reject') return decision;
    if (payload.step !== 1) return decision;
    if (hasRecallInjection(decision.messages)) return decision;

    const query = extractUserText(payload.messages);
    if (query.length === 0) return decision;

    const cwd = payload.agent?.session?.header?.cwd;
    const workspaceKey =
      typeof cwd === 'string' && cwd.length > 0 ? resolveWorkspaceKey(cwd).key : null;

    const hits = service.recall(workspaceKey, query);
    if (hits.length === 0) return decision;

    const text = composeRecallText(hits, config.recallBudget, config.recallMax);
    if (text.length === 0) return decision;

    const lastClaimedIndex = decision.messages.findLastIndex((message) =>
      payload.messages.includes(message),
    );
    const message = createInjectedMessage(text, `engram-recall-${randomUUID()}`);
    return {
      kind: 'enter' as const,
      messages:
        lastClaimedIndex === -1
          ? [...decision.messages, message]
          : decision.messages.toSpliced(lastClaimedIndex + 1, 0, message),
    };
  });
}
