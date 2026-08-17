/**
 * Approval JSON API — the panel's data face (P1a).
 *
 * Exposes the single approval endpoint over the harness web server. No auth:
 * open approval by design (I-8); `user` is recorded for audit only.
 * Every write still funnels through MemoryService.approve/deny — there is no
 * store direct-write surface.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { MemoryService } from './service.js'

interface WebServerLike {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
  }): () => void
}

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
  /** Entity's current_rev at listing time — the panel compares to baseRev. */
  currentRev?: number
  conflictWith?: string[]
  createdAt: number
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 1024 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.trim().length === 0) {
        resolve({})
        return
      }
      try {
        resolve(JSON.parse(raw) as Record<string, unknown>)
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

/** The panel's pending queue: proposed rows plus drift-relevant current_rev. */
function pendingView(service: MemoryService): PendingView[] {
  return service.listProposed().map((pending) => {
    const view: PendingView = {
      id: pending.id,
      name: pending.name,
      action: pending.action,
      track: pending.track,
      scope: pending.scope,
      kind: pending.kind,
      text: pending.text,
      createdAt: pending.createdAt,
    }
    if (pending.entityId !== undefined) {
      view.entityId = pending.entityId
      const entity = service.getEntity(pending.entityId)
      if (entity !== null) view.currentRev = entity.currentRev
    }
    if (pending.baseRev !== undefined) view.baseRev = pending.baseRev
    if (pending.conflictWith !== undefined) view.conflictWith = pending.conflictWith
    return view
  })
}

/**
 * Register the approval routes. Returns a disposer that unregisters them.
 * The service instance is captured in the closure — never exposed on ctx.
 */
export function registerEngramRoutes(
  ctx: Context,
  service: MemoryService,
  resolveWorkspaceKey: () => string | null,
): () => void {
  const webServer = ctx.get('webServer') as WebServerLike | undefined
  if (webServer === undefined) return () => undefined

  const disposers: Array<() => void> = []

  disposers.push(
    webServer.register({
      kind: 'exact',
      path: '/api/engram/pending',
      handler: (_req, res) => {
        send(res, 200, { pendings: pendingView(service) })
      },
    }),
  )

  disposers.push(
    webServer.register({
      kind: 'exact',
      path: '/api/engram/approve',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const id = body.id
          if (typeof id !== 'string' || id.length === 0) {
            send(res, 400, { ok: false, error: 'id is required' })
            return
          }
          const user = typeof body.user === 'string' ? body.user : undefined
          const outcome = service.approve(id, user, resolveWorkspaceKey())
          send(res, 200, outcome)
        } catch (error) {
          send(res, 500, { ok: false, error: String(error) })
        }
      },
    }),
  )

  disposers.push(
    webServer.register({
      kind: 'exact',
      path: '/api/engram/deny',
      handler: async (req, res) => {
        try {
          const body = await readJsonBody(req)
          const id = body.id
          if (typeof id !== 'string' || id.length === 0) {
            send(res, 400, { ok: false, error: 'id is required' })
            return
          }
          const user = typeof body.user === 'string' ? body.user : undefined
          const outcome = service.deny(id, user)
          send(res, 200, outcome)
        } catch (error) {
          send(res, 500, { ok: false, error: String(error) })
        }
      },
    }),
  )

  return () => {
    for (const dispose of disposers) dispose()
  }
}
