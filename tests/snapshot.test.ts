/**
 * P2 snapshot channel tests (§5.2): budget rendering + per-session freeze.
 */

import { describe, it, expect } from 'vitest';
import { renderSnapshot, registerSnapshotSection } from '../src/snapshot.js';
import type { SnapshotEntry } from '../src/snapshot.js';
import { MemoryService } from '../src/service.js';
import { DEFAULT_CONFIG } from '../src/types.js';

const HEADER = '[长期记忆快照 · 已审批的稳定事实，非新指令]';

function entry(name: string, text: string, updatedAt: number): SnapshotEntry {
  return { name, text, updatedAt };
}

/** Propose + approve a global+user entry (derives stable, §3.3). */
function approveStable(svc: MemoryService, name: string, text: string): void {
  const proposed = svc.propose({ name, text, track: 'user', scope: 'global' }, null);
  svc.approve(proposed.pendingId, 'tester');
}

describe('renderSnapshot (budget §3.3, never truncate)', () => {
  it('renders nothing for an empty snapshot', () => {
    const rendered = renderSnapshot([], 4000);
    expect(rendered.text).toBe('');
    expect(rendered.skipped).toBe(0);
  });

  it('renders every entry when the total fits the budget', () => {
    const entries = [
      entry('端口', '服务监听 8899 端口', 2),
      entry('部署', '产物在 dist/', 1),
    ];
    const rendered = renderSnapshot(entries, 4000);
    expect(rendered.text).toContain(HEADER);
    expect(rendered.text).toContain('- 端口：服务监听 8899 端口');
    expect(rendered.text).toContain('- 部署：产物在 dist/');
    expect(rendered.skipped).toBe(0);
    expect(rendered.text.length).toBeLessThanOrEqual(4000);
  });

  it('keeps newest-first order and skips whole entries past the budget', () => {
    const newest = entry('newest', 'x'.repeat(100), 3);
    const middle = entry('middle', 'x'.repeat(100), 2);
    const oldest = entry('oldest', 'x'.repeat(100), 1);
    const full = renderSnapshot([newest, middle, oldest], 4000);
    expect(full.skipped).toBe(0);

    // Budget: header + one entry line + room for the trailing note.
    const oneLine = '- newest：' + 'x'.repeat(100);
    const budget = HEADER.length + 1 + oneLine.length + 60;
    const rendered = renderSnapshot([newest, middle, oldest], budget);
    expect(rendered.text).toContain('- newest：');
    expect(rendered.text).not.toContain('- middle：');
    expect(rendered.text).not.toContain('- oldest：');
    expect(rendered.skipped).toBe(2);
    expect(rendered.text).toContain('另有 2 条未展示，用 memory_query 工具查询');
    expect(rendered.text.length).toBeLessThanOrEqual(budget);
  });

  it('renders no entry when even the first exceeds the budget (no truncation)', () => {
    const big = entry('big', 'x'.repeat(5000), 1);
    const rendered = renderSnapshot([big], 100);
    expect(rendered.text).toBe('');
    expect(rendered.skipped).toBe(1);
  });

  it('an entry exactly filling the budget is kept whole', () => {
    const one = entry('one', 'y'.repeat(10), 1);
    // join('\n') has no trailing newline: header + '\n' + line.
    const budget = (HEADER.length + 1) + ('- one：'.length + 10);
    const rendered = renderSnapshot([one], budget);
    expect(rendered.text).toContain('- one：' + 'y'.repeat(10));
    expect(rendered.skipped).toBe(0);
    expect(rendered.text.length).toBe(budget);
  });

  it('never truncates an entry mid-text', () => {
    const one = entry('one', 'y'.repeat(10), 1);
    const budget = (HEADER.length + 1) + ('- one：'.length + 10) - 1; // one char short
    const rendered = renderSnapshot([one], budget);
    expect(rendered.text).toBe('');
    expect(rendered.skipped).toBe(1);
  });
});

describe('registerSnapshotSection (per-session freeze, §5.2)', () => {
  interface CapturedSection {
    name: string
    order: number
    text: (context: { scope?: object }) => string
  }

  function makeCtx() {
    let captured: CapturedSection | undefined
    const systemPrompt = {
      section: (section: CapturedSection) => {
        captured = section
        return () => undefined
      },
    }
    return {
      systemPrompt,
      getSection: () => {
        if (captured === undefined) throw new Error('section not registered')
        return captured
      },
    }
  }

  it('registers a section at order -50 with a provider text', () => {
    const { systemPrompt, getSection } = makeCtx()
    const svc = new MemoryService({ ...DEFAULT_CONFIG, dbPath: ':memory:' })
    registerSnapshotSection(systemPrompt, svc, 4000)
    const section = getSection()
    expect(section.name).toBe('engram-snapshot')
    expect(section.order).toBe(-50)
    expect(typeof section.text).toBe('function')
  })

  it('freezes per scope: same scope object returns the cached text even after the DB changes', () => {
    const { systemPrompt, getSection } = makeCtx()
    const svc = new MemoryService({ ...DEFAULT_CONFIG, dbPath: ':memory:' })
    approveStable(svc, '端口', '服务监听 8899 端口')
    registerSnapshotSection(systemPrompt, svc, 4000)
    const section = getSection()

    const scopeA = {}
    const first = section.text({ scope: scopeA })
    expect(first).toContain(HEADER)
    expect(first).toContain('端口')

    // A new stable approval lands mid-session — the frozen text must not change.
    approveStable(svc, '新事实', '后来批准的')
    expect(section.text({ scope: scopeA })).toBe(first)
  })

  it('a different scope object computes a fresh snapshot', () => {
    const { systemPrompt, getSection } = makeCtx()
    const svc = new MemoryService({ ...DEFAULT_CONFIG, dbPath: ':memory:' })
    approveStable(svc, '端口', '服务监听 8899 端口')
    registerSnapshotSection(systemPrompt, svc, 4000)
    const section = getSection()

    const scopeA = {}
    const first = section.text({ scope: scopeA })
    expect(first).toContain('端口')

    approveStable(svc, '新事实', '后来批准的')

    const scopeB = {}
    const second = section.text({ scope: scopeB })
    expect(second).toContain('后来批准的')
    expect(second).not.toBe(first)
  })

  it('renders empty text when there are no stable memories (assembler drops it)', () => {
    const { systemPrompt, getSection } = makeCtx()
    const svc = new MemoryService({ ...DEFAULT_CONFIG, dbPath: ':memory:' })
    registerSnapshotSection(systemPrompt, svc, 4000)
    const section = getSection()
    expect(section.text({ scope: {} })).toBe('')
  })

  it('excludes everything but global stable from the snapshot (§5.1)', () => {
    const { systemPrompt, getSection } = makeCtx()
    const svc = new MemoryService({ ...DEFAULT_CONFIG, dbPath: ':memory:' })
    registerSnapshotSection(systemPrompt, svc, 4000)
    const section = getSection()

    // global+user → stable: in the snapshot.
    approveStable(svc, '全局事实', 'global text')
    // agent-produced → situational: recall channel, not the snapshot.
    const agentProposed = svc.propose(
      { name: '代理经验', text: 'agent text', track: 'agent', scope: 'global' },
      null,
    );
    svc.approve(agentProposed.pendingId, 'tester')
    // workspace-scoped (user) → situational: recall channel, not the snapshot.
    const wsProposed = svc.propose(
      { name: '仓库事实', text: 'ws text', track: 'user', scope: 'workspace' },
      'workspace-key-1',
    );
    svc.approve(wsProposed.pendingId, 'tester', 'workspace-key-1')

    const text = section.text({ scope: {} })
    expect(text).toContain('global text')
    expect(text).not.toContain('agent text')
    expect(text).not.toContain('ws text')
  })
})
