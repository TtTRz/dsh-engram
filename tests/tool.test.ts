import { describe, it, expect } from 'vitest';
import type { Context } from '@deepseek-ai/cordis';
import { registerMemoryTools } from '../src/tool.js';
import type { ToolDeps } from '../src/tool.js';
import type { MemoryService } from '../src/service.js';
import { MemoryService as RealMemoryService } from '../src/service.js';
import { DEFAULT_CONFIG } from '../src/types.js';

/**
 * The wire contract: `ctx.tools.register()` stores definitions verbatim and
 * `schemaOf` projects `parameters` onto the model request unchanged — unlike
 * first-party tools, which pass through `defineTool` and get their author
 * shorthand compiled to an object-rooted JSON Schema. A shorthand root
 * (no `type: 'object'`, per-field `required`) reaches the gateway with a
 * null root type and the whole turn fails:
 *   Invalid schema for function 'memory_propose': schema must be a
 *   JSON Schema of 'type: "object"', got 'type: null'.
 */

interface RegisteredDef {
  name: string;
  parameters: Record<string, unknown>;
  execute?: (args: unknown, exec?: unknown) => Promise<unknown>;
}

function captureDefs(): RegisteredDef[] {
  const defs: RegisteredDef[] = [];
  const ctx = {
    get: (key: string) =>
      key === 'tools' ? { register: (def: RegisteredDef) => defs.push(def) } : undefined,
  } as unknown as Context;
  const deps: ToolDeps = {
    ctx,
    service: {} as MemoryService,
    config: DEFAULT_CONFIG,
    sessionPendings: new Set<string>(),
  };
  registerMemoryTools(deps);
  return defs;
}

describe('registerMemoryTools wire schema', () => {
  it('registers memory_propose and memory_query', () => {
    const names = captureDefs().map((d) => d.name);
    expect(names).toContain('memory_propose');
    expect(names).toContain('memory_query');
    expect(names).toContain('memory_history');
    expect(names).toContain('memory_expand');
    expect(names).toContain('memory_rollback');
  });

  it('compiles parameters to an object-rooted JSON Schema', () => {
    for (const def of captureDefs()) {
      expect(def.parameters.type, `${def.name} root type`).toBe('object');
      expect(def.parameters.properties, `${def.name} properties`).toBeTypeOf('object');
    }
  });

  it('collects required fields at the root, not per-property', () => {
    const defs = captureDefs();
    const propose = defs.find((d) => d.name === 'memory_propose')!;
    expect(propose.parameters.required).toEqual(['name', 'text', 'track', 'scope']);
    const query = defs.find((d) => d.name === 'memory_query')!;
    expect(query.parameters.required).toEqual(['query']);
    for (const def of defs) {
      for (const [key, value] of Object.entries(
        def.parameters.properties as Record<string, Record<string, unknown>>,
      )) {
        expect(value, `${def.name}.${key} must not keep author-only keys`).not.toHaveProperty(
          'required',
        );
      }
    }
  });

  it('keeps field descriptions on the compiled properties', () => {
    const propose = captureDefs().find((d) => d.name === 'memory_propose')!;
    const properties = propose.parameters.properties as Record<string, { description?: string }>;
    expect(properties.name?.description).toBeTruthy();
    expect(properties.kind_suggestion?.description).toBeTruthy();
  });

  it('propose/query execute derive the workspace key from exec.agent.session.header.cwd', async () => {
    const defs: RegisteredDef[] = [];
    const service = new RealMemoryService({ ...DEFAULT_CONFIG, dbPath: ':memory:' });
    const ctx = {
      get: (key: string) =>
        key === 'tools' ? { register: (def: RegisteredDef) => defs.push(def) } : undefined,
    } as unknown as Context;
    const deps: ToolDeps = {
      ctx,
      service,
      config: DEFAULT_CONFIG,
      sessionPendings: new Set<string>(),
    };
    registerMemoryTools(deps);

    const exec = { agent: { session: { header: { cwd: '/tmp/engram-test-workspace' } } } };

    const propose = defs.find((d) => d.name === 'memory_propose')!;
    const result = (await propose.execute!(
      { name: '端口', text: '3080', track: 'user', scope: 'workspace' },
      exec,
    )) as string;
    expect(result).toContain('待审');

    const pendings = service.listProposed();
    expect(pendings).toHaveLength(1);
    expect(pendings[0]?.workspaceKey).toBeTruthy();

    const query = defs.find((d) => d.name === 'memory_query')!;
    const hits = (await query.execute!({ query: '端口' }, exec)) as string;
    expect(hits).toContain('pending-self');

    const hitsNoCwd = (await query.execute!({ query: '端口' }, undefined)) as string;
    expect(hitsNoCwd).toContain('pending-self');
  });
});
