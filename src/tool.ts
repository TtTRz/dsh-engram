/**
 * Model-facing memory tools (§6).
 *
 * P0: `memory_propose` / `memory_query`.
 * P4: evidence resolution wired into propose, plus `memory_history`,
 * `memory_expand` (honest level-two degradation), and `memory_rollback`
 * (restore proposals go through the same approval gate).
 */

import type { Context } from '@deepseek-ai/cordis';
import type { MemoryService } from './service.js';
import type { ProposeInput } from './service.js';
import { resolveEvidence, readCitation } from './evidence.js';
import type { SessionLike } from './evidence.js';
import { resolveWorkspaceKey } from './workspace.js';
import { DEFAULT_CONFIG } from './types.js';
import type { MemoryConfig, Citation, MemoryVersion, FoldedNode } from './types.js';
import { normalize } from './normalize.js';

export { DEFAULT_CONFIG };

export interface ToolDeps {
  ctx: Context;
  service: MemoryService;
  config: MemoryConfig;
  /** Track this session's proposed pending ids for pending-self visibility (N3). */
  sessionPendings: Set<string>;
}

/**
 * ToolRunContext as handed to `execute` by the tools registry: the agent on
 * whose behalf the call runs, with its session header cwd — the canonical
 * workspace anchor (same source dsh-tool-bash uses: `exec.agent?.session.header.cwd`).
 */
export interface ToolExecLike {
  agent?: {
    session?: {
      id?: string;
      header?: { cwd?: unknown };
      events?: ReadonlyArray<{ type: string; seq: number; data?: unknown }>;
    };
  };
}

function workspaceKeyForExec(exec: ToolExecLike | undefined): string | null {
  const cwd = exec?.agent?.session?.header?.cwd;
  if (typeof cwd === 'string' && cwd.length > 0) return resolveWorkspaceKey(cwd).key;
  return null;
}

/**
 * M-1 (N3): pending-self visibility is PER SESSION. A process-level Set would
 * leak one session's proposals into another session's query results; the
 * WeakMap keys on the live session object so the tracking dies with it.
 */
const sessionPendingsBySession = new WeakMap<object, Set<string>>();

function pendingsFor(exec: ToolExecLike | undefined, sharedFallback: Set<string>): Set<string> {
  const session = exec?.agent?.session;
  if (session === undefined) return sharedFallback;
  let set = sessionPendingsBySession.get(session);
  if (set === undefined) {
    set = new Set<string>();
    sessionPendingsBySession.set(session, set);
  }
  return set;
}

function sessionOfExec(exec: ToolExecLike | undefined): SessionLike | undefined {
  const session = exec?.agent?.session;
  if (session === undefined || !Array.isArray(session.events)) return undefined;
  return { id: session.id, events: session.events };
}

// ---------------------------------------------------------------------------
// Tool definitions (registered through ctx.tools in index.ts)
// ---------------------------------------------------------------------------

export function registerMemoryTools(deps: ToolDeps): void {
  const tools = deps.ctx.get('tools') as
    | {
        register(def: unknown): () => void;
      }
    | undefined;
  if (tools === undefined) return;

  // NOTE: `tools.register()` stores definitions verbatim and the wire
  // projection passes `parameters` through unchanged — first-party tools rely
  // on `defineTool` to compile the author shorthand into an object-rooted
  // JSON Schema. We register raw defs (keeping zero runtime deps), so the
  // schemas below MUST be pre-compiled: root `type: 'object'`, `required` as
  // a root array. The shorthand form reaches the gateway with a null root
  // type and the whole turn fails schema validation.
  const proposeSchema = {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Memory topic anchor (e.g. "部署端口").' },
      text: { type: 'string', description: 'The memory content to persist.' },
      track: {
        type: 'string',
        description: 'Who produced this: "user" or "agent".',
      },
      scope: {
        type: 'string',
        description: '"global" or "workspace".',
      },
      kind_suggestion: {
        type: 'string',
        description: 'Optional "stable" or "situational" hint; the approver has the final say.',
      },
      action: {
        type: 'string',
        description:
          'Optional version-chain action: "refine", "contradict", "merge", "archive", "restore". Defaults to attaching to an existing same-name entity, or creating a new one.',
      },
      reason: {
        type: 'string',
        description: 'Optional one-line why for this proposal (kept with the version).',
      },
      citations: {
        type: 'array',
        description:
          'Optional evidence pointers: message seq ranges in THIS session that the memory is grounded in. The system reads the original text back; unreachable pointers are kept as-is and marked heuristic.',
        items: {
          type: 'object',
          properties: {
            start_seq: { type: 'number', description: 'First session event seq of the supporting passage.' },
            end_seq: { type: 'number', description: 'Last session event seq of the supporting passage.' },
            excerpt: { type: 'string', description: 'Verbatim quote of the key sentence (anchor, not machine evidence).' },
          },
        },
      },
    },
    required: ['name', 'text', 'track', 'scope'],
  } as const;

  const proposeDef = {
    name: 'memory_propose',
    description:
      'Propose a memory entry for panel approval. Writes are NOT effective until a human approves; returns a pending id and any conflict candidates.',
    parameters: proposeSchema,
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
    },
    execute: async (
      args: {
        name: string;
        text: string;
        track: 'user' | 'agent';
        scope: 'global' | 'workspace';
        kind_suggestion?: 'stable' | 'situational';
        action?: ProposeInput['action'];
        reason?: string;
        citations?: Array<{ start_seq?: number; end_seq?: number; excerpt?: string }>;
      },
      exec?: ToolExecLike,
    ) => {
      const wk = workspaceKeyForExec(exec);
      const session = sessionOfExec(exec);

      // §4 evidence resolution: A explicit excerpt / B read-back from the
      // live log / C bare pointers kept (origin resolves to heuristic).
      let evidence: Citation[] | undefined;
      if (args.citations !== undefined && args.citations.length > 0) {
        const sessionId = session?.id ?? '';
        const citations: Citation[] = args.citations.map((citation) => ({
          sessionId,
          startSeq: citation.start_seq ?? 0,
          endSeq: citation.end_seq ?? citation.start_seq ?? 0,
          ...(citation.excerpt !== undefined && citation.excerpt.length > 0
            ? { excerpt: citation.excerpt }
            : {}),
        }));
        evidence = resolveEvidence(citations, session).evidence;
      }

      const input: ProposeInput = {
        name: args.name,
        text: args.text,
        track: args.track,
        scope: args.scope,
        ...(args.kind_suggestion !== undefined ? { kindSuggestion: args.kind_suggestion } : {}),
        ...(args.action !== undefined ? { action: args.action } : {}),
        ...(args.reason !== undefined && args.reason.length > 0 ? { reason: args.reason } : {}),
        ...(evidence !== undefined && evidence.length > 0 ? { evidence } : {}),
      };
      const result = deps.service.propose(input, wk);
      pendingsFor(exec, deps.sessionPendings).add(result.pendingId);
      return result.message;
    },
  };

  const querySchema = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Text to search memory by.' },
    },
    required: ['query'],
  } as const;

  const queryDef = {
    name: 'memory_query',
    description:
      'Search approved memories and your own pending proposals. Returns active memories (with scope) and explicitly-flagged pending-self items.',
    parameters: querySchema,
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
    },
    execute: async (args: { query: string }, exec?: ToolExecLike) => {
      const wk = workspaceKeyForExec(exec);
      const hits = deps.service.query(wk, args.query, pendingsFor(exec, deps.sessionPendings));
      if (hits.length === 0) return '（无匹配记忆）';
      const lines = hits.map((hit) => {
        if (hit.source === 'active') {
          return `[active] ${hit.entity.name}（${hit.entity.scope}/${hit.entity.kind}）：${hit.version.text}`;
        }
        return `[pending-self 待审批] ${hit.pending.name}：${hit.pending.text}`;
      });
      return lines.join('\n');
    },
  };

  const historySchema = {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Topic anchor of the memory entity (e.g. "部署端口").' },
    },
    required: ['name'],
  } as const;

  const historyDef = {
    name: 'memory_history',
    description:
      "Show one memory's bounded version chain: a folded summary of older versions, the kept recent versions, and the current one. Use before refining or rolling back.",
    parameters: historySchema,
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
    },
    execute: async (args: { name: string }, exec?: ToolExecLike) => {
      const wk = workspaceKeyForExec(exec);
      const { text: nameNorm } = normalize(args.name);
      const entity = deps.service.findEntityByName(nameNorm, wk);
      if (entity === null) return `（没有名为「${args.name}」的记忆）`;
      const chain = deps.service.getVersionChain(entity.id);
      const current = chain[chain.length - 1] as MemoryVersion;
      const lines: string[] = [
        `「${entity.name}」版本链（${entity.scope}/${entity.kind}，当前 rev ${entity.currentRev}）：`,
      ];
      for (const node of chain) {
        if ((node as FoldedNode).type === 'folded') {
          const folded = node as FoldedNode;
          const stats = Object.entries(folded.stats)
            .map(([kind, count]) => `${kind}×${count}`)
            .join(' ');
          lines.push(
            `[folded rev${folded.rangeFrom}–${folded.rangeTo} · ${stats} · ${folded.citations.length} 条依据指针] ` +
              folded.summaries.map((s) => `rev${s.rev}: ${s.summary}`).join(' / '),
          );
        } else {
          const version = node as MemoryVersion;
          const isCurrent = version.rev === current?.rev;
          const evidenceNote =
            version.evidence.length > 0
              ? ` · 依据 ${version.evidence.length} 条（origin=${version.origin}）`
              : ' · 无原文依据';
          lines.push(
            `rev${version.rev} [${version.kind}]${isCurrent ? '（当前）' : ''}：${version.text.slice(0, 120)}${evidenceNote}`,
          );
        }
      }
      return lines.join('\n');
    },
  };

  const expandSchema = {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Topic anchor of the memory entity.' },
      rev: { type: 'number', description: 'Version number to expand; defaults to the current one.' },
    },
    required: ['name'],
  } as const;

  const expandDef = {
    name: 'memory_expand',
    description:
      "Expand one memory version's evidence: reads the original session passage back when the log is reachable, and otherwise explicitly degrades to the stored excerpt snapshot.",
    parameters: expandSchema,
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
    },
    execute: async (args: { name: string; rev?: number }, exec?: ToolExecLike) => {
      const wk = workspaceKeyForExec(exec);
      const session = sessionOfExec(exec);
      const { text: nameNorm } = normalize(args.name);
      const entity = deps.service.findEntityByName(nameNorm, wk);
      if (entity === null) return `（没有名为「${args.name}」的记忆）`;
      const rev = args.rev ?? entity.currentRev;
      const version = deps.service.getVersion(entity.id, rev);
      if (version === null) return `（rev ${rev} 不存在；当前 rev ${entity.currentRev}）`;
      if (version.evidence.length === 0) {
        return `rev${rev} 无原文依据（origin=${version.origin}）：该记忆来自跨会话综合判断或未附引用。`;
      }
      const lines: string[] = [`「${entity.name}」rev${rev} 的依据：`];
      for (const [index, citation] of version.evidence.entries()) {
        const read = readCitation(citation, session);
        if (read === null) {
          lines.push(
            `#${index + 1} session ${citation.sessionId} seq${citation.startSeq}–${citation.endSeq}：日志不可达且无快照，无法展开。`,
          );
          continue;
        }
        lines.push(
          read.degraded
            ? `#${index + 1}（原始日志不可达，显示快照片段）：\n${read.text}`
            : `#${index + 1}（回读原文 session ${citation.sessionId}）：\n${read.text}`,
        );
      }
      return lines.join('\n');
    },
  };

  const rollbackSchema = {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Topic anchor of the memory entity.' },
      rev: { type: 'number', description: 'Target version to restore.' },
      reason: { type: 'string', description: 'Why this restore is needed (kept with the proposal).' },
    },
    required: ['name', 'rev'],
  } as const;

  const rollbackDef = {
    name: 'memory_rollback',
    description:
      'Propose restoring one memory to an earlier version. Creates a pending restore proposal (same approval gate, drift-checked); nothing changes until a human approves.',
    parameters: rollbackSchema,
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
    },
    execute: async (args: { name: string; rev: number; reason?: string }, exec?: ToolExecLike) => {
      const wk = workspaceKeyForExec(exec);
      const { text: nameNorm } = normalize(args.name);
      const entity = deps.service.findEntityByName(nameNorm, wk);
      if (entity === null) return `（没有名为「${args.name}」的记忆）`;
      if (args.rev === entity.currentRev) return `rev ${args.rev} 已是当前版本，无需回滚。`;
      const target = deps.service.getVersion(entity.id, args.rev);
      if (target === null) return `（rev ${args.rev} 不存在；当前 rev ${entity.currentRev}）`;

      const input: ProposeInput = {
        name: entity.name,
        text: target.text,
        track: entity.track,
        scope: entity.scope,
        action: 'restore',
        reason: args.reason ?? `restore to rev${args.rev}`,
      };
      const result = deps.service.propose(input, wk);
      pendingsFor(exec, deps.sessionPendings).add(result.pendingId);
      return `已提交回滚提案（rev ${entity.currentRev} → ${args.rev}），待面板审批后生效。${
        result.conflictWith.length > 0 ? `冲突候选：${result.conflictWith.join(', ')}` : ''
      }`;
    },
  };

  tools.register(proposeDef);
  tools.register(queryDef);
  tools.register(historyDef);
  tools.register(expandDef);
  tools.register(rollbackDef);
}
