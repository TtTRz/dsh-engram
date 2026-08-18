/**
 * Approval API tests (P1a): exercise the routes end-to-end with a fake
 * web-server that captures registered handlers, driving them with mock
 * req/res objects.
 */

import { describe, it, expect } from 'vitest';
import { MemoryService } from '../src/service.js';
import { registerEngramRoutes } from '../src/api.js';
import { DEFAULT_CONFIG } from '../src/types.js';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';

interface CapturedRoute {
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void
}

function fakeWebServer(): { routes: CapturedRoute[]; register: (r: CapturedRoute) => () => void } {
  const routes: CapturedRoute[] = []
  return {
    routes,
    register: (r) => {
      routes.push(r)
      return () => undefined
    },
  }
}

function makeReq(method: string, body?: unknown): IncomingMessage {
  const req = new Readable() as unknown as IncomingMessage & { method: string }
  req.method = method
  if (body !== undefined) {
    ;(req as unknown as { push: (c: string | Buffer) => void }).push(
      Buffer.from(JSON.stringify(body)),
    )
  }
  ;(req as unknown as { push: (c: null) => void }).push(null)
  return req as IncomingMessage
}

function makeRes(): { res: ServerResponse; body: () => unknown; status: () => number } {
  let status = 0
  let raw = ''
  const res = {
    statusCode: 0,
    setHeader: () => undefined,
    end: (chunk: string) => {
      raw = chunk
    },
  } as unknown as ServerResponse
  return {
    res,
    status: () => (res as unknown as { statusCode: number }).statusCode,
    body: () => JSON.parse(raw),
  }
}

function makeCtx(routes: { routes: CapturedRoute[]; register: (r: CapturedRoute) => () => void }) {
  const services: Record<string, unknown> = { webServer: routes }
  const ctx = {
    get: (name: string) => services[name],
    // Mirrors cordis ctx.inject for the always-present webServer case:
    // apply the callback immediately with a child ctx whose effect() runs
    // synchronously (the route registrations are the effect body).
    inject: (names: string[], callback: (wsCtx: unknown) => void) => {
      if (names.includes('webServer') && services.webServer !== undefined) {
        const wsCtx = {
          get: (name: string) => services[name],
          effect: (body: () => unknown) => {
            body()
          },
        }
        callback(wsCtx)
      }
    },
  }
  return ctx as never
}

async function route(handler: CapturedRoute['handler'], req: IncomingMessage, res: ServerResponse) {
  await handler(req, res)
}

describe('engram approval API', () => {
  it('GET /api/engram/pending lists proposed proposals with drift data', async () => {
    const svc = new MemoryService({ ...DEFAULT_CONFIG, dbPath: ':memory:' })
    const web = fakeWebServer()
    registerEngramRoutes(makeCtx(web), svc)

    const r = svc.propose({ name: '端口', text: '8899', track: 'user', scope: 'global' }, null)
    const pendingRoute = web.routes.find((x) => x.path === '/api/engram/pending')!
    const { res, body } = makeRes()
    await route(pendingRoute.handler, makeReq('GET'), res)
    const payload = body() as { pendings: Array<{ id: string; name: string }> }
    expect(payload.pendings).toHaveLength(1)
    expect(payload.pendings[0]?.name).toBe('端口')
    expect(payload.pendings[0]?.id).toBe(r.pendingId)
  })

  it('POST /api/engram/approve approves a pending', async () => {
    const svc = new MemoryService({ ...DEFAULT_CONFIG, dbPath: ':memory:' })
    const web = fakeWebServer()
    registerEngramRoutes(makeCtx(web), svc)

    const r = svc.propose({ name: '端口', text: '8899', track: 'user', scope: 'global' }, null)
    const approveRoute = web.routes.find((x) => x.path === '/api/engram/approve')!
    const { res, body } = makeRes()
    await route(approveRoute.handler, makeReq('POST', { id: r.pendingId, user: 'tester' }), res)
    expect(body()).toMatchObject({ ok: true })
    expect(svc.listActiveByScope(null, 'stable')).toHaveLength(1)
  })

  it('POST /api/engram/deny denies a pending and leaves no entity', async () => {
    const svc = new MemoryService({ ...DEFAULT_CONFIG, dbPath: ':memory:' })
    const web = fakeWebServer()
    registerEngramRoutes(makeCtx(web), svc)

    const r = svc.propose({ name: '端口', text: '8899', track: 'user', scope: 'global' }, null)
    const denyRoute = web.routes.find((x) => x.path === '/api/engram/deny')!
    const { res, body } = makeRes()
    await route(denyRoute.handler, makeReq('POST', { id: r.pendingId }), res)
    expect(body()).toMatchObject({ ok: true })
    expect(svc.listActiveByScope(null, 'stable')).toHaveLength(0)
  })

  it('approve reports drift when the entity moved past base_rev', async () => {
    const svc = new MemoryService({ ...DEFAULT_CONFIG, dbPath: ':memory:' })
    const web = fakeWebServer()
    registerEngramRoutes(makeCtx(web), svc)

    const p1 = svc.propose({ name: '端口', text: 'v1', track: 'user', scope: 'global' }, null)
    svc.approve(p1.pendingId, 'a')
    const p2 = svc.propose(
      { name: '端口', text: 'v2', track: 'user', scope: 'global', action: 'refine' },
      null,
    )
    // advance the entity past p2's base_rev
    svc.propose({ name: '端口', text: 'v3', track: 'user', scope: 'global', action: 'refine' }, null)
    const p3 = svc.listProposed().find((x) => x.text === 'v3')!
    svc.approve(p3.id, 'b')

    const approveRoute = web.routes.find((x) => x.path === '/api/engram/approve')!
    const { res, body } = makeRes()
    await route(approveRoute.handler, makeReq('POST', { id: p2.pendingId }), res)
    const outcome = body() as { ok: boolean; reason?: string; drift?: { currentRev: number } }
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('drift')
    expect(outcome.drift?.currentRev).toBe(2)
  })

  it('approve reuses the workspace key captured at propose time (regression: ctx.cwd crash)', async () => {
    const svc = new MemoryService({ ...DEFAULT_CONFIG, dbPath: ':memory:' })
    const web = fakeWebServer()
    registerEngramRoutes(makeCtx(web), svc)

    const wk = 'wk-abc123'
    const r = svc.propose(
      { name: '部署端口', text: '8899', track: 'user', scope: 'workspace' },
      wk,
    )
    const approveRoute = web.routes.find((x) => x.path === '/api/engram/approve')!
    const { res, body } = makeRes()
    await route(approveRoute.handler, makeReq('POST', { id: r.pendingId, user: 'tester' }), res)
    expect(body()).toMatchObject({ ok: true })
    const entities = svc.listActiveByScope(wk, 'situational')
    expect(entities).toHaveLength(1)
    expect(entities[0]?.workspaceKey).toBe(wk)
  })
})
