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
  '.engram-nav-count { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--dsw-alias-fill-secondary); color: var(--dsw-alias-label-primary); font-size: 11px; font-weight: 600; line-height: 1; }',
  '.engram-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; flex: none; }',
].join('\n')

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

async function post(path: string, id: string): Promise<boolean> {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    return response.ok
  } catch {
    return false
  }
}

/** One pending proposal row, with drift/conflict highlights and approve/deny. */
function ApprovalList(props: { pendings: PendingView[] | null; onChanged: () => void }): React.ReactNode {
  const { pendings, onChanged } = props
  if (pendings === null) {
    return React.createElement('div', { className: 'engram-panel-empty' }, '加载中…')
  }
  if (pendings.length === 0) {
    return React.createElement('div', { className: 'engram-panel-empty' }, '暂无待审批的记忆。')
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
        React.createElement(
          'div',
          { className: 'engram-item-actions' },
          React.createElement(
            'button',
            {
              className: 'engram-btn approve',
              onClick: () => {
                void post('/api/engram/approve', pending.id).then((ok) => {
                  if (ok) onChanged()
                })
              },
            },
            '批准',
          ),
          React.createElement(
            'button',
            {
              className: 'engram-btn',
              onClick: () => {
                void post('/api/engram/deny', pending.id).then((ok) => {
                  if (ok) onChanged()
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
          React.useEffect(() => {
            void refresh()
            if (timer === undefined) return undefined
            return timer.interval(() => void refresh(), 5000)
          }, [])
          return React.createElement(ApprovalList, {
            pendings: store.get().pendings,
            onChanged: refreshAfter,
          })
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
    slots.register({ name: 'sidebar.footer.action', id: 'engram-approve', order: 70 }, () => {
      function Badge(props: SlotRenderProps): React.ReactNode {
        useStore()
        React.useEffect(() => {
          void refresh()
          if (timer === undefined) return undefined
          return timer.interval(() => void refresh(), 10000)
        }, [])
        const count = store.get().pendings?.length ?? 0
        const hasPending = count > 0
        const dotColor = hasPending
          ? 'var(--dsw-alias-state-warn-primary)'
          : 'var(--dsw-alias-label-secondary)'
        return React.createElement(
          'button',
          {
            type: 'button',
            className: 'engram-nav-btn',
            title: hasPending ? `记忆审批：${count} 条待批` : '记忆审批',
            onClick: () => setOverlayOpen(true),
          },
          React.createElement('span', { className: 'engram-dot', style: { background: dotColor } }),
          props.wide === true
            ? React.createElement(
                'span',
                { className: 'engram-nav-label' },
                '记忆',
                hasPending
                  ? React.createElement('span', { className: 'engram-nav-count' }, String(count))
                  : null,
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
