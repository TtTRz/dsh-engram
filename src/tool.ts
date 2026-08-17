/**
 * Model-facing memory tools (§6).
 *
 * P0: `memory_propose` and `memory_query`.
 * history/expand/rollback are P4 (§8 落地顺序).
 */

import type { Context } from '@deepseek-ai/cordis';
import type { MemoryService } from './service.js';
import type { ProposeInput } from './service.js';
import { resolveWorkspaceKey } from './workspace.js';
import { DEFAULT_CONFIG } from './types.js';
import type { MemoryConfig } from './types.js';

export interface ToolDeps {
  ctx: Context;
  service: MemoryService;
  config: MemoryConfig;
  /** Track this session's proposed pending ids for pending-self visibility (N3). */
  sessionPendings: Set<string>;
}

function workspaceKeyFor(ctx: Context): string | null {
  // P0: workspace resolution from the harness cwd; P1+ may derive from session
  const cwd = (ctx as { cwd?: string }).cwd;
  if (typeof cwd === 'string' && cwd.length > 0) return resolveWorkspaceKey(cwd).key;
  return null;
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

  const proposeSchema = {
    name: { type: 'string', required: true, description: 'Memory topic anchor (e.g. "部署端口").' },
    text: { type: 'string', required: true, description: 'The memory content to persist.' },
    track: {
      type: 'string',
      required: true,
      description: 'Who produced this: "user" or "agent".',
    },
    scope: {
      type: 'string',
      required: true,
      description: '"global" or "workspace".',
    },
    kind_suggestion: {
      type: 'string',
      description: 'Optional "stable" or "situational" hint; the approver has the final say.',
    },
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
    execute: async (args: {
      name: string;
      text: string;
      track: 'user' | 'agent';
      scope: 'global' | 'workspace';
      kind_suggestion?: 'stable' | 'situational';
    }) => {
      const wk = workspaceKeyFor(deps.ctx);
      const input: ProposeInput = {
        name: args.name,
        text: args.text,
        track: args.track,
        scope: args.scope,
        ...(args.kind_suggestion !== undefined ? { kindSuggestion: args.kind_suggestion } : {}),
      };
      const result = deps.service.propose(input, wk);
      deps.sessionPendings.add(result.pendingId);
      return result.message;
    },
  };

  const querySchema = {
    query: { type: 'string', required: true, description: 'Text to search memory by.' },
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
    execute: async (args: { query: string }) => {
      const wk = workspaceKeyFor(deps.ctx);
      const hits = deps.service.query(wk, args.query, deps.sessionPendings);
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

  tools.register(proposeDef);
  tools.register(queryDef);
}

export { DEFAULT_CONFIG };
