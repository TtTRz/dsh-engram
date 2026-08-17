/**
 * Invariant tests (§7): lock the hard rules.
 *
 * I-2: every write goes through propose → pending → approve (no auto, no store direct).
 * I-4: over-budget entry throws; never silently truncates.
 * I-5': version chain is append-only (current + ≤4 history, folding keeps citations).
 * I-9: approve validates status==='proposed' && current_rev===base_rev (drift intercepts).
 * I-10: FTS ≡ active entities' current versions (no stale rows).
 */

import { describe, it, expect } from 'vitest';
import { MemoryService } from '../src/service.js';
import { DEFAULT_CONFIG } from '../src/types.js';

function makeService(): MemoryService {
  return new MemoryService({ ...DEFAULT_CONFIG, dbPath: ':memory:' });
}

describe('invariant I-2: approval gate', () => {
  it('propose does not create an entity or version', () => {
    const svc = makeService();
    const r = svc.propose(
      { name: '部署端口', text: '生产环境端口是 8899', track: 'user', scope: 'global' },
      null,
    );
    expect(r.ok).toBe(true);
    // No entity should exist yet
    expect(svc.listActiveByScope(null, 'stable')).toHaveLength(0);
  });

  it('approve creates exactly one version and one active entity', () => {
    const svc = makeService();
    const r = svc.propose(
      { name: '部署端口', text: '生产环境端口是 8899', track: 'user', scope: 'global' },
      null,
    );
    const outcome = svc.approve(r.pendingId, 'tester');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      const entity = svc.getEntity(outcome.entityId);
      expect(entity?.currentRev).toBe(1);
      expect(svc.getVersion(outcome.entityId, 1)?.text).toBe('生产环境端口是 8899');
    }
  });

  it('deny creates no version', () => {
    const svc = makeService();
    const r = svc.propose({ name: 'x', text: 'y', track: 'user', scope: 'global' }, null);
    expect(svc.deny(r.pendingId, 'tester').ok).toBe(true);
    expect(svc.listActiveByScope(null, 'stable')).toHaveLength(0);
  });
});

describe('invariant I-4: budget', () => {
  it('throws BudgetExceededError on over-budget entry, never truncates', () => {
    const svc = new MemoryService({ ...DEFAULT_CONFIG, dbPath: ':memory:', entryBudget: 10 });
    expect(() =>
      svc.propose({ name: 'x', text: 'a'.repeat(11), track: 'user', scope: 'global' }, null),
    ).toThrow(/BUDGET_EXCEEDED|exceeds budget/);
  });
});

describe('invariant I-9: drift interception + first-come-first-served', () => {
  it('intercepts approve when entity moved past base_rev', () => {
    const svc = makeService();
    const p1 = svc.propose({ name: '端口', text: 'v1', track: 'user', scope: 'global' }, null);
    expect(svc.approve(p1.pendingId, 'a').ok).toBe(true);

    // Propose a refine against base_rev=1
    const entity = svc.findEntityByName('端口', null)!;
    const p2 = svc.propose(
      { name: '端口', text: 'v2', track: 'user', scope: 'global', action: 'refine' },
      null,
    );

    // Someone else approves a different change first → current_rev becomes 2
    const p3 = svc.propose(
      { name: '端口', text: 'v3', track: 'user', scope: 'global', action: 'refine' },
      null,
    );
    expect(svc.approve(p3.pendingId, 'b').ok).toBe(true);

    // Now approving p2 (base_rev=1) must drift-intercept
    const outcome = svc.approve(p2.pendingId, 'c');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.reason === 'drift') {
      expect(outcome.drift.baseRev).toBe(1);
      expect(outcome.drift.currentRev).toBe(2);
      expect(outcome.drift.intermediate).toHaveLength(1);
    } else {
      throw new Error('expected drift outcome');
    }
  });

  it('double-approve is first-come-first-served', () => {
    const svc = makeService();
    const p = svc.propose({ name: 'x', text: 'y', track: 'user', scope: 'global' }, null);
    expect(svc.approve(p.pendingId, 'a').ok).toBe(true);
    const second = svc.approve(p.pendingId, 'b');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('already-settled');
  });
});

describe('invariant I-5\': append-only version chain', () => {
  it('keeps versions growing, never mutates past rows', () => {
    const svc = makeService();
    const p = svc.propose({ name: '主题', text: '初版', track: 'user', scope: 'global' }, null);
    expect(svc.approve(p.pendingId, 'a').ok).toBe(true);
    const entity = svc.findEntityByName('主题', null)!;
    const first = svc.getVersion(entity.id, 1);
    const textBefore = first?.text;

    // refine twice
    for (const [i, t] of ['二版', '三版'].entries()) {
      const pp = svc.propose(
        { name: '主题', text: t, track: 'user', scope: 'global', action: 'refine' },
        null,
      );
      expect(svc.approve(pp.pendingId, 'a').ok).toBe(true);
    }
    // rev 1 untouched
    expect(svc.getVersion(entity.id, 1)?.text).toBe(textBefore);
    expect(svc.getEntity(entity.id)?.currentRev).toBe(3);
  });
});

describe('invariant I-10: FTS consistency', () => {
  it('FTS reflects only active entities current version', () => {
    const svc = makeService();
    const p = svc.propose({ name: '端口', text: '生产端口 8899', track: 'user', scope: 'global' }, null);
    expect(svc.approve(p.pendingId, 'a').ok).toBe(true);
    const entity = svc.findEntityByName('端口', null)!;

    // Search finds it
    const hits = svc.searchFts('端口', 10);
    expect(hits.map((h) => h.entityId)).toContain(entity.id);

    // Refine to a different text; FTS must reflect the new text, not the old
    const p2 = svc.propose(
      { name: '端口', text: '生产端口 8900', track: 'user', scope: 'global', action: 'refine' },
      null,
    );
    expect(svc.approve(p2.pendingId, 'a').ok).toBe(true);
    const hits2 = svc.searchFts('8900', 10);
    expect(hits2.map((h) => h.entityId)).toContain(entity.id);
    const hitsOld = svc.searchFts('8899', 10);
    expect(hitsOld.map((h) => h.entityId)).not.toContain(entity.id);
  });
});
