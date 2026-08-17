import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeGitOrigin,
  resolveWorkspaceKey,
  findGitRoot,
} from '../src/workspace.js';

describe('normalizeGitOrigin (X8 four steps)', () => {
  it('ssh scp-like and https forms normalize identically', () => {
    expect(normalizeGitOrigin('git@github.com:org/repo.git')).toBe('github.com/org/repo');
    expect(normalizeGitOrigin('ssh://git@github.com/org/repo.git')).toBe('github.com/org/repo');
    expect(normalizeGitOrigin('https://github.com/org/repo.git')).toBe('github.com/org/repo');
    expect(normalizeGitOrigin('https://github.com/org/repo/')).toBe('github.com/org/repo');
  });
  it('strips userinfo with token', () => {
    expect(normalizeGitOrigin('https://user:token@github.com/org/repo.git')).toBe(
      'github.com/org/repo',
    );
  });
  it('lowercases host', () => {
    expect(normalizeGitOrigin('git@GitHub.Com:Org/Repo.git')).toBe('github.com/org/repo');
  });
});

describe('resolveWorkspaceKey fallback chain', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-mem-ws-'));

  it('falls back to cwd hash outside any repo', () => {
    const r = resolveWorkspaceKey(base);
    expect(r.source).toBe('cwd');
    expect(r.key).toHaveLength(24);
  });

  it('uses git-origin when a git repo with origin exists', () => {
    const repo = join(base, 'proj');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(
      join(repo, '.git', 'config'),
      '[remote "origin"]\n\turl = git@github.com:myorg/myrepo.git\n',
    );
    const r = resolveWorkspaceKey(repo);
    expect(r.source).toBe('git-origin');
    expect(r.normalizedOrigin).toBe('github.com/myorg/myrepo');
  });

  it('explicit id wins over git', () => {
    const repo = join(base, 'proj2');
    mkdirSync(join(repo, '.git'), { recursive: true });
    writeFileSync(
      join(repo, '.git', 'config'),
      '[remote "origin"]\n\turl = https://github.com/o/r.git\n',
    );
    writeFileSync(join(repo, '.dsh-workspace'), 'my-workspace-id');
    const r = resolveWorkspaceKey(repo);
    expect(r.source).toBe('explicit');
  });

  it('subdir resolves to the repo root origin', () => {
    const repo = join(base, 'proj3');
    mkdirSync(join(repo, '.git', 'src'), { recursive: true });
    writeFileSync(
      join(repo, '.git', 'config'),
      '[remote "origin"]\n\turl = git@github.com:o/r3.git\n',
    );
    const r = resolveWorkspaceKey(join(repo, '.git', 'src'));
    expect(r.source).toBe('git-origin');
    expect(r.normalizedOrigin).toBe('github.com/o/r3');
  });

  it('git repo without origin falls back to git-root', () => {
    const repo = join(base, 'proj4');
    mkdirSync(join(repo, '.git'), { recursive: true });
    const r = resolveWorkspaceKey(repo);
    expect(r.source).toBe('git-root');
  });

  it('same origin on different machines yields the same key', () => {
    const a = mkdtempSync(join(tmpdir(), 'dsh-mem-a-'));
    const b = mkdtempSync(join(tmpdir(), 'dsh-mem-b-'));
    for (const dir of [a, b]) {
      mkdirSync(join(dir, '.git'), { recursive: true });
      writeFileSync(
        join(dir, '.git', 'config'),
        '[remote "origin"]\n\turl = https://github.com/shared/proj.git\n',
      );
    }
    expect(resolveWorkspaceKey(a).key).toBe(resolveWorkspaceKey(b).key);
  });

  afterAll(() => {
    rmSync(base, { recursive: true, force: true });
  });
});
