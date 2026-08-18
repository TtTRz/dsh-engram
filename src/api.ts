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
 * Register the approval routes for the panel (P1a).
 *
 * `webServer` is an *optional* service for us: a static `inject: ['webServer']`
 * would keep the whole plugin waiting on profiles that never provide one
 * (TUI), and a strict `ctx.get('webServer')` inside our own fiber's effect
 * runs before the provider's fiber is active — both silently drop the routes
 * (this shipped as the settings panel 404).
 *
 * Runtime injection defers only the routes: the callback fiber applies once
 * the service appears (immediately when already present), and cordis
 * registers the child fiber's disposal as a parent effect, so stopping the
 * plugin unregisters every route.
 */
export function registerEngramRoutes(
  ctx: Context,
  service: MemoryService,
): void {
  ctx.inject(['webServer'], (wsCtx: Context) => {
    wsCtx.effect(() => {
      const webServer = wsCtx.get('webServer', false) as WebServerLike | undefined
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
          path: '/api/engram/memories',
          handler: (_req, res) => {
            const now = Date.now();
            const memories = service.listAllActive().map((row) => ({
              id: row.id,
              name: row.name,
              scope: row.scope,
              kind: row.kind,
              track: row.track,
              workspaceKey: row.workspaceKey,
              rev: row.currentRev,
              text: row.text,
              updatedAt: row.updatedAt,
              expired: row.validUntil !== null && row.validUntil < now,
            }));
            send(res, 200, { memories });
          },
        }),
      )

      disposers.push(
        webServer.register({
          kind: 'exact',
          path: '/api/engram/chain',
          handler: (req, res) => {
            const url = new URL(req.url ?? '/', 'http://localhost');
            const id = url.searchParams.get('id') ?? '';
            if (id.length === 0) {
              send(res, 400, { ok: false, error: 'id is required' });
              return;
            }
            const entity = service.getEntity(id);
            if (entity === null) {
              send(res, 404, { ok: false, error: 'no such entity' });
              return;
            }
            const chain = service.getVersionChain(id).map((node) => {
              if ('type' in node && node.type === 'folded') {
                return {
                  type: 'folded' as const,
                  rangeFrom: node.rangeFrom,
                  rangeTo: node.rangeTo,
                  stats: node.stats,
                  summaries: node.summaries,
                  citationCount: node.citations.length,
                };
              }
              return {
                type: 'version' as const,
                rev: node.rev,
                kind: node.kind,
                text: node.text,
                origin: node.origin,
                createdAt: node.createdAt,
                evidenceCount: node.evidence.length,
              };
            });
            send(res, 200, {
              id,
              name: entity.name,
              scope: entity.scope,
              kind: entity.kind,
              currentRev: entity.currentRev,
              chain,
            });
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
              const outcome = service.approve(id, user)
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
    }, 'dsh-engram.routes')
  })
}
