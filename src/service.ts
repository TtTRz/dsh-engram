/**
 * MemoryService — the编排层 and approval gate (§3.1 / §3.2).
 *
 * The ONLY write path: propose → pending → panel approve/deny → version chain.
 * No auto-approval, no direct store surface (I-2, design invariant).
 */

import type {
  ApproveOutcome,
  Citation,
  DenyOutcome,
  MemoryConfig,
  MemoryKind,
  PendingProposal,
  ProposeResult,
  QueryHit,
  Scope,
  Track,
  VersionKind,
} from './types.js';
import { InvalidInputError } from './types.js';
import { normalize } from './normalize.js';
import { SQLiteProvider } from './store.js';
import { checkEntryBudget, checkSnapshotBudget } from './budget.js';
import { detectConflicts } from './conflict.js';

export interface ProposeInput {
  name: string;
  text: string;
  track: Track;
  scope: Scope;
  kindSuggestion?: MemoryKind;
  action?: VersionKind;
  reason?: string;
  evidence?: Citation[];
  validUntil?: number;
}

export class MemoryService {
  private readonly store: SQLiteProvider;
  readonly config: MemoryConfig;

  constructor(config: MemoryConfig) {
    this.config = config;
    this.store = new SQLiteProvider(config.dbPath);
  }

  close(): void {
    this.store.close();
  }

  // -----------------------------------------------------------------------
  // Read-only facade (query/history/panel/API + invariant tests) — the store
  // itself is private: no direct-write surface outside approve/deny (I-2).
  // -----------------------------------------------------------------------

  listProposed() {
    return this.store.listPendingByStatus('proposed');
  }

  getEntity(id: string) {
    return this.store.getEntity(id);
  }

  getVersion(entityId: string, rev: number) {
    return this.store.getVersion(entityId, rev);
  }

  findEntityByName(nameNorm: string, workspaceKey: string | null) {
    return this.store.findEntityByName(nameNorm, workspaceKey);
  }

  listActiveByScope(workspaceKey: string | null, kind: string) {
    return this.store.listActiveByScope(workspaceKey, kind);
  }

  /** Global stable current versions for the snapshot channel (§5.2, P2). */
  listStableSnapshot() {
    return this.store.listStableSnapshot();
  }

  searchFts(query: string, limit: number) {
    return this.store.searchFts(query, limit);
  }

  // -----------------------------------------------------------------------
  // §3.3 kind derivation (deterministic default + model suggestion + approver final)
  // -----------------------------------------------------------------------

  deriveKind(track: Track, scope: Scope, suggestion?: MemoryKind): MemoryKind {
    if (track === 'user' && scope === 'global') return 'stable';
    if (track === 'agent') return 'situational';
    if (track === 'user' && scope === 'workspace') return 'situational';
    return suggestion ?? 'situational';
  }

  // -----------------------------------------------------------------------
  // Propose (§3.1)
  // -----------------------------------------------------------------------

  propose(input: ProposeInput, workspaceKey: string | null): ProposeResult {
    const name = input.name.trim();
    if (name.length === 0) throw new InvalidInputError('name must not be empty');
    if (input.text.trim().length === 0) throw new InvalidInputError('text must not be empty');

    // I-4: per-entry budget — throw, never truncate
    checkEntryBudget(input.text, this.config.entryBudget);

    const { text: nameNorm } = normalize(name);
    const kind = this.deriveKind(input.track, input.scope, input.kindSuggestion);
    const action = input.action ?? 'create';

    // Find existing entity (for refine/contradict or same-name create)
    const existing = this.store.findEntityByName(nameNorm, workspaceKey);
    const entityId = existing?.id;
    const baseRev = existing?.currentRev;

    // Conflict detection (§3.5): two layers, candidates only
    const conflicts = detectConflicts(
      this.store,
      nameNorm,
      input.text,
      workspaceKey,
      entityId,
    );

    // Snapshot budget pre-check (§3.3): flag, don't throw
    const budget = checkSnapshotBudget(
      this.store,
      workspaceKey,
      kind,
      input.text,
      this.config.snapshotBudget,
      action !== 'create' ? entityId : undefined,
    );

    // Evidence origin: heuristic if no citations provided (§4 情形 C)
    const origin: 'cited' | 'heuristic' =
      input.evidence !== undefined && input.evidence.length > 0 ? 'cited' : 'heuristic';

    const pendingId = this.store.insertPending({
      ...(entityId !== undefined ? { entityId } : {}),
      name,
      action,
      track: input.track,
      scope: input.scope,
      kind,
      text: input.text,
      ...(workspaceKey !== null ? { workspaceKey } : {}),
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
      ...(input.validUntil !== undefined ? { validUntil: input.validUntil } : {}),
      ...(baseRev !== undefined ? { baseRev } : {}),
      ...(conflicts.all.length > 0 ? { conflictWith: conflicts.all } : {}),
    });

    // Audit: propose
    this.store.insertAudit({
      entityId: entityId ?? '(new)',
      rev: 0,
      action: 'propose',
      payload: JSON.stringify({ pendingId, name, kind }),
      outcome: 'allowed',
    });

    const messages = ['已提交待审，暂未生效。'];
    if (!budget.withinBudget) {
      messages.push(
        `⚠️ 审批后 stable 总量将超出快照预算（${budget.usedAfterApprove}/${budget.limit} 字符）。审批人需：改 kind=situational 或先归档旧 stable 腾空间。`,
      );
    }
    if (conflicts.all.length > 0) {
      messages.push(`检测到 ${conflicts.all.length} 条疑似冲突候选，审批人需裁决。`);
    }

    return { ok: true, pendingId, conflictWith: conflicts.all, message: messages.join(' ') };
  }

  // -----------------------------------------------------------------------
  // Approve (§3.2: drift check + first-come-first-served + conflict cascade)
  // -----------------------------------------------------------------------

  approve(pendingId: string, user?: string, workspaceKey: string | null = null): ApproveOutcome {
    const pending = this.store.getPending(pendingId);
    if (pending === null) throw new InvalidInputError(`no such pending: ${pendingId}`);

    // The key captured at propose time is authoritative (the panel may approve
    // long after the proposing session ended — re-deriving a "current cwd" here
    // was wrong and crashed on the nonexistent ctx.cwd). The parameter remains
    // only for callers passing an explicit key / legacy rows.
    const wk = pending.workspaceKey ?? workspaceKey;

    // ① First-come-first-served: status must be 'proposed'
    if (pending.status === 'approved') {
      return { ok: false, reason: 'already-settled', by: 'approve' };
    }
    if (pending.status === 'denied') {
      return { ok: false, reason: 'already-settled', by: 'deny' };
    }
    if (pending.status === 'superseded') {
      return { ok: false, reason: 'already-settled', by: 'approve' };
    }

    // ② Drift check: entity current_rev must match base_rev (X2)
    const entityId = pending.entityId;
    if (entityId !== undefined && pending.baseRev !== undefined) {
      const entity = this.store.getEntity(entityId);
      if (entity !== null && entity.currentRev !== pending.baseRev) {
        const intermediate = this.store.getVersionsBetween(
          entityId,
          pending.baseRev,
          entity.currentRev,
        );
        return {
          ok: false,
          reason: 'drift',
          drift: {
            drifted: true,
            baseRev: pending.baseRev,
            currentRev: entity.currentRev,
            intermediate,
          },
        };
      }
    }

    const now = Date.now();

    // ③ Execute in a transaction
    this.store.db.exec('BEGIN');
    try {
      // Optimistic lock: claim the pending row
      const claimed = this.store.updatePendingStatus(pendingId, 'approved');
      if (claimed === 0) {
        this.store.db.exec('ROLLBACK');
        return { ok: false, reason: 'already-settled', by: 'approve' };
      }

      // Resolve or create the entity
      let eid: string;
      let newRev: number;
      if (entityId !== undefined) {
        const entity = this.store.getEntity(entityId);
        if (entity === null) {
          this.store.db.exec('ROLLBACK');
          throw new InvalidInputError(`entity ${entityId} vanished`);
        }
        eid = entityId;
        newRev = entity.currentRev + 1;
      } else {
        // New entity
        const { text: nameNorm } = normalize(pending.name);
        if (pending.scope === 'workspace' && wk === null) {
          this.store.db.exec('ROLLBACK');
          throw new InvalidInputError(
            'workspace-scoped memory requires a workspace key at approve time',
          );
        }
        const entityInput: Parameters<SQLiteProvider['insertEntity']>[0] = {
          name: pending.name,
          nameNorm,
          track: pending.track,
          scope: pending.scope,
          kind: pending.kind,
          ...(pending.scope === 'workspace' && wk !== null
            ? { workspaceKey: wk }
            : {}),
          state: 'active',
          ...(pending.validUntil !== undefined ? { validUntil: pending.validUntil } : {}),
        };
        eid = this.store.insertEntity(entityInput, now);
        newRev = 1;
      }

      // Evidence origin
      const origin: 'cited' | 'heuristic' =
        pending.evidence !== undefined && pending.evidence.length > 0 ? 'cited' : 'heuristic';

      // Insert the version
      const approvalId = this.store.insertAudit({
        entityId: eid,
        rev: newRev,
        action: 'approve',
        payload: JSON.stringify({ pendingId, text: pending.text.slice(0, 200) }),
        outcome: 'allowed',
        ...(user !== undefined ? { user } : {}),
      });

      this.store.insertVersion(
        {
          entityId: eid,
          rev: newRev,
          kind: pending.action,
          text: pending.text,
          reason: pending.reason ?? '',
          evidence: pending.evidence ?? [],
          origin,
          ...(approvalId !== undefined ? { approvalId } : {}),
        },
        now,
      );

      this.store.updateEntityCurrentRev(eid, newRev, now);
      this.store.rebuildFtsRow(eid, pending.name, pending.text);

      // ③ Conflict cascade: supersede other proposed pendings pointing at this entity
      if (pending.conflictWith !== undefined && pending.conflictWith.length > 0) {
        for (const otherId of pending.conflictWith) {
          const others = this.store.listPendingByEntity(otherId, 'proposed');
          for (const other of others) {
            if (other.id !== pendingId) {
              this.store.updatePendingStatus(other.id, 'superseded');
            }
          }
        }
      }

      this.store.db.exec('COMMIT');
      return { ok: true, entityId: eid, newRev };
    } catch (error) {
      this.store.db.exec('ROLLBACK');
      throw error;
    }
  }

  // -----------------------------------------------------------------------
  // Deny (§3.2: first-come-first-served + audit)
  // -----------------------------------------------------------------------

  deny(pendingId: string, user?: string): DenyOutcome {
    const pending = this.store.getPending(pendingId);
    if (pending === null) throw new InvalidInputError(`no such pending: ${pendingId}`);

    if (pending.status !== 'proposed') {
      return {
        ok: false,
        reason: 'already-settled',
        by: pending.status === 'approved' ? 'approve' : 'deny',
      };
    }

    const claimed = this.store.updatePendingStatus(pendingId, 'denied');
    if (claimed === 0) {
      return { ok: false, reason: 'already-settled', by: 'approve' };
    }

    this.store.insertAudit({
      entityId: pending.entityId ?? '(new)',
      rev: 0,
      action: 'deny',
      payload: JSON.stringify({ pendingId }),
      outcome: 'denied',
      ...(user !== undefined ? { user } : {}),
    });

    return { ok: true };
  }

  // -----------------------------------------------------------------------
  // Query (§6: active vs pending-self, N3)
  // -----------------------------------------------------------------------

  query(
    workspaceKey: string | null,
    searchText: string,
    sessionPendingIds: ReadonlySet<string>,
  ): QueryHit[] {
    const hits: QueryHit[] = [];
    const { text: normQuery } = normalize(searchText);

    // Active entities via FTS
    const results = this.store.searchFts(searchText, 10);
    for (const { entityId } of results) {
      const entity = this.store.getEntity(entityId);
      if (entity === null || entity.state !== 'active') continue;
      // Scope filter: workspace memories only for the same workspace, global for all
      if (entity.scope === 'workspace' && entity.workspaceKey !== workspaceKey) continue;
      const version = this.store.getVersion(entityId, entity.currentRev);
      if (version === null) continue;
      hits.push({ source: 'active', entity, version });
    }

    // Same-name exact match (layer 1 supplement)
    if (normQuery.length > 0) {
      const entity = this.store.findEntityByName(normQuery, workspaceKey);
      if (entity !== null && !hits.some((h) => h.source === 'active' && h.entity.id === entity.id)) {
        const version = this.store.getVersion(entity.id, entity.currentRev);
        if (version !== null) hits.push({ source: 'active', entity, version });
      }
    }

    // Pending-self (N3): only this session's proposals, explicitly flagged
    for (const pid of sessionPendingIds) {
      const pending = this.store.getPending(pid);
      if (pending !== null && pending.status === 'proposed') {
        hits.push({ source: 'pending-self', pending });
      }
    }

    return hits;
  }
}
