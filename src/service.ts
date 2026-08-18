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
  MemoryEntity,
  MemoryKind,
  PendingProposal,
  ProposeResult,
  QueryHit,
  RecallHit,
  Scope,
  Track,
  VersionKind,
} from './types.js';
import { InvalidInputError } from './types.js';
import { normalize, expandSynonyms } from './normalize.js';
import { SQLiteProvider } from './store.js';
import type { MemoryProvider } from './provider.js';
import { checkEntryBudget, checkSnapshotBudget } from './budget.js';
import { detectConflicts } from './conflict.js';

/** True when at least one citation carries verbatim evidence (§4 A/B). */
function hasExcerpt(citations: Citation[]): boolean {
  return citations.some(
    (citation) =>
      (citation.excerpt !== undefined && citation.excerpt.length > 0) ||
      (citation.excerptSnapshot !== undefined && citation.excerptSnapshot.length > 0),
  );
}

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
  private readonly store: MemoryProvider;
  readonly config: MemoryConfig;

  /**
   * P5 provider seam: defaults to the SQLite backend; a custom provider can
   * be injected (tests, alternative storage). The gate logic never depends on
   * the concrete backend.
   */
  constructor(config: MemoryConfig, provider?: MemoryProvider) {
    this.config = config;
    this.store = provider ?? new SQLiteProvider(config.dbPath);
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

  /** Bounded version chain with a synthesized folded head (§2.3, P4). */
  getVersionChain(entityId: string) {
    return this.store.getVersionChain(entityId);
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

  /** Audit trail newest-first (I-8 read surface; the store stays private). */
  listAudit(limit: number) {
    return this.store.listAudit(limit);
  }

  /** Every active memory with its current text — the panel browse surface. */
  listAllActive(includeArchived = false) {
    return this.store.listAllActive(includeArchived);
  }

  /**
   * Panel-initiated DIRECT delete (human action): archives the entity
   * immediately — no pending round-trip, the human IS the gate. Keeps every
   * safeguard: an archive version row lands on the chain, FTS is cleaned
   * (I-10), and proposeRestore can bring it back. Model-initiated archives
   * still MUST clear the approval gate (I-2 guards the model, not the human).
   */
  deleteNow(entityId: string, user?: string): { ok: true } {
    const entity = this.store.getEntity(entityId);
    if (entity === null) throw new InvalidInputError(`no such entity: ${entityId}`);
    if (entity.state !== 'active') throw new InvalidInputError(`entity already ${entity.state}`);
    const now = Date.now();
    const trace = `面板直接删除（原正文：${(this.store.getVersion(entityId, entity.currentRev)?.text ?? '').slice(0, 100)}）`;
    return this.store.transaction(() => {
      const approvalId = this.store.insertAudit({
        entityId,
        rev: entity.currentRev + 1,
        action: 'approve',
        payload: JSON.stringify({ direct: true, text: trace.slice(0, 200), user }),
        outcome: 'allowed',
        ...(user !== undefined ? { user } : {}),
      });
      this.store.insertVersion(
        {
          entityId,
          rev: entity.currentRev + 1,
          kind: 'archive',
          text: trace,
          reason: user ?? 'panel direct delete',
          evidence: [],
          origin: 'heuristic',
          ...(approvalId !== undefined ? { approvalId } : {}),
        },
        now,
      );
      this.store.updateEntityCurrentRev(entityId, entity.currentRev + 1, now);
      this.store.archiveEntity(entityId, now);
      return { ok: true as const };
    });
  }

  /**
   * Panel-initiated restore: files a RESTORE proposal reviving an archived
   * entity to its last current text. Same gate as every write (I-2);
   * approval re-activates the entity and rebuilds its FTS row.
   */
  proposeRestore(entityId: string, reason?: string): { pendingId: string; message: string } {
    const entity = this.store.getEntity(entityId);
    if (entity === null) throw new InvalidInputError(`no such entity: ${entityId}`);
    if (entity.state !== 'archived') {
      throw new InvalidInputError(`entity is ${entity.state}, nothing to restore`);
    }
    // Restore revives the last SUBSTANTIVE text — the archive trace row
    // ("面板删除（原正文…）") is audit trail, not content to resurrect.
    let restoreRev = entity.currentRev;
    let last = this.store.getVersion(entityId, restoreRev);
    while (last !== null && last.kind === 'archive' && restoreRev > 1) {
      restoreRev -= 1;
      last = this.store.getVersion(entityId, restoreRev);
    }
    if (last === null || last.kind === 'archive') {
      throw new InvalidInputError('entity has no restorable versions');
    }
    const result = this.propose(
      {
        name: entity.name,
        text: last.text,
        track: entity.track,
        scope: entity.scope,
        action: 'restore',
        reason: reason ?? `panel restore to rev${restoreRev}`,
      },
      entity.workspaceKey ?? null,
      entityId,
    );
    return { pendingId: result.pendingId, message: '已提交恢复提案，需在待审批中批准后生效。' };
  }

  /**
   * Panel-initiated delete: files an ARCHIVE proposal for the exact entity
   * (I-2 — deletion is a write and must clear the approval gate; the version
   * chain keeps the audit trail). Returns the pending id for the caller to
   * surface. Throws when the entity does not exist or is already retired.
   */
  proposeArchive(entityId: string, reason?: string): { pendingId: string; message: string } {
    const entity = this.store.getEntity(entityId);
    if (entity === null) throw new InvalidInputError(`no such entity: ${entityId}`);
    if (entity.state !== 'active') throw new InvalidInputError(`entity already ${entity.state}`);
    const current = this.store.getVersion(entityId, entity.currentRev);
    const trace = `面板删除（原正文：${(current?.text ?? '').slice(0, 100)}）`;
    const result = this.propose(
      {
        name: entity.name,
        text: trace,
        track: entity.track,
        scope: entity.scope,
        action: 'archive',
        reason: reason ?? 'panel delete',
      },
      entity.workspaceKey ?? null,
      entityId,
    );
    return { pendingId: result.pendingId, message: '已提交删除提案，需在待审批中批准后生效。' };
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

  propose(
    input: ProposeInput,
    workspaceKey: string | null,
    exactEntityId?: string,
    forceNewEntity = false,
  ): ProposeResult {
    const name = input.name.trim();
    if (name.length === 0) throw new InvalidInputError('name must not be empty');
    if (input.text.trim().length === 0) throw new InvalidInputError('text must not be empty');

    // I-4: per-entry budget — throw, never truncate
    checkEntryBudget(input.text, this.config.entryBudget);

    const { text: nameNorm } = normalize(name);
    const kind = this.deriveKind(input.track, input.scope, input.kindSuggestion);
    const action = input.action ?? 'create';

    // Find existing entity (for refine/contradict or same-name create). An
    // exact id (panel-initiated archive) bypasses name resolution so a
    // same-name coexisting entity can never be mistaken for the clicked one.
    // forceNewEntity is the panel's 「并存」 choice (§3.5 ②): same-name
    // proposals stay independent entities instead of attaching as refinements.
    const existing =
      forceNewEntity || exactEntityId === null
        ? undefined
        : exactEntityId !== undefined
          ? this.store.getEntity(exactEntityId)
          : this.store.findEntityByName(nameNorm, workspaceKey);
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

    // Evidence origin (§4 三情形): cited only when some citation carries an
    // excerpt (A) or an excerptSnapshot (B read-back); bare pointers from an
    // unreachable log stay heuristic (C — no verbatim evidence).
    const origin: 'cited' | 'heuristic' =
      input.evidence !== undefined && hasExcerpt(input.evidence) ? 'cited' : 'heuristic';

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

  /**
   * Approve with an optional §3.5 resolution mode:
   * - undefined → default: attach as the entity's next version (refine/contradict semantics).
   * - 'coexist' → re-file as an INDEPENDENT entity (same name, separate chain).
   * - 'merge'   → attach AND archive the conflictWith candidates (H-1 dispatch).
   */
  approve(
    pendingId: string,
    user?: string,
    workspaceKey: string | null = null,
    mode?: 'coexist' | 'merge',
  ): ApproveOutcome {
    const pending = this.store.getPending(pendingId);
    if (pending === null) throw new InvalidInputError(`no such pending: ${pendingId}`);

    // The key captured at propose time is authoritative (the panel may approve
    // long after the proposing session ended — re-deriving a "current cwd" here
    // was wrong and crashed on the nonexistent ctx.cwd). The parameter remains
    // only for callers passing an explicit key / legacy rows.
    let wk = pending.workspaceKey ?? workspaceKey;

    // §3.5 ② 「并存」: re-file the pending as a forced NEW entity. Done before
    // any gate step so the drift check never applies (no base_rev) and the
    // conflict cascade cannot supersede the sibling chains.
    if (mode === 'coexist' && pending.entityId !== undefined) {
      const detached = this.store.detachPendingEntity(pendingId);
      if (detached) {
        delete pending.entityId;
        delete pending.baseRev;
      }
    }

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

    // ③ Execute in a transaction (the store owns the BEGIN/COMMIT boundary)
    return this.store.transaction(() => {
      // Optimistic lock: claim the pending row
      const claimed = this.store.updatePendingStatus(pendingId, 'approved');
      if (claimed === 0) {
        return { ok: false as const, reason: 'already-settled' as const, by: 'approve' as const };
      }

      // Resolve or create the entity
      let eid: string;
      let newRev: number;
      if (entityId !== undefined) {
        const entity = this.store.getEntity(entityId);
        if (entity === null) {
          throw new InvalidInputError(`entity ${entityId} vanished`);
        }
        eid = entityId;
        newRev = entity.currentRev + 1;
      } else {
        // New entity
        const { text: nameNorm } = normalize(pending.name);
        if (pending.scope === 'workspace' && wk === null) {
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

      // Evidence origin (§4 三情形): same honest rule as propose.
      const origin: 'cited' | 'heuristic' =
        pending.evidence !== undefined && hasExcerpt(pending.evidence) ? 'cited' : 'heuristic';

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
      if (pending.action === 'archive') {
        // H-1: an approved archive RETIRES the entity — the version row keeps
        // the audit trail, the entity leaves the active set and FTS (I-10).
        this.store.archiveEntity(eid, now);
      } else if (pending.action === 'restore') {
        // Panel restore (or rollback onto an archived entity): re-activate
        // with the restored current text.
        this.store.restoreEntity(eid, now);
        this.store.rebuildFtsRow(eid, pending.name, pending.text);
      } else {
        this.store.rebuildFtsRow(eid, pending.name, pending.text);
      }
      if (pending.action === 'merge' && pending.conflictWith !== undefined) {
        // H-1: merge retires the absorbed entities (their absorbed texts live
        // on in this version's chain); the system performs NO semantic text
        // merge — the approver authored the merged text in the proposal.
        for (const absorbedId of pending.conflictWith) {
          const absorbed = this.store.getEntity(absorbedId);
          if (absorbed !== null && absorbed.state === 'active' && absorbedId !== eid) {
            this.store.archiveEntity(absorbedId, now);
          }
        }
      }

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

      return { ok: true as const, entityId: eid, newRev };
    });
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

  // -----------------------------------------------------------------------
  // Recall (§5.3: step-1 injection, workspace + global-situational only)
  // -----------------------------------------------------------------------

  /**
   * Recall-channel candidates for the step-1 injection. Lexical only (X3):
   * exact normalized-name match (tier 1), topic-anchor term hit (tier 2),
   * full-text hit with synonym OR-expansion (tier 3), and same-name carrying
   * (tier 4). Scope is the recall channel, never the snapshot: same-workspace
   * entries plus global situational; global stable is excluded (§5.1/§5.4).
   */
  recall(workspaceKey: string | null, searchText: string): RecallHit[] {
    const { text: normText } = normalize(searchText);
    const terms = expandSynonyms(searchText, this.config.synonymGroups);
    const inScope = (entity: MemoryEntity): boolean => {
      if (entity.state !== 'active') return false;
      if (entity.scope === 'workspace') return entity.workspaceKey === workspaceKey;
      return entity.kind === 'situational';
    };
    const now = Date.now();
    const toHit = (entity: MemoryEntity, tier: RecallHit['tier']): RecallHit | null => {
      if (!inScope(entity)) return null;
      const version = this.store.getVersion(entity.id, entity.currentRev);
      if (version === null) return null;
      return {
        entity,
        version,
        tier,
        expired: entity.validUntil !== undefined && entity.validUntil < now,
      };
    };
    const byId = new Map<string, RecallHit>();
    const add = (hit: RecallHit | null): void => {
      if (hit !== null && !byId.has(hit.entity.id)) byId.set(hit.entity.id, hit);
    };

    // Tier 1: exact normalized-name match.
    if (normText.length > 0) {
      const exact = this.store.findEntityByName(normText, workspaceKey);
      if (exact !== null) add(toHit(exact, 1));
    }

    // Tiers 2/3: name-anchor and full-text FTS with synonym expansion.
    for (const { entityId, tier } of this.store.recallCandidates(terms, workspaceKey, 10)) {
      const entity = this.store.getEntity(entityId);
      if (entity !== null) add(toHit(entity, tier));
    }

    // Tier 4: same-name carrying — every active entity in a hit group.
    const groupNorms = new Set<string>();
    for (const hit of byId.values()) groupNorms.add(hit.entity.nameNorm);
    for (const nameNorm of groupNorms) {
      for (const sibling of this.store.listActiveByNameNorm(nameNorm)) {
        if (!byId.has(sibling.id)) add(toHit(sibling, 4));
      }
    }

    return [...byId.values()].sort((a, b) =>
      a.tier !== b.tier ? a.tier - b.tier : b.entity.updatedAt - a.entity.updatedAt,
    );
  }
}
