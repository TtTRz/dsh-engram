/**
 * dsh-engram plugin entry.
 *
 * P0: mounts the memory tools (propose / query) and holds a private
 * MemoryService per plugin instance. P2: the frozen stable snapshot section
 * (§5.2). Recall injection (P3) plugs in later — the service is the single
 * write path.
 */

import type { Context } from '@deepseek-ai/cordis';
import { DEFAULT_CONFIG } from './types.js';
import type { MemoryConfig } from './types.js';
import { MemoryService } from './service.js';
import { registerMemoryTools } from './tool.js';
import { registerEngramRoutes } from './api.js';
import { registerSnapshotSection } from './snapshot.js';
import type { SystemPromptLike } from './snapshot.js';
import { resolveWorkspaceKey } from './workspace.js';

export const name = 'dsh-engram';
export const inject = ['tools', 'systemPrompt'] as const;

export interface EngramConfig {
  /** Database path; ':memory:' for ephemeral. */
  dbPath?: string;
  snapshotBudget?: number;
  entryBudget?: number;
  synonymGroups?: string[][];
}

export function apply(ctx: Context, config?: EngramConfig): void {
  const resolved: MemoryConfig = {
    dbPath: config?.dbPath ?? DEFAULT_CONFIG.dbPath,
    snapshotBudget: config?.snapshotBudget ?? DEFAULT_CONFIG.snapshotBudget,
    entryBudget: config?.entryBudget ?? DEFAULT_CONFIG.entryBudget,
    synonymGroups: config?.synonymGroups ?? DEFAULT_CONFIG.synonymGroups,
  };

  const service = new MemoryService(resolved);
  const sessionPendings = new Set<string>();

  registerMemoryTools({ ctx, service, config: resolved, sessionPendings });

  // P2: frozen stable snapshot in every session's system prompt (§5.2).
  // Static inject guarantees presence; throwing beats a silently missing
  // snapshot (the settings-panel 404 taught us that lesson).
  const systemPrompt = ctx.get('systemPrompt') as SystemPromptLike | undefined;
  if (systemPrompt === undefined) {
    throw new Error('dsh-engram: systemPrompt service unavailable despite inject');
  }
  registerSnapshotSection(systemPrompt, service, resolved.snapshotBudget);

  // Panel approval API: runtime-injects the optional webServer service (see
  // api.ts). The service instance is captured in the closure, never on ctx.
  registerEngramRoutes(ctx, service, () => {
    const cwd = (ctx as { cwd?: string }).cwd;
    return typeof cwd === 'string' && cwd.length > 0 ? resolveWorkspaceKey(cwd).key : null;
  });

  ctx.effect(() => () => {
    service.close();
  }, 'dsh-engram.service');
}

export { MemoryService } from './service.js';
export { SQLiteProvider } from './store.js';
export { renderSnapshot, registerSnapshotSection } from './snapshot.js';
export { resolveWorkspaceKey, normalizeGitOrigin, findGitRoot } from './workspace.js';
export { normalize, toHalfWidth, toSimplified, extractTerms, expandSynonyms } from './normalize.js';
export * from './types.js';
