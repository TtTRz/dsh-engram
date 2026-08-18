/**
 * P4 evidence tests (§4 三情形) + version-chain folding (§2.3) + tools.
 */

import { describe, it, expect } from 'vitest';
import { resolveEvidence, readCitation } from '../src/evidence.js';
import { MemoryService } from '../src/service.js';
import { SQLiteProvider } from '../src/store.js';
import { DEFAULT_CONFIG } from '../src/types.js';
import type { Citation, MemoryEntity } from '../src/types.js';
import { registerMemoryTools } from '../src/tool.js';
import type { ToolDeps } from '../src/tool.js';
import type { Context } from '@deepseek-ai/cordis';
import os from 'node:os';

interface Ev {
  type: string;
  seq: number;
  data?: { role?: string; content?: Array<{ type: string; text: string }> };
}

function sessionFixture(): { id: string; events: Ev[] } {
  const mk = (seq: number, role: string, text: string): Ev => ({
    type: role === 'user' ? 'user/message' : 'assistant/message',
    seq,
    data: { role, content: [{ type: 'text', text }] },
  });
  return {
    id: 'session-1',
    events: [
      { type: 'turn/start', seq: 1 },
      mk(2, 'user', '请帮我记住部署端口'),
      mk(3, 'assistant', '好的，已提议记忆待审批'),
      mk(4, 'user', '端口是 8899，服务名 demo-api'),
      mk(5, 'assistant', '已提交待审'),
      { type: 'turn/end', seq: 6 },
      mk(7, 'user', '另外还有一条'),
    ],
  };
}

function cite(over: Partial<Citation>): Citation {
  return { sessionId: 'session-1', startSeq: 4, endSeq: 4, ...over };
}

describe('resolveEvidence (§4 三情形)', () => {
  it('C: no citations → heuristic with empty evidence', () => {
    const out = resolveEvidence(undefined, sessionFixture());
    expect(out.evidence).toHaveLength(0);
    expect(out.origin).toBe('heuristic');
  });

  it('C: bare pointer to an unreachable session stays heuristic (no snapshot)', () => {
    const out = resolveEvidence([cite({ sessionId: 'session-other' })], sessionFixture());
    expect(out.evidence).toHaveLength(1);
    expect(out.evidence[0]?.excerptSnapshot).toBeUndefined();
    expect(out.origin).toBe('heuristic');
  });

  it('A: explicit excerpt without a readable log becomes the snapshot', () => {
    const out = resolveEvidence([cite({ sessionId: 'gone', excerpt: '端口是 8899' })], undefined);
    expect(out.evidence[0]?.excerptSnapshot).toBe('端口是 8899');
    expect(out.origin).toBe('cited');
  });

  it('B: pointer into the live log reads back the passage with adjacent context', () => {
    const session = sessionFixture();
    const out = resolveEvidence([cite({ startSeq: 4, endSeq: 4 })], session);
    const snapshot = out.evidence[0]?.excerptSnapshot ?? '';
    expect(out.origin).toBe('cited');
    expect(snapshot).toContain('[4] 端口是 8899，服务名 demo-api');
    // 1–2 adjacent surface events each side.
    expect(snapshot).toContain('[3]');
    expect(snapshot).toContain('[5]');
    // Non-surface events never render.
    expect(snapshot).not.toContain('turn/start');
  });

  it('B: out-of-range seqs clamp into the usable range instead of rejecting (G2)', () => {
    const session = sessionFixture();
    const out = resolveEvidence([cite({ startSeq: 999, endSeq: 1200 })], session);
    expect(out.evidence[0]?.excerptSnapshot).toContain('[7]');
    expect(out.origin).toBe('cited');
  });

  it('B: missing seqs degrade to the latest surface event', () => {
    const session = sessionFixture();
    const out = resolveEvidence([cite({ startSeq: 0, endSeq: 0 })], session);
    expect(out.evidence[0]?.excerptSnapshot).toContain('[7] 另外还有一条');
  });

  it('keeps the snapshot within the hard cap', () => {
    const session = sessionFixture();
    const long = 'x'.repeat(5000);
    const events: Ev[] = [{ type: 'user/message', seq: 1, data: { role: 'user', content: [{ type: 'text', text: long }] } }];
    const out = resolveEvidence([cite({ startSeq: 1, endSeq: 1 })], { id: 'session-1', events });
    expect((out.evidence[0]?.excerptSnapshot ?? '').length).toBeLessThanOrEqual(2000);
  });
});

describe('readCitation (§4 二级承诺)', () => {
  it('reads the full passage back when the cited session is live', () => {
    const session = sessionFixture();
    const read = readCitation(cite({ startSeq: 2, endSeq: 4 }), session);
    expect(read?.degraded).toBe(false);
    expect(read?.text).toContain('[2] 请帮我记住部署端口');
    expect(read?.text).toContain('[4] 端口是 8899');
  });

  it('degrades explicitly to the snapshot when the log is unreachable', () => {
    const read = readCitation(
      cite({ sessionId: 'gone', excerptSnapshot: '[4] 端口是 8899，服务名 demo-api' }),
      sessionFixture(),
    );
    expect(read?.degraded).toBe(true);
    expect(read?.text).toContain('8899');
  });

  it('returns null when neither log nor snapshot exists', () => {
    expect(readCitation(cite({ sessionId: 'gone' }), sessionFixture())).toBeNull();
  });
});

describe('version-chain folding (§2.3 anchor priority)', () => {
  function chain(): SQLiteProvider {
    const store = new SQLiteProvider(`${os.tmpdir()}/engram-fold-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    const now = Date.now();
    const eid = store.insertEntity(
      { name: '端口', nameNorm: '端口', track: 'user', scope: 'global', kind: 'stable', state: 'active' },
      now,
    );
    const kinds = ['create', 'refine', 'refine', 'contradict', 'refine', 'refine', 'refine'];
    kinds.forEach((kind, i) => {
      const rev = i + 1;
      store.insertVersion(
        { entityId: eid, rev, kind, text: `v${rev}`, reason: '', evidence: [], origin: 'heuristic' },
        now + rev,
      );
    });
    store.updateEntityCurrentRev(eid, kinds.length, now);
    return store;
  }

  it('keeps contradict/restore verbatim and folds refines first', () => {
    const store = chain();
    const eid = store.findEntityByName('端口', null)?.id ?? '';
    const node = store.getVersionChain(eid);
    store.close();

    const folded = node[0];
    expect((folded as { type?: string }).type).toBe('folded');
    // refines (and non-anchor kinds) fold first: the folded range never
    // contains a contradict or restore.
    const summaries = (folded as { summaries: Array<{ rev: number; kind: string }> }).summaries;
    for (const s of summaries) {
      expect(s.kind === 'contradict' || s.kind === 'restore').toBe(false);
    }
    // rev4 (contradict) stays verbatim despite being older than folded revs.
    const versions = node.filter((n) => (n as { type?: string }).type !== 'folded') as Array<{ rev: number; kind: string }>;
    expect(versions.some((v) => v.rev === 4 && v.kind === 'contradict')).toBe(true);
    // current stays last.
    expect(versions[versions.length - 1]?.rev).toBe(7);
  });
});

describe('P4 tools (history / expand / rollback)', () => {
  interface Def {
    name: string
    parameters: { properties: Record<string, unknown> }
    execute?: (args: never, exec?: never) => Promise<string>
  }

  function register(service: MemoryService): Def[] {
    const defs: Def[] = [];
    const ctx = {
      get: (key: string) =>
        key === 'tools' ? { register: (def: Def) => defs.push(def) } : undefined,
    } as unknown as Context;
    const deps: ToolDeps = {
      ctx,
      service,
      config: DEFAULT_CONFIG,
      sessionPendings: new Set<string>(),
    };
    registerMemoryTools(deps);
    return defs;
  }

  function seededService(): MemoryService {
    const svc = new MemoryService({ ...DEFAULT_CONFIG, dbPath: ':memory:' });
    const p1 = svc.propose({ name: '端口', text: 'v1', track: 'user', scope: 'global' }, null);
    svc.approve(p1.pendingId, 'a');
    const p2 = svc.propose({ name: '端口', text: 'v2', track: 'user', scope: 'global', action: 'refine' }, null);
    svc.approve(p2.pendingId, 'b');
    return svc;
  }

  it('registers five tools with pre-compiled schemas', () => {
    const defs = register(new MemoryService({ ...DEFAULT_CONFIG, dbPath: ':memory:' }));
    expect(defs.map((d) => d.name)).toEqual([
      'memory_propose',
      'memory_query',
      'memory_history',
      'memory_expand',
      'memory_rollback',
    ]);
    for (const def of defs) {
      expect((def.parameters as { type?: string }).type).toBe('object');
      expect(Array.isArray((def.parameters as { required?: unknown }).required)).toBe(true);
    }
  });

  it('history renders the chain with the current marker', async () => {
    const svc = seededService();
    const defs = register(svc);
    const history = defs.find((d) => d.name === 'memory_history')!;
    const out = await history.execute!({ name: '端口' } as never, undefined as never);
    expect(out).toContain('「端口」版本链');
    expect(out).toContain('rev2 [refine]（当前）');
    expect(out).toContain('rev1 [create]');
  });

  it('history reports a missing entity honestly', async () => {
    const defs = register(new MemoryService({ ...DEFAULT_CONFIG, dbPath: ':memory:' }));
    const history = defs.find((d) => d.name === 'memory_history')!;
    expect(await history.execute!({ name: '不存在' } as never, undefined as never)).toContain('没有名为');
  });

  it('expand explains a heuristic version without evidence', async () => {
    const svc = seededService();
    const defs = register(svc);
    const expand = defs.find((d) => d.name === 'memory_expand')!;
    const out = await expand.execute!({ name: '端口' } as never, undefined as never);
    expect(out).toContain('无原文依据');
  });

  it('rollback proposes a restore and refuses no-op restores', async () => {
    const svc = seededService();
    const defs = register(svc);
    const rollback = defs.find((d) => d.name === 'memory_rollback')!;

    const noop = await rollback.execute!({ name: '端口', rev: 2 } as never, undefined as never);
    expect(noop).toContain('已是当前版本');

    const proposed = await rollback.execute!({ name: '端口', rev: 1, reason: 'v2 有误' } as never, undefined as never);
    expect(proposed).toContain('已提交回滚提案');
    const pending = svc.listProposed()[0];
    expect(pending?.action).toBe('restore');
    expect(pending?.text).toBe('v1');
    expect(pending?.reason).toBe('v2 有误');

    // Approving the restore lands a restore version and moves current_rev back.
    svc.approve(pending!.id, 'c');
    const chain = svc.getVersionChain(svc.listActiveByScope(null, 'stable')[0]!.id);
    const last = chain[chain.length - 1] as MemoryEntity & { kind?: string };
    expect((last as unknown as { rev?: number }).rev ?? (chain[chain.length - 1] as { rev: number }).rev).toBe(3);
    expect((chain[chain.length - 1] as unknown as { kind: string }).kind).toBe('restore');
  });

  it('propose with citations resolves evidence against the live session', async () => {
    const svc = seededService();
    const defs = register(svc);
    const propose = defs.find((d) => d.name === 'memory_propose')!;
    const session = sessionFixture();
    const exec = { agent: { session: { id: session.id, header: { cwd: undefined }, events: session.events } } };
    const out = await propose.execute!(
      {
        name: '端口细节',
        text: '端口 8899',
        track: 'user',
        scope: 'global',
        citations: [{ start_seq: 4, end_seq: 4 }],
      } as never,
      exec as never,
    );
    expect(out).toContain('待审');
    const pending = svc.listProposed().find((p) => p.name === '端口细节');
    expect(pending?.evidence?.[0]?.excerptSnapshot).toContain('8899');
    expect(pending?.evidence?.[0]?.excerptSnapshot).toContain('[3]');
  });
});
