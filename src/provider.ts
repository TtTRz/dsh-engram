/**
 * MemoryProvider abstraction (§1 architecture, P5).
 *
 * MemoryService holds its storage through this structural interface instead
 * of the concrete SQLiteProvider, so alternative backends can be plugged in
 * without touching the approval gate. SQLiteProvider satisfies it structurally
 * (TypeScript structural typing) — no runtime changes, zero deps.
 *
 * The service remains the ONLY write caller: nothing outside this interface's
 * owner may touch these methods directly (I-2).
 */

import type { SQLiteProvider, InsertEntity, InsertVersion } from './store.js';
import type {
  Citation,
  FoldedNode,
  MemoryEntity,
  MemoryVersion,
  PendingProposal,
  PendingStatus,
} from './types.js';

/** Structural subset of node:sqlite DatabaseSync the service uses for transactions. */
export interface SqlExecutor {
  exec(sql: string): void;
}

export interface RecallCandidateRow {
  entityId: string;
  tier: 2 | 3;
}

export interface StableSnapshotRow {
  name: string;
  text: string;
  updatedAt: number;
}

export interface AuditRow {
  id: string;
  entityId: string;
  rev: number;
  action: string;
  outcome: string;
  user: string | null;
  createdAt: number;
}

/**
 * The storage seam: the full surface MemoryService consumes, expressed as a
 * real interface over the store's exported row types. SQLiteProvider
 * satisfies it structurally; alternative backends implement it directly.
 */
export interface MemoryProvider {
  readonly db: SqlExecutor;
  close(): void;
  transaction<T>(fn: () => T): T;

  insertEntity(entity: InsertEntity, now: number): string;
  getEntity(id: string): import('./types.js').MemoryEntity | null;
  findEntityByName(nameNorm: string, workspaceKey: string | null): import('./types.js').MemoryEntity | null;
  updateEntityCurrentRev(id: string, rev: number, now: number): void;
  archiveEntity(id: string, now: number): void;
  restoreEntity(id: string, now: number): void;
  listActiveByScope(workspaceKey: string | null, kind: string): import('./types.js').MemoryEntity[];
  listActiveByNameNorm(nameNorm: string): import('./types.js').MemoryEntity[];
  listAllActive(includeArchived?: boolean): ReturnType<SQLiteProvider['listAllActive']>;
  listStableSnapshot(): StableSnapshotRow[];

  insertVersion(v: InsertVersion, now: number): void;
  getVersion(entityId: string, rev: number): import('./types.js').MemoryVersion | null;
  getVersionsBetween(entityId: string, fromRev: number, toRev: number): import('./types.js').MemoryVersion[];
  getVersionChain(entityId: string): Array<import('./types.js').MemoryVersion | import('./types.js').FoldedNode>;

  insertPending(p: Omit<import('./types.js').PendingProposal, 'id' | 'status' | 'createdAt'>): string;
  getPending(id: string): import('./types.js').PendingProposal | null;
  updatePendingStatus(id: string, status: import('./types.js').PendingStatus): number;
  detachPendingEntity(id: string): boolean;
  listPendingByStatus(status: import('./types.js').PendingStatus): import('./types.js').PendingProposal[];
  listPendingByEntity(entityId: string, status: import('./types.js').PendingStatus): import('./types.js').PendingProposal[];

  insertAudit(a: {
    entityId: string;
    rev: number;
    action: 'propose' | 'approve' | 'deny';
    payload: string;
    outcome: 'allowed' | 'denied';
    user?: string;
  }): string;
  listAudit(limit: number): AuditRow[];

  rebuildFtsRow(entityId: string, name: string, text: string): void;
  deleteFtsRow(entityId: string): void;
  searchFts(query: string, limit: number): Array<{ entityId: string }>;
  searchFtsInScope(query: string, workspaceKey: string | null, limit: number): Array<{ entityId: string }>;
  recallCandidates(terms: string[], workspaceKey: string | null, limit: number): RecallCandidateRow[];
  stableTextSum(workspaceKey: string | null): number;
}

/** Compile-time proof that the SQLite backend satisfies the seam. */
export const _sqliteSatisfiesProvider = null as unknown as SQLiteProvider extends MemoryProvider
  ? true
  : never;

/** A provider factory: given the resolved config, produce (and own) a provider. */
export type MemoryProviderFactory = (config: {
  dbPath: string;
}) => MemoryProvider;
