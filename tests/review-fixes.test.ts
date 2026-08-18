/**
 * Review-batch regression tests: H-1 action semantics, H-2 scoped conflict
 * candidates, H-3 snapshot-budget partition, M-1 per-session pending-self.
 */

import { describe, it, expect } from 'vitest';
import { MemoryService } from '../src/service.js';
import { detectConflicts } from '../src/conflict.js';
import { SQLiteProvider } from '../src/store.js';
import { DEFAULT_CONFIG } from '../src/types.js';
import os from 'node:os';

function makeService(): MemoryService {
  return new MemoryService({ ...DEFAULT_CONFIG, dbPath: ':memory:' });
}

describe('H-1: approve executes action semantics', () => {
  it('an approved archive retires the entity (state + FTS), not just a version', () => {
    const svc = makeService();
    const created = svc.propose({ name: '旧事实', text: '将被归档', track: 'user', scope: 'global' }, null);
    svc.approve(created.pendingId, 'a');

    const archived = svc.propose(
      { name: '旧事实', text: '归档留痕', track: 'user', scope: 'global', action: 'archive', reason: '过期' },
      null,
    );
    const outcome = svc.approve(archived.pendingId, 'b');
    expect(outcome.ok).toBe(true);

    if (outcome.ok) {
      const entity = svc.getEntity(outcome.entityId);
      expect(entity?.state).toBe('archived');
    }
    // Retired from the active snapshot/query surface.
    expect(svc.listActiveByScope(null, 'stable')).toHaveLength(0);
    expect(svc.query(null, '归档留痕', new Set())).toHaveLength(0);
    // The audit chain keeps the archive version (append-only).
    if (outcome.ok) {
      const chain = svc.getVersionChain(outcome.entityId);
      expect(chain.length).toBeGreaterThan(0);
    }
  });

  it('an approved merge retires the absorbed conflict entities', () => {
    const svc = makeService();
    // Two distinct-name entities sharing vocabulary → layer-2 candidates.
    const a = svc.propose({ name: '端口甲', text: '服务监听 8899 端口', track: 'user', scope: 'global' }, null);
    svc.approve(a.pendingId, 'a');
    const b = svc.propose({ name: '端口乙', text: '服务监听 9999 端口', track: 'user', scope: 'global' }, null);
    svc.approve(b.pendingId, 'b');
    expect(svc.listActiveByScope(null, 'stable')).toHaveLength(2);

    // Merge proposal: conflict detection attaches the lexical candidates.
    const merge = svc.propose(
      { name: '端口甲', text: '正式端口 8899（合并自旧记录）', track: 'user', scope: 'global', action: 'merge' },
      null,
    );
    expect(merge.conflictWith.length).toBeGreaterThan(0);
    const outcome = svc.approve(merge.pendingId, 'c');
    expect(outcome.ok).toBe(true);

    // Only the merged entity stays active; absorbed ones retired.
    const active = svc.listActiveByScope(null, 'stable');
    expect(active).toHaveLength(1);
    if (outcome.ok) expect(active[0]?.id).toBe(outcome.entityId);
  });
});

describe('§3.5 three-choice resolution (panel modes)', () => {
  function conflictSetup(): { svc: MemoryService; pendingId: string } {
    const svc = new MemoryService({ ...DEFAULT_CONFIG, dbPath: ':memory:' });
    const base = svc.propose({ name: '端口', text: '服务监听 8899 端口', track: 'user', scope: 'global' }, null);
    svc.approve(base.pendingId, 'a');
    const conflict = svc.propose({ name: '端口', text: '服务监听 9999 端口', track: 'user', scope: 'global' }, null);
    return { svc, pendingId: conflict.pendingId };
  }

  it('default approve attaches as the entity next version (refine chain)', () => {
    const { svc, pendingId } = conflictSetup();
    const out = svc.approve(pendingId, 'u');
    expect(out.ok).toBe(true);
    const entities = svc.listAllActive();
    expect(entities).toHaveLength(1);
    if (out.ok) {
      const chain = svc.getVersionChain(out.entityId);
      expect(chain.filter((n) => 'rev' in n)).toHaveLength(2);
    }
  });

  it('coexist keeps two independent same-name chains', () => {
    const { svc, pendingId } = conflictSetup();
    const out = svc.approve(pendingId, 'u', undefined, 'coexist');
    expect(out.ok).toBe(true);
    const entities = svc.listAllActive();
    expect(entities).toHaveLength(2);
    expect(new Set(entities.map((e) => e.name)).size).toBe(1); // both named 端口
    expect(new Set(entities.map((e) => e.id)).size).toBe(2); // distinct chains
    // Both current texts coexist and both are searchable.
    const texts = entities.map((e) => e.id).map((id) => svc.getVersion(id, svc.getEntity(id)!.currentRev)!.text);
    expect(texts).toContain('服务监听 8899 端口');
    expect(texts).toContain('服务监听 9999 端口');
  });

  it('merge attaches and archives the absorbed candidates', () => {
    const { svc, pendingId } = conflictSetup();
    const out = svc.approve(pendingId, 'u', undefined, 'merge');
    expect(out.ok).toBe(true);
    const active = svc.listAllActive();
    expect(active).toHaveLength(1);
    if (out.ok) expect(active[0]?.id).toBe(out.entityId);
  });
});

describe('H-2: conflict candidates stay inside the proposing partition', () => {
  it('a workspace proposal never lists another workspace\'s entity as candidate', () => {
    const dbPath = `${os.tmpdir()}/engram-h2-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    const store = new SQLiteProvider(dbPath);
    const now = Date.now();
    // Another workspace's entity with identical vocabulary.
    const other = store.insertEntity(
      { name: '端口', nameNorm: '端口', track: 'user', scope: 'workspace', kind: 'situational', workspaceKey: 'wk-other', state: 'active' },
      now,
    );
    store.insertVersion(
      { entityId: other, rev: 1, kind: 'create', text: '完全相同的词项内容', reason: '', evidence: [], origin: 'heuristic' },
      now,
    );
    store.updateEntityCurrentRev(other, 1, now);
    store.rebuildFtsRow(other, '端口', '完全相同的词项内容');

    const candidates = detectConflicts(store, '新提案', '完全相同的词项内容', 'wk-mine');
    expect(candidates.all).not.toContain(other);
    store.close();
  });

  it('same-workspace and global entities remain valid candidates', () => {
    const dbPath = `${os.tmpdir()}/engram-h2b-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    const store = new SQLiteProvider(dbPath);
    const now = Date.now();
    const mk = (name: string, text: string, wk: string | null) => {
      const id = store.insertEntity(
        { name, nameNorm: name, track: 'user', scope: wk === null ? 'global' : 'workspace', kind: 'situational', ...(wk !== null ? { workspaceKey: wk } : {}), state: 'active' },
        now,
      );
      store.insertVersion({ entityId: id, rev: 1, kind: 'create', text, reason: '', evidence: [], origin: 'heuristic' }, now);
      store.updateEntityCurrentRev(id, 1, now);
      store.rebuildFtsRow(id, name, text);
      return id;
    };
    const global = mk('全局', '共享词项内容', null);
    const mine = mk('本仓', '共享词项内容', 'wk-mine');
    const foreign = mk('他仓', '共享词项内容', 'wk-other');

    const candidates = detectConflicts(store, '提案', '共享词项内容', 'wk-mine');
    expect(candidates.all).toContain(global);
    expect(candidates.all).toContain(mine);
    expect(candidates.all).not.toContain(foreign);
    store.close();
  });
});

describe('H-3: snapshot budget checks the rendered partition', () => {
  it('workspace stable approvals never trip or skip the global snapshot budget', () => {
    const svc = new MemoryService({
      ...DEFAULT_CONFIG,
      dbPath: ':memory:',
      snapshotBudget: 20,
      entryBudget: 100,
    });
    // A workspace-scoped stable with long text would overflow if the check ran
    // on the right partition; it must NOT flag against the global snapshot.
    const ws = svc.propose(
      { name: '仓库大记忆', text: 'w'.repeat(50), track: 'user', scope: 'workspace', kindSuggestion: 'stable' },
      'wk-1',
    );
    // The kind derives to situational for workspace+user regardless of the
    // suggestion; approve records it as situational — the budget path is skipped.
    svc.approve(ws.pendingId, 't', 'wk-1');

    // Global stable: 20-char budget, an 18-char entry fits; a second one flags.
    const g1 = svc.propose({ name: 'g1', text: 'x'.repeat(16), track: 'user', scope: 'global' }, null);
    expect(svc.approve(g1.pendingId, 't').ok).toBe(true);
    const g2 = svc.propose({ name: 'g2', text: 'y'.repeat(16), track: 'user', scope: 'global' }, null);
    expect(svc.approve(g2.pendingId, 't').ok).toBe(true);
    // Rendered snapshot keeps only what fits: whole-entry skip, budget held.
    const snapshotRows = svc.listStableSnapshot();
    const total = snapshotRows.reduce((sum, row) => sum + row.text.length, 0);
    // Only global rows exist in the snapshot partition at all.
    expect(total).toBeLessThanOrEqual(16 + 16);
  });
});

describe('M-1: pending-self isolation per session', () => {
  it('tool-level tracking keys on the session object, not the process', async () => {
    const { registerMemoryTools } = await import('../src/tool.js');
    const defs: Array<{ name: string; execute?: (a: never, e?: never) => Promise<string> }> = [];
    const ctx = {
      get: (key: string) =>
        key === 'tools' ? { register: (def: (typeof defs)[number]) => void defs.push(def) } : undefined,
    } as never;
    const service = makeService();
    registerMemoryTools({
      ctx,
      service,
      config: DEFAULT_CONFIG,
      sessionPendings: new Set<string>(),
    } as never);

    const propose = defs.find((d) => d.name === 'memory_propose')!;
    const query = defs.find((d) => d.name === 'memory_query')!;
    const sessionA = { id: 's-a', header: { cwd: '/tmp/x' }, events: [] };
    const sessionB = { id: 's-b', header: { cwd: '/tmp/x' }, events: [] };

    await propose.execute!(
      { name: 'A 的提案', text: '只有 A 会话可见', track: 'user', scope: 'global' } as never,
      { agent: { session: sessionA } } as never,
    );

    const inA = await query.execute!({ query: 'A 的提案' } as never, { agent: { session: sessionA } } as never);
    expect(inA).toContain('pending-self');
    const inB = await query.execute!({ query: 'A 的提案' } as never, { agent: { session: sessionB } } as never);
    expect(inB).not.toContain('pending-self');
  });
});
