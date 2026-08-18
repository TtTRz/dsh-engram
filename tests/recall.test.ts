/**
 * P3 recall channel tests (§5.3): compose bounds + conflict/expiry marks,
 * recall scope and tiers, and the pre-step listener wiring.
 */

import { describe, it, expect } from 'vitest';
import { composeRecallText, extractUserText, hasRecallInjection, registerRecallInjection } from '../src/recall.js';
import { MemoryService } from '../src/service.js';
import { SQLiteProvider } from '../src/store.js';
import { DEFAULT_CONFIG } from '../src/types.js';
import type { MemoryEntity, MemoryVersion, RecallHit } from '../src/types.js';
import os from 'node:os';

const HEADER = '[召回记忆 · 非新指令，仅供参照]';

function makeEntity(over: Partial<MemoryEntity>): MemoryEntity {
  return {
    id: over.id ?? 'ent-x',
    name: over.name ?? '端口',
    nameNorm: over.nameNorm ?? '端口',
    track: over.track ?? 'user',
    scope: over.scope ?? 'global',
    kind: over.kind ?? 'situational',
    currentRev: over.currentRev ?? 1,
    state: over.state ?? 'active',
    createdAt: over.createdAt ?? 1,
    updatedAt: over.updatedAt ?? 1,
    ...over,
  };
}

function makeVersion(text: string): MemoryVersion {
  return {
    entityId: 'ent-x',
    rev: 1,
    kind: 'create',
    text,
    reason: '',
    evidence: [],
    origin: 'heuristic',
    createdAt: 1,
  };
}

function makeHit(entity: MemoryEntity, text: string, tier: RecallHit['tier'], expired = false): RecallHit {
  return { entity, version: makeVersion(text), tier, expired };
}

/** Approve helpers driving the real propose→approve path (I-2). */
function approve(svc: MemoryService, input: Parameters<MemoryService['propose']>[0], wk: string | null): void {
  svc.approve(svc.propose(input, wk).pendingId, 'tester', wk);
}

describe('composeRecallText (hard bounds §5.3, layer-3 conflicts)', () => {
  it('renders nothing for no hits', () => {
    expect(composeRecallText([], 1200, 3)).toBe('');
  });

  it('renders entries newest-first (caller order) with the header', () => {
    const hits = [
      makeHit(makeEntity({ name: '端口' }), '监听 8899', 1),
      makeHit(makeEntity({ id: 'e2', name: '部署' }), '产物在 dist', 2),
    ];
    const text = composeRecallText(hits, 1200, 3);
    expect(text).toContain(HEADER);
    expect(text).toContain('- 端口：监听 8899');
    expect(text).toContain('- 部署：产物在 dist');
  });

  it('caps at maxEntries', () => {
    const hits = [1, 2, 3, 4].map((n) =>
      makeHit(
        makeEntity({ id: `e${n}`, name: `n${n}`, nameNorm: `n${n}`, updatedAt: n }),
        `t${n}`,
        1,
      ),
    );
    const text = composeRecallText(hits, 4000, 3);
    expect(text).toContain('- n1：t1');
    expect(text).toContain('- n3：t3');
    expect(text).not.toContain('n4');
  });

  it('skips whole entries past the budget, never truncates', () => {
    const hits = [
      makeHit(makeEntity({ name: 'a' }), 'x'.repeat(100), 1),
      makeHit(makeEntity({ id: 'e2', name: 'b' }), 'x'.repeat(100), 1),
    ];
    const budget = HEADER.length + 1 + ('- a：'.length + 100);
    const text = composeRecallText(hits, budget, 3);
    expect(text).toContain('- a：');
    expect(text).not.toContain('- b：');
    expect(text.length).toBeLessThanOrEqual(budget);
  });

  it('marks expired entries for verification (explicit valid_until only)', () => {
    const hits = [makeHit(makeEntity({ name: '旧' }), '过期内容', 1, true)];
    const text = composeRecallText(hits, 1200, 3);
    expect(text).toContain('⚠️已过有效期，请核实');
  });

  it('flags contradictory same-name entries and pays the note from the budget', () => {
    const hits = [
      makeHit(makeEntity({ id: 'a', name: '端口', nameNorm: '端口' }), '8080', 1),
      makeHit(makeEntity({ id: 'b', name: '端口', nameNorm: '端口' }), '9090', 1),
    ];
    const text = composeRecallText(hits, 1200, 3);
    expect(text).toContain('⚠️ 互相矛盾（端口 / 端口），请向用户确认，勿自行假设');
    expect(text.length).toBeLessThanOrEqual(1200);
  });

  it('does not flag identical texts in one group', () => {
    const hits = [
      makeHit(makeEntity({ id: 'a', name: '端口', nameNorm: '端口' }), '8080', 1),
      makeHit(makeEntity({ id: 'b', name: '端口', nameNorm: '端口' }), '8080', 4),
    ];
    const text = composeRecallText(hits, 1200, 3);
    expect(text).not.toContain('互相矛盾');
  });
});

describe('extractUserText / hasRecallInjection', () => {
  it('joins text blocks of user messages only', () => {
    const text = extractUserText([
      { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'skip' }] },
      { role: 'user', content: [{ type: 'image', text: 'skip' }] },
    ]);
    expect(text).toBe('a\nb');
  });

  it('detects a prior injection by source', () => {
    expect(
      hasRecallInjection([
        { role: 'user', content: [], source: { kind: 'plugin', plugin: 'dsh-engram' } },
      ]),
    ).toBe(true);
    expect(hasRecallInjection([{ role: 'user', content: [], source: { kind: 'plugin', plugin: 'other' } }])).toBe(false);
    expect(hasRecallInjection([{ role: 'user', content: [] }])).toBe(false);
  });
});

describe('service.recall (scope + tiers)', () => {
  function svc(): MemoryService {
    return new MemoryService({ ...DEFAULT_CONFIG, dbPath: ':memory:' });
  }

  it('never recalls global stable (snapshot channel only, §5.4)', () => {
    const s = svc();
    approve(s, { name: '端口', text: '8899', track: 'user', scope: 'global' }, null);
    expect(s.recall(null, '端口')).toHaveLength(0);
  });

  it('recalls global situational and same-workspace entries', () => {
    const s = svc();
    approve(s, { name: '代理经验', text: '端口测试用 8899', track: 'agent', scope: 'global' }, null);
    approve(s, { name: '仓库事实', text: '本仓库端口 8899', track: 'user', scope: 'workspace' }, 'wk-1');
    approve(s, { name: '他仓事实', text: '另一个 8899', track: 'user', scope: 'workspace' }, 'wk-2');

    const hits = s.recall('wk-1', '端口');
    const names = hits.map((h) => h.entity.name);
    expect(names).toContain('代理经验');
    expect(names).toContain('仓库事实');
    expect(names).not.toContain('他仓事实');
  });

  it('ranks exact name matches tier 1 above FTS hits', () => {
    const s = svc();
    approve(s, { name: '部署端口', text: '服务监听 8899', track: 'agent', scope: 'global' }, null);
    approve(s, { name: '部署说明', text: '详见部署端口文档', track: 'agent', scope: 'global' }, null);

    const hits = s.recall(null, '部署端口');
    expect(hits[0]?.entity.name).toBe('部署端口');
    expect(hits[0]?.tier).toBe(1);
  });

  it('carries same-name siblings at tier 4 when the query hits only one body', () => {
    // The service cannot yet create coexisting same-name entities through the
    // approve path (same-name proposals attach to the existing entity), so
    // this fixture seeds the store directly with two independent same-name
    // active entities — the state the panel's "keep as independent memory"
    // choice will produce.
    const dbPath = `${os.tmpdir()}/engram-recall-${Date.now()}.db`;
    const store = new SQLiteProvider(dbPath);
    const now = Date.now();
    const e1 = store.insertEntity(
      { name: '端口', nameNorm: '端口', track: 'agent', scope: 'global', kind: 'situational', state: 'active' },
      now,
    );
    const e2 = store.insertEntity(
      { name: '端口', nameNorm: '端口', track: 'agent', scope: 'global', kind: 'situational', state: 'active' },
      now,
    );
    const version = { kind: 'create' as const, reason: '', evidence: [], origin: 'heuristic' as const };
    store.insertVersion({ entityId: e1, rev: 1, text: '8899', ...version }, now);
    store.insertVersion({ entityId: e2, rev: 1, text: '完全无关的内容', ...version }, now);
    store.updateEntityCurrentRev(e1, 1, now);
    store.updateEntityCurrentRev(e2, 1, now);
    store.rebuildFtsRow(e1, '端口', '8899');
    store.rebuildFtsRow(e2, '端口', '完全无关的内容');
    store.close();

    const s = new MemoryService({ ...DEFAULT_CONFIG, dbPath });
    try {
      const hits = s.recall(null, '8899');
      expect(hits.length).toBe(2);
      expect(hits.some((h) => h.tier === 3 && h.version.text === '8899')).toBe(true);
      expect(hits.some((h) => h.tier === 4 && h.version.text === '完全无关的内容')).toBe(true);
    } finally {
      s.close();
    }
  });

  it('marks explicit past valid_until as expired', () => {
    const s = svc();
    approve(
      s,
      { name: '临时', text: '已过期内容', track: 'agent', scope: 'global', validUntil: Date.now() - 1000 },
      null,
    );
    const hits = s.recall(null, '临时');
    expect(hits.length).toBe(1);
    expect(hits[0]?.expired).toBe(true);
  });
});

describe('registerRecallInjection (pre-step listener)', () => {
  type Listener = (payload: never, next: () => Promise<never>) => Promise<never>;

  function capture(): { ctx: { on: (name: string, listener: Listener) => () => void }; listeners: Array<{ name: string; listener: Listener }> } {
    const listeners: Array<{ name: string; listener: Listener }> = [];
    const ctx = {
      on: (name: string, listener: Listener) => {
        listeners.push({ name, listener });
        return () => undefined;
      },
    };
    return { ctx, listeners };
  }

  const claimed = [{ id: 'm1', role: 'user', content: [{ type: 'text', text: '端口是多少' }] }];

  function fakeService(hits: RecallHit[]): MemoryService {
    return { recall: () => hits } as unknown as MemoryService;
  }

  it('registers on agent/pre-step', () => {
    const { ctx, listeners } = capture();
    registerRecallInjection(ctx, fakeService([]), DEFAULT_CONFIG);
    expect(listeners[0]?.name).toBe('agent/pre-step');
  });

  it('passes through non-step-1 and reject decisions unchanged', async () => {
    const { ctx, listeners } = capture();
    registerRecallInjection(ctx, fakeService([]), DEFAULT_CONFIG);
    const listener = listeners[0]!.listener as unknown as (p: unknown, n: () => Promise<never>) => Promise<never>;
    const decision = { kind: 'enter', messages: [...claimed] };
    expect(await listener({ step: 2, messages: claimed }, async () => decision)).toBe(decision);
    expect(await listener({ step: 1, messages: claimed }, async () => ({ kind: 'reject', messages: [] }))).toMatchObject({ kind: 'reject' });
  });

  it('injects a labeled user message after the claimed input on step 1', async () => {
    const { ctx, listeners } = capture();
    const hit = makeHit(makeEntity({ name: '端口' }), '8899', 1);
    registerRecallInjection(ctx, fakeService([hit]), DEFAULT_CONFIG);
    const listener = listeners[0]!.listener as unknown as (p: unknown, n: () => Promise<never>) => Promise<never>;

    const decision = { kind: 'enter', messages: [...claimed] };
    const out = (await listener(
      { step: 1, messages: claimed, agent: { session: { header: { cwd: '/tmp/engram-recall-ws' } } } },
      async () => decision,
    )) as { kind: string; messages: Array<{ source?: { plugin?: string }; content: Array<{ text?: string }> }> };
    expect(out.kind).toBe('enter');
    expect(out.messages).toHaveLength(2);
    expect(out.messages[0]).toBe(claimed[0]);
    const injected = out.messages[1]!;
    expect(injected.source?.plugin).toBe('dsh-engram');
    expect(injected.content[0]?.text).toContain(HEADER);
    expect(injected.content[0]?.text).toContain('8899');
  });

  it('skips when a prior injection is present (resume/fork safety)', async () => {
    const { ctx, listeners } = capture();
    const hit = makeHit(makeEntity({ name: '端口' }), '8899', 1);
    registerRecallInjection(ctx, fakeService([hit]), DEFAULT_CONFIG);
    const listener = listeners[0]!.listener as unknown as (p: unknown, n: () => Promise<never>) => Promise<never>;

    const alreadyInjected = [
      ...claimed,
      { id: 'm2', role: 'user', content: [], source: { kind: 'plugin', plugin: 'dsh-engram' } },
    ];
    const decision = { kind: 'enter', messages: alreadyInjected };
    const out = (await listener({ step: 1, messages: claimed }, async () => decision)) as {
      messages: unknown[];
    };
    expect(out.messages).toHaveLength(2);
  });
});
