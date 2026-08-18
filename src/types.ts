/**
 * dsh-engram type definitions — mirrors 设计文档 v4.
 */

// ---------------------------------------------------------------------------
// Tracks / scopes / kinds
// ---------------------------------------------------------------------------

export type Track = 'user' | 'agent';
export type Scope = 'global' | 'workspace';
/** stable → snapshot channel; situational → recall channel (§3.3 / §5.1). */
export type MemoryKind = 'stable' | 'situational';
export type VersionKind = 'create' | 'refine' | 'contradict' | 'merge' | 'archive' | 'restore';
export type PendingStatus = 'proposed' | 'approved' | 'denied' | 'superseded';
export type EvidenceOrigin = 'cited' | 'heuristic';

// ---------------------------------------------------------------------------
// Citation: pointer + snapshot double insurance (§4, X5)
// ---------------------------------------------------------------------------

export interface Citation {
  sessionId: string;
  /** Model-proposed, server-validated; degrades to whole-session range, never rejects (G2). */
  startSeq: number;
  endSeq: number;
  /** Excerpt shown for human verification (anchor, not machine evidence). */
  excerpt?: string;
  /**
   * X5: full snapshot of the supporting passage (excerpt + 1–2 adjacent messages),
   * persisted with the version row at approve time. Self-contained, permanent.
   */
  excerptSnapshot?: string;
}

// ---------------------------------------------------------------------------
// Entities & versions (§2.2 / §2.3)
// ---------------------------------------------------------------------------

export interface MemoryEntity {
  id: string;
  /** X1 topic anchor, e.g. "部署端口". Model suggests, approver may edit. */
  name: string;
  /** Normalized name (simplified / half-width / lowercased) — grouping index. */
  nameNorm: string;
  track: Track;
  scope: Scope;
  kind: MemoryKind;
  /** Resolved workspace key (git-origin normalized hash) when scope=workspace. */
  workspaceKey?: string;
  currentRev: number;
  state: 'active' | 'archived';
  /** N8: optional expiry (epoch ms). NULL = never expires. */
  validUntil?: number;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryVersion {
  entityId: string;
  rev: number;
  kind: VersionKind;
  text: string;
  reason: string;
  evidence: Citation[];
  origin: EvidenceOrigin;
  createdAt: number;
  approvalId?: string;
}

/** Folded summary node replacing versions older than the 5-version window (G3/N7/X5). */
export interface FoldedNode {
  type: 'folded';
  entityId: string;
  rangeFrom: number;
  rangeTo: number;
  stats: Record<VersionKind, number>;
  /** One-line summary per folded version. */
  summaries: { rev: number; kind: VersionKind; summary: string }[];
  /** Merged & deduped citation ranges (pointers never dropped). */
  citations: Citation[];
  foldedAt: number;
}

// ---------------------------------------------------------------------------
// Pending proposals (§2.4)
// ---------------------------------------------------------------------------

export interface PendingProposal {
  id: string;
  entityId?: string;
  name: string;
  action: VersionKind;
  track: Track;
  scope: Scope;
  kind: MemoryKind;
  text: string;
  reason?: string;
  evidence?: Citation[];
  validUntil?: number;
  /** X2: entity.currentRev at propose time; approve validates drift. */
  baseRev?: number;
  /** Resolved workspace key captured at propose time; approve reuses it (no re-derivation). */
  workspaceKey?: string;
  /** X1 layer-2 output: suspected conflicting entity ids (candidates only). */
  conflictWith?: string[];
  status: PendingStatus;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Audit (§2.5)
// ---------------------------------------------------------------------------

export interface ApprovalAudit {
  id: string;
  entityId: string;
  rev: number;
  action: 'propose' | 'approve' | 'deny';
  payload: string;
  outcome: 'allowed' | 'denied';
  user?: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Query results (§6: active vs pending-self, N3)
// ---------------------------------------------------------------------------

export type QueryHit =
  | { source: 'active'; entity: MemoryEntity; version: MemoryVersion }
  | { source: 'pending-self'; pending: PendingProposal };

// ---------------------------------------------------------------------------
// Recall results (§5.3: relevance tiers X3, freshness N8)
// ---------------------------------------------------------------------------

/**
 * One recall-channel candidate. `tier` is the lexical relevance "四级凑出":
 * 1 exact normalized-name match, 2 topic-anchor term hit, 3 full-text hit,
 * 4 same-name carrying (an entry pulled in because its group was hit).
 * `expired` marks an explicit valid_until in the past — the injection labels
 * it `verify`; NULL valid_until never expires (N8, no implicit thresholds).
 */
export interface RecallHit {
  entity: MemoryEntity;
  version: MemoryVersion;
  tier: 1 | 2 | 3 | 4;
  expired: boolean;
}

// ---------------------------------------------------------------------------
// Service results / errors
// ---------------------------------------------------------------------------

export interface ProposeResult {
  ok: true;
  pendingId: string;
  conflictWith: string[];
  message: string;
}

export interface DriftInfo {
  drifted: true;
  baseRev: number;
  currentRev: number;
  /** Changes between baseRev..currentRev for the approver to review. */
  intermediate: MemoryVersion[];
}

export type ApproveOutcome =
  | { ok: true; entityId: string; newRev: number }
  | { ok: false; reason: 'already-settled'; by: 'approve' | 'deny'; user?: string }
  | { ok: false; reason: 'drift'; drift: DriftInfo };

export type DenyOutcome =
  | { ok: true }
  | { ok: false; reason: 'already-settled'; by: 'approve' | 'deny'; user?: string };

// ---------------------------------------------------------------------------
// Config (§3.3 snapshot budget etc.)
// ---------------------------------------------------------------------------

export interface MemoryConfig {
  /** Database file path. ':memory:' supported for tests. */
  dbPath: string;
  /** §3.3: hard cap for the sum of stable current-version texts. Default 4000. */
  snapshotBudget: number;
  /** Per-entry text budget (I-4). Default 2000 chars. */
  entryBudget: number;
  /** Seed synonym groups for recall OR-expansion (X3). Array of string arrays. */
  synonymGroups: string[][];
  /** §5.3 recall channel hard bound: max entries injected per step. Default 3. */
  recallMax: number;
  /** §5.3 recall channel hard bound: max characters injected per step. Default 1200. */
  recallBudget: number;
}

export const DEFAULT_CONFIG: MemoryConfig = {
  dbPath: ':memory:',
  snapshotBudget: 4000,
  entryBudget: 2000,
  synonymGroups: [],
  recallMax: 3,
  recallBudget: 1200,
};

// ---------------------------------------------------------------------------
// Structured errors
// ---------------------------------------------------------------------------

export class BudgetExceededError extends Error {
  readonly code = 'BUDGET_EXCEEDED';
  constructor(
    message: string,
    readonly used: number,
    readonly limit: number,
    readonly needed: number,
  ) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

export class InvalidInputError extends Error {
  readonly code = 'INVALID_INPUT';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInputError';
  }
}
