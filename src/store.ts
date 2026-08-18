/**
 * SQLiteProvider — the storage layer (§2.2~§2.6).
 *
 * Five tables + FTS5 + scope index. All writes go through MemoryService;
 * this provider is held privately inside the service (design invariant:
 * no public store surface, I-2).
 *
 * Uses node:sqlite (DatabaseSync) — Node ≥22.5, zero runtime deps.
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type {
  ApprovalAudit,
  Citation,
  FoldedNode,
  MemoryEntity,
  MemoryVersion,
  PendingProposal,
} from './types.js';
import { normalize } from './normalize.js';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memory_entity (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  name_norm     TEXT NOT NULL,
  track         TEXT NOT NULL,
  scope         TEXT NOT NULL,
  kind          TEXT NOT NULL,
  workspace_key TEXT,
  current_rev   INTEGER NOT NULL,
  state         TEXT NOT NULL,
  valid_until   INTEGER,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_version (
  entity_id  TEXT NOT NULL,
  rev        INTEGER NOT NULL,
  kind       TEXT NOT NULL,
  text       TEXT NOT NULL,
  reason     TEXT NOT NULL,
  evidence   TEXT NOT NULL,
  origin     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  approval_id TEXT,
  PRIMARY KEY (entity_id, rev)
);

CREATE TABLE IF NOT EXISTS pending (
  id            TEXT PRIMARY KEY,
  entity_id     TEXT,
  name          TEXT,
  action        TEXT NOT NULL,
  track         TEXT NOT NULL,
  scope         TEXT NOT NULL,
  kind          TEXT NOT NULL,
  text          TEXT NOT NULL,
  reason        TEXT,
  evidence      TEXT,
  valid_until   INTEGER,
  base_rev      INTEGER,
  workspace_key TEXT,
  conflict_with TEXT,
  status        TEXT NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS approval_audit (
  id         TEXT PRIMARY KEY,
  entity_id  TEXT NOT NULL,
  rev        INTEGER NOT NULL,
  action     TEXT NOT NULL,
  payload    TEXT NOT NULL,
  outcome    TEXT NOT NULL,
  user       TEXT,
  created_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  entity_id UNINDEXED,
  name,
  text,
  terms,
  tokenize='unicode61'
);

CREATE INDEX IF NOT EXISTS idx_entity_scope ON memory_entity(workspace_key, state, kind);
`;

// ---------------------------------------------------------------------------
// Row → domain mapping (column order matches INSERT statements)
// ---------------------------------------------------------------------------

interface EntityRow {
  id: string;
  name: string;
  name_norm: string;
  track: string;
  scope: string;
  kind: string;
  workspace_key: string | null;
  current_rev: number;
  state: string;
  valid_until: number | null;
  created_at: number;
  updated_at: number;
}

interface VersionRow {
  entity_id: string;
  rev: number;
  kind: string;
  text: string;
  reason: string;
  evidence: string;
  origin: string;
  created_at: number;
  approval_id: string | null;
}

interface PendingRow {
  id: string;
  entity_id: string | null;
  name: string | null;
  action: string;
  track: string;
  scope: string;
  kind: string;
  text: string;
  reason: string | null;
  evidence: string | null;
  valid_until: number | null;
  base_rev: number | null;
  workspace_key: string | null;
  conflict_with: string | null;
  status: string;
  created_at: number;
}

interface AuditRow {
  id: string;
  entity_id: string;
  rev: number;
  action: string;
  payload: string;
  outcome: string;
  user: string | null;
  created_at: number;
}

function rowToEntity(row: EntityRow): MemoryEntity {
  return {
    id: row.id,
    name: row.name,
    nameNorm: row.name_norm,
    track: row.track as MemoryEntity['track'],
    scope: row.scope as MemoryEntity['scope'],
    kind: row.kind as MemoryEntity['kind'],
    ...(row.workspace_key !== null ? { workspaceKey: row.workspace_key } : {}),
    currentRev: row.current_rev,
    state: row.state as MemoryEntity['state'],
    ...(row.valid_until !== null ? { validUntil: row.valid_until } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToVersion(row: VersionRow): MemoryVersion {
  return {
    entityId: row.entity_id,
    rev: row.rev,
    kind: row.kind as MemoryVersion['kind'],
    text: row.text,
    reason: row.reason,
    evidence: JSON.parse(row.evidence) as Citation[],
    origin: row.origin as MemoryVersion['origin'],
    createdAt: row.created_at,
    ...(row.approval_id !== null ? { approvalId: row.approval_id } : {}),
  };
}

function rowToPending(row: PendingRow): PendingProposal {
  return {
    id: row.id,
    ...(row.entity_id !== null ? { entityId: row.entity_id } : {}),
    name: row.name ?? '',
    action: row.action as PendingProposal['action'],
    track: row.track as PendingProposal['track'],
    scope: row.scope as PendingProposal['scope'],
    kind: row.kind as PendingProposal['kind'],
    text: row.text,
    ...(row.reason !== null ? { reason: row.reason } : {}),
    ...(row.evidence !== null ? { evidence: JSON.parse(row.evidence) as Citation[] } : {}),
    ...(row.valid_until !== null ? { validUntil: row.valid_until } : {}),
    ...(row.base_rev !== null ? { baseRev: row.base_rev } : {}),
    ...(row.workspace_key !== null ? { workspaceKey: row.workspace_key } : {}),
    ...(row.conflict_with !== null ? { conflictWith: JSON.parse(row.conflict_with) as string[] } : {}),
    status: row.status as PendingProposal['status'],
    createdAt: row.created_at,
  };
}

function rowToAudit(row: AuditRow): ApprovalAudit {
  return {
    id: row.id,
    entityId: row.entity_id,
    rev: row.rev,
    action: row.action as ApprovalAudit['action'],
    payload: row.payload,
    outcome: row.outcome as ApprovalAudit['outcome'],
    ...(row.user !== null ? { user: row.user } : {}),
    createdAt: row.created_at,
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface InsertEntity {
  name: string;
  nameNorm: string;
  track: string;
  scope: string;
  kind: string;
  workspaceKey?: string;
  state: 'active' | 'arched' | 'archived';
  validUntil?: number;
}

export interface InsertVersion {
  entityId: string;
  rev: number;
  kind: string;
  text: string;
  reason: string;
  evidence: Citation[];
  origin: string;
  approvalId?: string;
}

export class SQLiteProvider {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
    this.migrate();
    if (dbPath !== ':memory:') {
      this.db.exec('PRAGMA journal_mode=WAL;');
    }
  }

  /**
   * Idempotent lightweight migrations for databases created by older builds.
   * `CREATE TABLE IF NOT EXISTS` never alters an existing table, so columns
   * added later must be applied here via PRAGMA inspection.
   */
  private migrate(): void {
    const cols = this.db.prepare('PRAGMA table_info(pending)').all() as unknown as Array<{
      name: string;
    }>;
    if (!cols.some((c) => c.name === 'workspace_key')) {
      this.db.exec('ALTER TABLE pending ADD COLUMN workspace_key TEXT');
    }
  }

  close(): void {
    this.db.close();
  }

  // -- entity ---------------------------------------------------------------

  insertEntity(entity: InsertEntity, now: number): string {
    const id = `ent-${randomUUID()}`;
    this.db
      .prepare(
        `INSERT INTO memory_entity (id, name, name_norm, track, scope, kind, workspace_key, current_rev, state, valid_until, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      )
      .run(
        id,
        entity.name,
        entity.nameNorm,
        entity.track,
        entity.scope,
        entity.kind,
        entity.workspaceKey ?? null,
        entity.state === 'archived' ? 'archived' : 'active',
        entity.validUntil ?? null,
        now,
        now,
      );
    return id;
  }

  getEntity(id: string): MemoryEntity | null {
    const row = this.db.prepare('SELECT * FROM memory_entity WHERE id = ?').get(id) as
      | EntityRow
      | undefined;
    return row ? rowToEntity(row) : null;
  }

  findEntityByName(nameNorm: string, workspaceKey: string | null): MemoryEntity | null {
    const row = this.db
      .prepare(
        `SELECT * FROM memory_entity WHERE name_norm = ? AND state = 'active'
         AND (workspace_key IS ? OR (workspace_key IS NULL AND ? IS NULL))
         ORDER BY updated_at DESC LIMIT 1`,
      )
      .get(nameNorm, workspaceKey, workspaceKey) as EntityRow | undefined;
    return row ? rowToEntity(row) : null;
  }

  updateEntityCurrentRev(id: string, rev: number, now: number): void {
    this.db
      .prepare('UPDATE memory_entity SET current_rev = ?, updated_at = ? WHERE id = ?')
      .run(rev, now, id);
  }

  archiveEntity(id: string, now: number): void {
    this.db
      .prepare("UPDATE memory_entity SET state = 'archived', updated_at = ? WHERE id = ?")
      .run(now, id);
    this.deleteFtsRow(id);
  }

  listActiveByScope(workspaceKey: string | null, kind: string): MemoryEntity[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_entity
         WHERE state = 'active' AND kind = ?
         AND (workspace_key IS ? OR (workspace_key IS NULL AND ? IS NULL))
         ORDER BY updated_at DESC`,
      )
      .all(kind, workspaceKey, workspaceKey) as unknown as EntityRow[];
    return rows.map(rowToEntity);
  }

  stableTextSum(workspaceKey: string | null): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(LENGTH(v.text)), 0) AS total
         FROM memory_entity e JOIN memory_version v ON v.entity_id = e.id AND v.rev = e.current_rev
         WHERE e.state = 'active' AND e.kind = 'stable'
         AND (e.workspace_key IS ? OR (e.workspace_key IS NULL AND ? IS NULL))`,
      )
      .get(workspaceKey, workspaceKey) as { total: number };
    return row.total;
  }

  /**
   * Snapshot channel rows (§5.1/§5.2): global stable current versions,
   * newest update first. Workspace-scoped stable entries never enter the
   * snapshot — they go to the recall channel (P3).
   */
  listStableSnapshot(): Array<{ name: string; text: string; updatedAt: number }> {
    const rows = this.db
      .prepare(
        `SELECT e.name, v.text, e.updated_at
         FROM memory_entity e JOIN memory_version v ON v.entity_id = e.id AND v.rev = e.current_rev
         WHERE e.state = 'active' AND e.kind = 'stable' AND e.workspace_key IS NULL
         ORDER BY e.updated_at DESC`,
      )
      .all() as unknown as Array<{ name: string; text: string; updated_at: number }>;
    return rows.map((row) => ({ name: row.name, text: row.text, updatedAt: row.updated_at }));
  }

  // -- version ---------------------------------------------------------------

  insertVersion(v: InsertVersion, now: number): void {
    this.db
      .prepare(
        `INSERT INTO memory_version (entity_id, rev, kind, text, reason, evidence, origin, created_at, approval_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        v.entityId,
        v.rev,
        v.kind,
        v.text,
        v.reason,
        JSON.stringify(v.evidence),
        v.origin,
        now,
        v.approvalId ?? null,
      );
  }

  getVersion(entityId: string, rev: number): MemoryVersion | null {
    const row = this.db
      .prepare('SELECT * FROM memory_version WHERE entity_id = ? AND rev = ?')
      .get(entityId, rev) as VersionRow | undefined;
    return row ? rowToVersion(row) : null;
  }

  getVersionsBetween(entityId: string, fromRev: number, toRev: number): MemoryVersion[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM memory_version WHERE entity_id = ? AND rev > ? AND rev <= ? ORDER BY rev',
      )
      .all(entityId, fromRev, toRev) as unknown as VersionRow[];
    return rows.map(rowToVersion);
  }

  getVersionChain(entityId: string): Array<MemoryVersion | FoldedNode> {
    const rows = this.db
      .prepare('SELECT * FROM memory_version WHERE entity_id = ? ORDER BY rev')
      .all(entityId) as unknown as VersionRow[];
    const versions = rows.map(rowToVersion);
    if (versions.length <= 5) return versions;
    // §2.3 bounded chain: current + up to 4 foldable history rows; contradict
    // and restore rows are always kept verbatim and squeeze refines out of
    // the window (优先逐版保留); refines fold first.
    const [current, ...histDesc] = [...versions].reverse();
    const keep: MemoryVersion[] = [];
    let foldableKept = 0;
    for (const version of histDesc) {
      const isAnchor = version.kind === 'contradict' || version.kind === 'restore';
      if (isAnchor) {
        keep.push(version);
      } else if (foldableKept < 4) {
        keep.push(version);
        foldableKept += 1;
      }
    }
    const keptRevs = new Set(keep.map((v) => v.rev));
    const foldedVersions = versions.filter((v) => v !== current && !keptRevs.has(v.rev));
    if (foldedVersions.length === 0) {
      return [...keep].reverse().concat(current as MemoryVersion);
    }
    const stats: Record<string, number> = {};
    for (const v of foldedVersions) stats[v.kind] = (stats[v.kind] ?? 0) + 1;
    const citations = foldedVersions.flatMap((v) => v.evidence);
    const folded: FoldedNode = {
      type: 'folded',
      entityId,
      rangeFrom: foldedVersions[0]?.rev ?? 0,
      rangeTo: foldedVersions[foldedVersions.length - 1]?.rev ?? 0,
      stats: stats as FoldedNode['stats'],
      summaries: foldedVersions.map((v) => ({
        rev: v.rev,
        kind: v.kind,
        summary: v.text.slice(0, 80),
      })),
      // Pointers and snapshots are never dropped by folding (X5).
      citations,
      foldedAt: Date.now(),
    };
    return [folded, ...[...keep].reverse(), current as MemoryVersion];
  }

  // -- pending ---------------------------------------------------------------

  insertPending(p: Omit<PendingProposal, 'id' | 'status' | 'createdAt'>): string {
    const id = `pend-${randomUUID()}`;
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO pending (id, entity_id, name, action, track, scope, kind, text, reason, evidence, valid_until, base_rev, workspace_key, conflict_with, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?)`,
      )
      .run(
        id,
        p.entityId ?? null,
        p.name ?? null,
        p.action,
        p.track,
        p.scope,
        p.kind,
        p.text,
        p.reason ?? null,
        p.evidence !== undefined ? JSON.stringify(p.evidence) : null,
        p.validUntil ?? null,
        p.baseRev ?? null,
        p.workspaceKey ?? null,
        p.conflictWith !== undefined ? JSON.stringify(p.conflictWith) : null,
        now,
      );
    return id;
  }

  getPending(id: string): PendingProposal | null {
    const row = this.db.prepare('SELECT * FROM pending WHERE id = ?').get(id) as
      | PendingRow
      | undefined;
    return row ? rowToPending(row) : null;
  }

  listPendingByStatus(status: string): PendingProposal[] {
    const rows = this.db
      .prepare('SELECT * FROM pending WHERE status = ? ORDER BY created_at')
      .all(status) as unknown as PendingRow[];
    return rows.map(rowToPending);
  }

  listPendingByEntity(entityId: string, status: string): PendingProposal[] {
    const rows = this.db
      .prepare('SELECT * FROM pending WHERE entity_id = ? AND status = ? ORDER BY created_at')
      .all(entityId, status) as unknown as PendingRow[];
    return rows.map(rowToPending);
  }

  /**
   * Run `fn` inside one SQLite transaction (BEGIN … COMMIT / ROLLBACK on
   * throw). The service keeps gate semantics without touching the db handle.
   */
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  updatePendingStatus(id: string, status: string): number {
    const result = this.db
      .prepare('UPDATE pending SET status = ? WHERE id = ? AND status = ?')
      .run(status, id, 'proposed');
    return Number(result.changes);
  }

  supersedePendings(ids: string[]): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(
      "UPDATE pending SET status = 'superseded' WHERE id = ? AND status = 'proposed'",
    );
    for (const id of ids) stmt.run(id);
  }

  // -- audit ---------------------------------------------------------------

  /** Audit rows newest-first (I-8: every settle must be auditable). */
  listAudit(limit: number): Array<{
    id: string;
    entityId: string;
    rev: number;
    action: string;
    outcome: string;
    user: string | null;
    createdAt: number;
  }> {
    const rows = this.db
      .prepare('SELECT * FROM approval_audit ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(limit) as unknown as Array<{
      id: string;
      entity_id: string;
      rev: number;
      action: string;
      outcome: string;
      user: string | null;
      created_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      entityId: r.entity_id,
      rev: r.rev,
      action: r.action,
      outcome: r.outcome,
      user: r.user,
      createdAt: r.created_at,
    }));
  }

  insertAudit(a: {
    entityId: string;
    rev: number;
    action: 'propose' | 'approve' | 'deny';
    payload: string;
    outcome: 'allowed' | 'denied';
    user?: string;
  }): string {
    const id = `audit-${randomUUID()}`;
    this.db
      .prepare(
        'INSERT INTO approval_audit (id, entity_id, rev, action, payload, outcome, user, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(id, a.entityId, a.rev, a.action, a.payload, a.outcome, a.user ?? null, Date.now());
    return id;
  }

  // -- FTS (I-10) ----------------------------------------------------------

  rebuildFtsRow(entityId: string, name: string, text: string): void {
    this.deleteFtsRow(entityId);
    const { text: normText, terms } = normalize(text);
    this.db
      .prepare('INSERT INTO memory_fts (entity_id, name, text, terms) VALUES (?, ?, ?, ?)')
      .run(entityId, normalize(name).text, normText, terms.join(' '));
  }

  deleteFtsRow(entityId: string): void {
    this.db.prepare('DELETE FROM memory_fts WHERE entity_id = ?').run(entityId);
  }

  searchFts(query: string, limit: number): Array<{ entityId: string }> {
    const { terms } = normalize(query);
    if (terms.length === 0) return [];
    const ftsQuery = terms.map((t) => `"${t}"`).join(' OR ');
    try {
      const rows = this.db
        .prepare(
          `SELECT entity_id FROM memory_fts WHERE memory_fts MATCH ? LIMIT ?`,
        )
        .all(ftsQuery, limit) as unknown as Array<{ entity_id: string }>;
      return rows.map((r) => ({ entityId: r.entity_id }));
    } catch {
      return [];
    }
  }

  /**
   * Scope-partitioned FTS search for conflict candidates (§3.5 layer 2):
   * global entities plus only the SAME workspace's entities. Cross-workspace
   * hits must never enter conflictWith — the approve cascade would otherwise
   * supersede another workspace's pendings.
   */
  searchFtsInScope(
    query: string,
    workspaceKey: string | null,
    limit: number,
  ): Array<{ entityId: string }> {
    const { terms } = normalize(query);
    if (terms.length === 0) return [];
    const ftsQuery = terms.map((t) => `"${t}"`).join(' OR ');
    try {
      const rows = this.db
        .prepare(
          `SELECT f.entity_id FROM memory_fts f
           JOIN memory_entity e ON e.id = f.entity_id
           WHERE memory_fts MATCH ?
             AND e.state = 'active'
             AND (
               e.scope = 'global'
               OR (e.scope = 'workspace' AND e.workspace_key = ?)
             )
           LIMIT ?`,
        )
        .all(ftsQuery, workspaceKey, limit) as unknown as Array<{ entity_id: string }>;
      return rows.map((r) => ({ entityId: r.entity_id }));
    } catch {
      return [];
    }
  }

  /**
   * Recall-channel candidates (§5.3): FTS hits inside the recall scope —
   * same-workspace entries plus global situational (global stable lives in
   * the snapshot channel and is never recalled, §5.4).
   *
   * Two relevance tiers (X3 "四级凑出", lexical only):
   * - `name: MATCH` — the topic anchor itself matched (tier 2 after the
   *   exact-name lookup the service performs);
   * - plain `MATCH` — full-text hit across name/text/terms (tier 3).
   * The service layer resolves ties, same-name carrying, and ordering.
   */
  recallCandidates(
    terms: string[],
    workspaceKey: string | null,
    limit: number,
  ): Array<{ entityId: string; tier: 2 | 3 }> {
    if (terms.length === 0) return [];
    const orTerms = terms.map((t) => `"${t}"`).join(' OR ');
    const scopeSql = `e.state = 'active' AND (
      (e.scope = 'workspace' AND e.workspace_key = ?) OR
      (e.scope = 'global' AND e.kind = 'situational')
    )`;
    const out: Array<{ entityId: string; tier: 2 | 3 }> = [];
    const seen = new Set<string>();
    const push = (rows: Array<{ entity_id: string }>, tier: 2 | 3): void => {
      for (const row of rows) {
        if (seen.has(row.entity_id)) continue;
        seen.add(row.entity_id);
        out.push({ entityId: row.entity_id, tier });
      }
    };
    try {
      const nameRows = this.db
        .prepare(
          `SELECT f.entity_id FROM memory_fts f
           JOIN memory_entity e ON e.id = f.entity_id
           WHERE memory_fts MATCH ? AND ${scopeSql} LIMIT ?`,
        )
        .all(`name : ( ${orTerms} )`, workspaceKey, limit) as unknown as Array<{ entity_id: string }>;
      push(nameRows, 2);
      if (out.length >= limit) return out.slice(0, limit);
      const textRows = this.db
        .prepare(
          `SELECT f.entity_id FROM memory_fts f
           JOIN memory_entity e ON e.id = f.entity_id
           WHERE memory_fts MATCH ? AND ${scopeSql} LIMIT ?`,
        )
        .all(orTerms, workspaceKey, limit) as unknown as Array<{ entity_id: string }>;
      push(textRows, 3);
    } catch {
      return [];
    }
    return out.slice(0, limit);
  }

  /** Every active entity in the same normalized-name group (X3 name carrying). */
  listActiveByNameNorm(nameNorm: string): MemoryEntity[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_entity
         WHERE state = 'active' AND name_norm = ?
         ORDER BY updated_at DESC`,
      )
      .all(nameNorm) as unknown as EntityRow[];
    return rows.map(rowToEntity);
  }
}
