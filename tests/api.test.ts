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

  it('GET /api/engram/memories lists approved memories with metadata', async () => {
    const svc = new MemoryService({ ...DEFAULT_CONFIG, dbPath: ':memory:' })
    const web = fakeWebServer()
    registerEngramRoutes(makeCtx(web), svc)

    const r1 = svc.propose({ name: '端口', text: '8899', track: 'user', scope: 'global' }, null)
    svc.approve(r1.pendingId, 'a')
    const r2 = svc.propose({ name: '过期', text: '旧值', track: 'agent', scope: 'global', validUntil: Date.now() - 1000 }, null)
    svc.approve(r2.pendingId, 'a')

    const listRoute = web.routes.find((x) => x.path === '/api/engram/memories')!
    const { res, body } = makeRes()
    await listRoute.handler(makeReq('GET'), res)
    const payload = body() as { memories: Array<{ name: string; expired: boolean; rev: number; scope: string; kind: string }> }
    expect(payload.memories).toHaveLength(2)
    const port = payload.memories.find((m) => m.name === '端口')
    expect(port?.rev).toBe(1)
    expect(port?.expired).toBe(false)
    expect(port?.scope).toBe('global')
    expect(port?.kind).toBe('stable')
    const stale = payload.memories.find((m) => m.name === '过期')
    expect(stale?.expired).toBe(true)
  })

  it('GET /api/engram/chain returns the bounded version chain', async () => {
    const svc = new MemoryService({ ...DEFAULT_CONFIG, dbPath: ':memory:' })
    const web = fakeWebServer()
    registerEngramRoutes(makeCtx(web), svc)

    const r1 = svc.propose({ name: '端口', text: 'v1', track: 'user', scope: 'global' }, null)
    svc.approve(r1.pendingId, 'a')
    const entity = svc.listAllActive()[0]!

    const chainRoute = web.routes.find((x) => x.path === '/api/engram/chain')!
    const req = makeReq('GET') as IncomingMessage & { url: string }
    ;(req as unknown as { url: string }).url = `/api/engram/chain?id=${entity.id}`
    const { res, body } = makeRes()
    await chainRoute.handler(req, res)
    const payload = body() as { chain: Array<{ type: string; rev?: number; kind?: string }> }
    expect(payload.chain).toHaveLength(1)
    expect(payload.chain[0]?.type).toBe('version')
    expect(payload.chain[0]?.rev).toBe(1)
    expect(payload.chain[0]?.kind).toBe('create')
  })

  it('POST /api/engram/archive files an exact-entity delete proposal; approval retires it', async () => {
    const svc = new MemoryService({ ...DEFAULT_CONFIG, dbPath: ':memory:' })
    const web = fakeWebServer()
    registerEngramRoutes(makeCtx(web), svc)

    // Two active entities; the delete must retire exactly the clicked one.
    // (Same-name coexistence is not reachable through propose — the panel's
    // "keep independent" choice is future work — so distinct names here.)
    const target = svc.propose({ name: '端口', text: '甲实体', track: 'user', scope: 'global' }, null)
    svc.approve(target.pendingId, 'a')
    const other = svc.propose({ name: '别名', text: '乙实体', track: 'user', scope: 'global' }, null)
    svc.approve(other.pendingId, 'a')
    const entities = svc.listAllActive()
    expect(entities).toHaveLength(2)
    const clicked = entities.find((row) => row.text === '甲实体')!

    // Panel delete on 甲: the proposal must attach to the clicked entity.
    const archiveRoute = web.routes.find((x) => x.path === '/api/engram/archive')!
    const { res, body } = makeRes()
    await archiveRoute.handler(makeReq('POST', { id: clicked.id }), res)
    const filed = body() as { ok: boolean; pendingId: string }
    expect(filed.ok).toBe(true)

    const pendings = svc.listProposed()
    expect(pendings).toHaveLength(1)
    expect(pendings[0]?.action).toBe('archive')
    expect(pendings[0]?.entityId).toBe(clicked.id)

    // Approving the archive retires exactly the clicked entity.
    svc.approve(filed.pendingId, 'deleter')
    const remaining = svc.listAllActive()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.id).not.toBe(clicked.id)
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
