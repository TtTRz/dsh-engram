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
 * The storage seam: the full surface MemoryService consumes. SQLiteProvider
 * implements every member; alternative backends implement this interface.
 */
export type MemoryProvider = SQLiteProvider;

/** A provider factory: given the resolved config, produce (and own) a provider. */
export type MemoryProviderFactory = (config: {
  dbPath: string;
}) => MemoryProvider;
