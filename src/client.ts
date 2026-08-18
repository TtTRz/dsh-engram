/**
 * Browser half of dsh-engram: the approval panel.
 *
 * Three surfaces, one shared ApprovalList:
 * - `settings.section` "记忆" — the full approval page (settings panel).
 * - `sidebar.footer.action` — a badge button showing the pending count.
 * - `shell.overlay` — a floating panel reusing ApprovalList (opened from the badge).
 *
 * All three poll `GET /api/engram/pending` and approve/deny via the JSON
 * routes the host half registers; the client never touches store internals.
 *
 * Built to CommonJS and wrapped by `scripts/wrap-client.mjs` into the factory
 * form the web module loader executes.
 * @module dsh-engram/client
 */

import * as React from 'react'

interface SlotRenderProps {
  wide?: boolean
}
interface SlotsService {
  inject(key: string, callback: () => () => void): () => void
  register(
    options: { name: string; id: string; order?: number; label?: string | (() => string) },
    render: (props: SlotRenderProps) => React.ReactNode,
  ): () => void
}
interface TimerService {
  interval(callback: () => void, delay: number): () => void
}

/** Wire shape of `GET /api/engram/pending` (unknown when the host is down). */
interface PendingView {
  id: string
  name: string
  entityId?: string
  action: string
  track: string
  scope: string
  kind: string
  text: string
  baseRev?: number
  currentRev?: number
  conflictWith?: string[]
  createdAt: number
}

const CSS = [
  '.engram-panel { font-family: var(--dsw-font-family, system-ui); }',
  '.engram-panel-empty { color: var(--dsw-alias-label-secondary); padding: 12px 0; }',
  '.engram-item { border: 1px solid var(--dsw-alias-border-subtle); border-radius: 8px; padding: 10px 12px; margin-bottom: 10px; }',
  '.engram-item.drift { border-color: var(--dsw-alias-state-warn-primary); }',
  '.engram-item.conflict { border-left: 3px solid var(--dsw-alias-state-danger-primary); }',
  '.engram-item-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }',
  '.engram-item-name { font-weight: 600; }',
  '.engram-tag { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: var(--dsw-alias-fill-secondary); color: var(--dsw-alias-label-secondary); }',
  '.engram-tag.stable { background: var(--dsw-alias-state-info-secondary); color: var(--dsw-alias-state-info-primary); }',
  '.engram-tag.agent { background: var(--dsw-alias-state-warn-secondary); color: var(--dsw-alias-state-warn-primary); }',
  '.engram-item-text { white-space: pre-wrap; word-break: break-word; margin: 4px 0; }',
  '.engram-warn { font-size: 12px; color: var(--dsw-alias-state-warn-primary); }',
  '.engram-item-actions { display: flex; gap: 8px; margin-top: 8px; }',
  '.engram-btn { border: 1px solid var(--dsw-alias-border-subtle); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 4px 12px; cursor: pointer; font-size: 13px; }',
  '.engram-btn.approve { background: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-contrast); border-color: var(--dsw-alias-state-success-primary); }',
  '.engram-btn:disabled { opacity: 0.5; cursor: default; }',
  '.engram-nav-btn { display: flex; align-items: center; gap: 6px; cursor: pointer; background: transparent; border: none; color: var(--dsw-alias-label-secondary); padding: 7px 12px; border-radius: 8px; font-size: 13px; line-height: 20px; }',
  '.engram-nav-btn:hover { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }',
  '.engram-nav-label { display: flex; align-items: center; gap: 6px; }',
  '.engram-nav-icon { display: inline-flex; flex: none; color: inherit; }',
  '.engram-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--dsw-alias-border-subtle); margin-bottom: 10px; }',
  '.engram-tab { border: none; background: transparent; color: var(--dsw-alias-label-secondary); padding: 6px 12px; cursor: pointer; font-size: 13px; border-bottom: 2px solid transparent; }',
  '.engram-tab.active { color: var(--dsw-alias-label-primary); border-bottom-color: var(--dsw-alias-label-primary); }',
  '.engram-badge { display: inline-flex; align-items: center; border-radius: 4px; padding: 1px 6px; font-size: 11px; background: var(--dsw-alias-fill-secondary); color: var(--dsw-alias-label-secondary); margin-right: 6px; }',
  '.engram-meta { font-size: 12px; color: var(--dsw-alias-label-secondary); margin: 2px 0; }',
  '.engram-chain { margin: 6px 0 0 0; padding: 8px 10px; background: var(--dsw-alias-bg-layer-1); border-radius: 6px; font-size: 12px; }',
  '.engram-chain-item { margin: 4px 0; white-space: pre-wrap; word-break: break-word; }',
].join('\n')

/** Lucide "bookmark" glyph — the memory marker, stroked in currentColor so it follows the nav button's hover/pending color. */
function memoryIcon(): React.ReactNode {
  return React.createElement(
    'svg',
    {
      viewBox: '0 0 24 24',
      width: 16,
      height: 16,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
    },
    React.createElement('path', { d: 'M6 3h12a1 1 0 0 1 1 1v16l-7-4-7 4V4a1 1 0 0 1 1-1z' }),
  )
}

interface Store {
  pendings: PendingView[] | null
}

/** Trivial store + subscription; mirrors the sibling channel plugin's shape. */
function makeStore(): {
  get: () => Store
  set: (patch: Partial<Store>) => void
  subscribe: (listener: () => void) => () => void
} {
  const store: Store = { pendings: null }
  const listeners: Array<() => void> = []
  return {
    get: () => store,
    set: (patch) => {
      Object.assign(store, patch)
      for (const listener of [...listeners]) listener()
    },
    subscribe: (listener) => {
      listeners.push(listener)
      return () => {
        const index = listeners.indexOf(listener)
        if (index >= 0) listeners.splice(index, 1)
      }
    },
  }
}

async function pollPending(): Promise<PendingView[] | null> {
  try {
    const response = await fetch('/api/engram/pending')
    if (!response.ok) return null
    const payload = (await response.json()) as { pendings: PendingView[] }
    return payload.pendings
  } catch {
    return null
  }
}

/** Settle outcome as returned by the approval API (drift / already-settled carry reasons). */
type SettleOutcome =
  | { ok: true }
  | { ok: false; reason?: string; by?: string; drift?: { baseRev?: number; currentRev?: number } }

async function post(path: string, id: string, mode?: 'coexist' | 'merge'): Promise<SettleOutcome | null> {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(mode !== undefined ? { id, mode } : { id }),
    })
    if (!response.ok) return null
    return (await response.json()) as SettleOutcome
  } catch {
    return null
  }
}

/** One pending proposal row, with drift/conflict highlights and approve/deny. */
function ApprovalList(props: { pendings: PendingView[] | null; onChanged: () => void }): React.ReactNode {
  const { pendings, onChanged } = props
  const [notice, setNotice] = React.useState<{ id: string; text: string; warn: boolean } | null>(null)
  if (pendings === null) {
    return React.createElement('div', { className: 'engram-panel-empty' }, '加载中…')
  }
  if (pendings.length === 0) {
    return React.createElement('div', { className: 'engram-panel-empty' }, '暂无待审批的记忆。')
  }
  const settle = (pendingId: string, outcome: SettleOutcome | null, verb: string): void => {
    if (outcome === null) {
      setNotice({ id: pendingId, text: `${verb}请求失败，请重试。`, warn: true })
      return
    }
    if (outcome.ok) {
      setNotice(null)
      onChanged()
      return
    }
    if (outcome.reason === 'drift') {
      setNotice({
        id: pendingId,
        text: `⚠️ 未生效：该记忆被提议后实体已更新（rev ${outcome.drift?.baseRev} → ${outcome.drift?.currentRev}）。请放弃本提案或改为推翻最新版。`,
        warn: true,
      })
      return
    }
    if (outcome.reason === 'already-settled') {
      setNotice({ id: pendingId, text: '该提案已被处理过，列表即将刷新。', warn: false })
      onChanged()
      return
    }
    setNotice({ id: pendingId, text: `未生效：${outcome.reason ?? '未知原因'}`, warn: true })
  }
  return React.createElement(
    'div',
    { className: 'engram-panel' },
    pendings.map((pending) => {
      const drifted =
        pending.baseRev !== undefined &&
        pending.currentRev !== undefined &&
        pending.currentRev !== pending.baseRev
      const conflicted = pending.conflictWith !== undefined && pending.conflictWith.length > 0
      const classes = [
        'engram-item',
        ...(drifted ? ['drift'] : []),
        ...(conflicted ? ['conflict'] : []),
      ].join(' ')
      return React.createElement(
        'div',
        { key: pending.id, className: classes },
        React.createElement(
          'div',
          { className: 'engram-item-head' },
          React.createElement('span', { className: 'engram-item-name' }, pending.name),
          React.createElement('span', { className: 'engram-tag' }, pending.kind),
          React.createElement('span', { className: 'engram-tag' }, pending.track),
          React.createElement('span', { className: 'engram-tag' }, pending.scope),
          React.createElement('span', { className: 'engram-tag' }, pending.action),
        ),
        React.createElement('div', { className: 'engram-item-text' }, pending.text),
        drifted
          ? React.createElement(
              'div',
              { className: 'engram-warn' },
              `⚠️ 实体已从 v${pending.baseRev} 变更到 v${pending.currentRev}，需人工裁决后再批。`,
            )
          : null,
        conflicted
          ? React.createElement(
              'div',
              { className: 'engram-warn' },
              `⚠️ 疑似与 ${pending.conflictWith?.length ?? 0} 条记忆冲突，请裁决。`,
            )
          : null,
        notice !== null && notice.id === pending.id
          ? React.createElement(
              'div',
              { className: notice.warn ? 'engram-warn' : 'engram-panel-empty' },
              notice.text,
            )
          : null,
        React.createElement(
          'div',
          { className: 'engram-item-actions' },
          conflicted
            ? React.createElement(
                'span',
                { className: 'engram-meta', style: { alignSelf: 'center', marginRight: 4 } },
                '裁决：',
              )
            : null,
          conflicted
            ? React.createElement(
                'button',
                {
                  className: 'engram-btn',
                  title: '新内容成立为最新版，旧正文留在版本链',
                  onClick: () => {
                    void post('/api/engram/approve', pending.id).then((outcome) => {
                      settle(pending.id, outcome, '批准')
                    })
                  },
                },
                '① 推翻旧版',
              )
            : React.createElement(
                'button',
                {
                  className: 'engram-btn approve',
                  onClick: () => {
                    void post('/api/engram/approve', pending.id).then((outcome) => {
                      settle(pending.id, outcome, '批准')
                    })
                  },
                },
                '批准',
              ),
          conflicted
            ? React.createElement(
                'button',
                {
                  className: 'engram-btn',
                  title: '同主题独立成链，两条都保留',
                  onClick: () => {
                    void post('/api/engram/approve', pending.id, 'coexist').then((outcome) => {
                      settle(pending.id, outcome, '并存')
                    })
                  },
                },
                '② 并存',
              )
            : null,
          conflicted
            ? React.createElement(
                'button',
                {
                  className: 'engram-btn',
                  title: '本提案正文为准，候选记忆归档留痕',
                  onClick: () => {
                    void post('/api/engram/approve', pending.id, 'merge').then((outcome) => {
                      settle(pending.id, outcome, '合并')
                    })
                  },
                },
                '③ 合并',
              )
            : null,
          React.createElement(
            'button',
            {
              className: 'engram-btn',
              onClick: () => {
                void post('/api/engram/deny', pending.id).then((outcome) => {
                  settle(pending.id, outcome, '拒绝')
                })
              },
            },
            '拒绝',
          ),
        ),
      )
    }),
  )
}

/** One active memory row of the browse tab, with an expandable version chain. */
interface MemoryRow {
  id: string
  name: string
  scope: 'global' | 'workspace'
  kind: 'stable' | 'situational'
  track: string
  workspaceKey: string | null
  rev: number
  state: 'active' | 'archived'
  text: string
  updatedAt: number
  expired: boolean
}

interface ChainResponse {
  id: string
  name: string
  currentRev: number
  chain: Array<
    | { type: 'folded'; rangeFrom: number; rangeTo: number; stats: Record<string, number>; summaries: Array<{ rev: number; kind: string; summary: string }>; citationCount: number }
    | { type: 'version'; rev: number; kind: string; text: string; origin: string; createdAt: number; evidenceCount: number }
  >
}

async function requestDirectDelete(id: string): Promise<{ ok: boolean; error?: string } | null> {
  try {
    const response = await fetch('/api/engram/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    if (!response.ok) return null
    return (await response.json()) as { ok: boolean; error?: string }
  } catch {
    return null
  }
}

async function requestRestore(id: string): Promise<{ ok: boolean; message?: string } | null> {
  try {
    const response = await fetch('/api/engram/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    if (!response.ok) return null
    return (await response.json()) as { ok: boolean; message?: string }
  } catch {
    return null
  }
}

async function fetchMemories(includeArchived: boolean): Promise<MemoryRow[] | null> {
  try {
    const response = await fetch(`/api/engram/memories${includeArchived ? '?archived=1' : ''}`)
    if (!response.ok) return null
    const payload = (await response.json()) as { memories: MemoryRow[] }
    return payload.memories
  } catch {
    return null
  }
}

async function fetchChain(id: string): Promise<ChainResponse | null> {
  try {
    const response = await fetch(`/api/engram/chain?id=${encodeURIComponent(id)}`)
    if (!response.ok) return null
    return (await response.json()) as ChainResponse
  } catch {
    return null
  }
}

async function requestArchive(id: string): Promise<{ ok: boolean; message?: string } | null> {
  try {
    const response = await fetch('/api/engram/archive', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    if (!response.ok) return null
    return (await response.json()) as { ok: boolean; message?: string }
  } catch {
    return null
  }
}

function MemoryList(props: { onProposed?: () => void }): React.ReactNode {
  const [rows, setRows] = React.useState<MemoryRow[] | null>(null)
  const [openChain, setOpenChain] = React.useState<string | null>(null)
  const [chain, setChain] = React.useState<ChainResponse | null>(null)
  const [archiveNotice, setArchiveNotice] = React.useState<{ id: string; text: string; warn: boolean } | null>(null)
  const [showArchived, setShowArchived] = React.useState(false)
  const [tick, setTick] = React.useState(0)

  const load = React.useCallback((): void => {
    void fetchMemories(showArchived).then(setRows)
  }, [showArchived])
  React.useEffect(load, [load, tick])

  if (rows === null) {
    return React.createElement('div', { className: 'engram-panel-empty' }, '加载中…')
  }
  if (rows.length === 0) {
    return React.createElement('div', { className: 'engram-panel-empty' }, '还没有已批准的记忆。')
  }

  const toggleChain = (id: string): void => {
    if (openChain === id) {
      setOpenChain(null)
      setChain(null)
      return
    }
    setOpenChain(id)
    setChain(null)
    void fetchChain(id).then(setChain)
  }

  const toggle = React.createElement(
    'label',
    { className: 'engram-meta', style: { display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', marginBottom: 8 } },
    React.createElement('input', {
      type: 'checkbox',
      checked: showArchived,
      onChange: (event: unknown) => setShowArchived((event as { target: { checked: boolean } }).target.checked),
    }),
    '显示已归档（供审查）',
  )

  return React.createElement(
    'div',
    null,
    toggle,
    React.createElement(
      'div',
      { className: 'engram-panel' },
      rows.map((row) =>
      React.createElement(
        'div',
        { key: row.id, className: 'engram-item' },
        React.createElement(
          'div',
          { className: 'engram-item-title' },
          React.createElement('span', { className: 'engram-badge' }, `${row.scope}/${row.kind}`),
          row.expired ? React.createElement('span', { className: 'engram-badge' }, '已过期·需核实') : null,
          row.state === 'archived' ? React.createElement('span', { className: 'engram-badge' }, '已归档') : null,
          row.name,
        ),
        React.createElement('div', { className: 'engram-item-text' }, row.text),
        React.createElement(
          'div',
          { className: 'engram-meta' },
          `rev ${row.rev} · ${row.track === 'user' ? '用户提供' : '模型总结'} · 更新于 ${new Date(row.updatedAt).toLocaleString()}${row.workspaceKey !== null ? ` · 仓库 ${row.workspaceKey.slice(0, 8)}` : ''}`,
        ),
        React.createElement(
          'div',
          { className: 'engram-item-actions' },
          React.createElement(
            'button',
            { className: 'engram-btn', onClick: () => toggleChain(row.id) },
            openChain === row.id ? '收起历史' : '查看历史',
          ),
          row.state === 'archived'
            ? React.createElement(
                'button',
                {
                  className: 'engram-btn',
                  onClick: () => {
                    setArchiveNotice({ id: row.id, text: '正在提交恢复提案…', warn: false })
                    void requestRestore(row.id).then((outcome) => {
                      if (outcome === null || !outcome.ok) {
                        setArchiveNotice({ id: row.id, text: '提交恢复提案失败，请重试。', warn: true })
                        return
                      }
                      setArchiveNotice({
                        id: row.id,
                        text: '已提交恢复提案：请到「待审批」中批准，批准后该记忆将重新生效。',
                        warn: false,
                      })
                      props.onProposed?.()
                      setTick((t) => t + 1)
                    })
                  },
                },
                '恢复',
              )
            : React.createElement(
                'button',
                {
                  className: 'engram-btn',
                  onClick: () => {
                    const confirmed =
                      typeof window !== 'undefined'
                        ? window.confirm(`确定删除「${row.name}」？\n立即生效，可在「显示已归档」中恢复。`)
                        : true
                    if (!confirmed) return
                    setArchiveNotice({ id: row.id, text: '正在删除…', warn: false })
                    void requestDirectDelete(row.id).then((outcome) => {
                  if (outcome === null || !outcome.ok) {
                    setArchiveNotice({ id: row.id, text: '删除失败，请重试。', warn: true })
                    return
                  }
                  setArchiveNotice({
                    id: row.id,
                    text: '已删除：在「显示已归档」中可审查或恢复。',
                    warn: false,
                  })
                  setTick((t) => t + 1)
                })
              },
            },
            '删除',
              ),
        ),
        archiveNotice !== null && archiveNotice.id === row.id
          ? React.createElement(
              'div',
              { className: archiveNotice.warn ? 'engram-warn' : 'engram-meta' },
              archiveNotice.text,
            )
          : null,
        openChain === row.id
          ? chain === null
            ? React.createElement('div', { className: 'engram-meta' }, '加载版本链…')
            : React.createElement(
                'div',
                { className: 'engram-chain' },
                chain.chain.map((node, index) =>
                  React.createElement(
                    'div',
                    { key: index, className: 'engram-chain-item' },
                    node.type === 'folded'
                      ? `[折叠 rev${node.rangeFrom}–${node.rangeTo}] ${Object.entries(node.stats).map(([k, v]) => `${k}×${v}`).join(' ')} · ${node.citationCount} 条依据指针\n${node.summaries.map((x) => `rev${x.rev}: ${x.summary}`).join(' / ')}`
                      : `rev${node.rev} [${node.kind}]${node.rev === chain.currentRev ? '（当前）' : ''} · 依据 ${node.evidenceCount} 条（origin=${node.origin}）\n${node.text}`,
                  ),
                ),
              )
          : null,
      ),
    ),
    ),
  )
}

export function apply(ctx: {
  get(name: 'slots'): SlotsService | undefined
  get(name: 'timer'): TimerService | undefined
  get(name: string): unknown
  effect(callback: () => () => void, label?: string): () => void
}): void {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  const timer = ctx.get('timer')

  ctx.effect(() => {
    const element = document.createElement('style')
    element.textContent = CSS
    document.head.append(element)
    return () => element.remove()
  }, 'dsh-engram.client-style')

  const store = makeStore()
  const refresh = async (): Promise<void> => {
    store.set({ pendings: await pollPending() })
  }

  function useStore(): void {
    const [, force] = React.useState(0)
    React.useEffect(() => store.subscribe(() => force((value) => value + 1)), [])
  }

  function refreshAfter(): void {
    void refresh()
  }

  // 1. Full approval page in the settings panel.
  slots.inject('settings.section', () =>
    slots.register(
      { name: 'settings.section', id: 'engram-memory', order: 30, label: '记忆审批' },
      () => {
        function Section(): React.ReactNode {
          useStore()
          const [tab, setTab] = React.useState<'pending' | 'memories'>('pending')
          React.useEffect(() => {
            void refresh()
            if (timer === undefined) return undefined
            return timer.interval(() => void refresh(), 5000)
          }, [])
          const pendingCount = store.get().pendings?.length ?? 0
          return React.createElement(
            'div',
            null,
            React.createElement(
              'div',
              { className: 'engram-tabs' },
              React.createElement(
                'button',
                { className: `engram-tab${tab === 'pending' ? ' active' : ''}`, onClick: () => setTab('pending') },
                `待审批（${pendingCount}）`,
              ),
              React.createElement(
                'button',
                { className: `engram-tab${tab === 'memories' ? ' active' : ''}`, onClick: () => setTab('memories') },
                '已有记忆',
              ),
            ),
            tab === 'pending'
              ? React.createElement(ApprovalList, {
                  pendings: store.get().pendings,
                  onChanged: refreshAfter,
                })
              : React.createElement(MemoryList, { onProposed: refresh }),
          )
        }
        return React.createElement(Section)
      },
    ),
  )

  // 2. Badge button in the sidebar foot (pending count, opens the overlay).
  let overlayOpen = false
  const overlayStore = makeStore()
  const setOverlayOpen = (value: boolean): void => {
    if (overlayOpen === value) return
    overlayOpen = value
    overlayStore.set({ pendings: store.get().pendings })
  }
  function useOverlay(): void {
    const [, force] = React.useState(0)
    React.useEffect(() => overlayStore.subscribe(() => force((value) => value + 1)), [])
  }

  slots.inject('sidebar.footer.action', () =>
    slots.register({ name: 'sidebar.footer.action', id: 'engram-approve', order: 70 }, (slotProps) => {
      function Badge(): React.ReactNode {
        useStore()
        React.useEffect(() => {
          void refresh()
          if (timer === undefined) return undefined
          return timer.interval(() => void refresh(), 10000)
        }, [])
        const count = store.get().pendings?.length ?? 0
        const hasPending = count > 0
        const wide = slotProps.wide === true
        return React.createElement(
          'button',
          {
            type: 'button',
            className: 'engram-nav-btn',
            title: hasPending ? `记忆审批：${count} 条待批` : '记忆审批',
            onClick: () => setOverlayOpen(true),
          },
          React.createElement(
            'span',
            {
              className: 'engram-nav-icon',
              style: hasPending ? { color: 'var(--dsw-alias-state-warn-primary)' } : undefined,
            },
            memoryIcon(),
          ),
          wide
            ? React.createElement(
                'span',
                { className: 'engram-nav-label' },
                '记忆',
              )
            : null,
        )
      }
      return React.createElement(Badge)
    }),
  )

  // 3. Floating overlay reusing the same list (opened from the badge).
  slots.inject('shell.overlay', () =>
    slots.register({ name: 'shell.overlay', id: 'engram-approve-panel', order: 50 }, () => {
      function Overlay(): React.ReactNode {
        useOverlay()
        useStore()
        if (!overlayOpen) return null
        return React.createElement(
          'div',
          {
            style: {
              position: 'fixed',
              right: 16,
              bottom: 16,
              width: 420,
              maxHeight: '70vh',
              overflowY: 'auto',
              background: 'var(--dsw-alias-bg-layer-2)',
              border: '1px solid var(--dsw-alias-border-subtle)',
              borderRadius: 12,
              padding: 16,
              boxShadow: 'var(--dsw-alias-shadow-floating)',
              zIndex: 1000,
            },
          },
          React.createElement(
            'div',
            {
              style: {
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 12,
              },
            },
            React.createElement('strong', null, '记忆审批'),
            React.createElement(
              'button',
              { className: 'engram-btn', onClick: () => setOverlayOpen(false), 'aria-label': '关闭' },
              '×',
            ),
          ),
          React.createElement(ApprovalList, {
            pendings: store.get().pendings,
            onChanged: refreshAfter,
          }),
        )
      }
      return React.createElement(Overlay)
    }),
  )
}
