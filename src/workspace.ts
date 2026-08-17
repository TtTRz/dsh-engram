/**
 * Workspace key resolution (§2.1, N6 + X8).
 *
 * Anchor priority (fallback chain):
 *   explicit .dsh-workspace id → git origin normalized hash → git root hash → cwd hash
 *
 * Origin normalization is the four deterministic steps from X8; the result is
 * cached in the alias table on first computation (algorithm upgrades produce a
 * new key + one alias row rather than splitting history).
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

export function sha256Prefix(input: string, len = 24): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, len);
}

// ---------------------------------------------------------------------------
// X8: four-step origin normalization — pinned, deterministic
// ---------------------------------------------------------------------------

export function normalizeGitOrigin(origin: string): string {
  let s = origin.trim();
  // 1. strip protocol forms (incl. scp-like prefix git@host:)
  s = s.replace(/^[a-z+]+:\/\//i, ''); // ssh:// https:// http:// git://
  // 2. strip userinfo (user:token@)
  s = s.replace(/^[^/@]*@/, '');
  // 3. scp-like shorthand: host:path → host/path
  const colon = s.indexOf(':');
  const slash = s.indexOf('/');
  if (colon !== -1 && (slash === -1 || colon < slash)) {
    s = s.slice(0, colon) + '/' + s.slice(colon + 1);
  }
  // 4. strip trailing .git / slashes, lowercase
  s = s.replace(/\.git$/i, '');
  s = s.replace(/\/+$/, '');
  return s.toLowerCase();
}

// ---------------------------------------------------------------------------
// Git root discovery: walk up from cwd to the first .git (submodules included)
// ---------------------------------------------------------------------------

export interface GitInfo {
  root: string;
  origin: string | null;
}

export function findGitRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = resolve(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}

function readOrigin(gitRoot: string): string | null {
  const configPath = join(gitRoot, '.git', 'config');
  if (!existsSync(configPath)) return null;
  try {
    const content = readFileSync(configPath, 'utf8');
    // match `url = ...` inside the [remote "origin"] section (first line of file included)
    const section = content.split(/(?:^|\n)\s*\[\s*remote\s+"origin"\s*\]\s*\n/i)[1];
    if (!section) return null;
    const nextSection: string = section.split(/\n\s*\[/)[0] ?? '';
    const m = nextSection.match(/^\s*url\s*=\s*(\S+)\s*$/im);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

export function gitInfo(startDir: string): GitInfo | null {
  const root = findGitRoot(startDir);
  if (root === null) return null;
  return { root, origin: readOrigin(root) };
}

// ---------------------------------------------------------------------------
// Explicit id file (.dsh-workspace)
// ---------------------------------------------------------------------------

export function readExplicitId(startDir: string): string | null {
  let dir = resolve(startDir);
  for (;;) {
    const marker = join(dir, '.dsh-workspace');
    if (existsSync(marker)) {
      try {
        const content = readFileSync(marker, 'utf8').trim();
        if (content) return content;
      } catch {
        /* fall through */
      }
    }
    const parent = resolve(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// Workspace key resolution (fallback chain)
// ---------------------------------------------------------------------------

export type WorkspaceKeySource = 'explicit' | 'git-origin' | 'git-root' | 'cwd';

export interface WorkspaceKey {
  key: string;
  source: WorkspaceKeySource;
  /** The normalized origin (e.g. github.com/o/r) when source=git-origin. */
  normalizedOrigin?: string;
}

export function resolveWorkspaceKey(startDir: string): WorkspaceKey {
  const explicit = readExplicitId(startDir);
  if (explicit !== null) {
    return { key: sha256Prefix(`explicit:${explicit}`), source: 'explicit' };
  }
  const info = gitInfo(startDir);
  if (info?.origin) {
    const normalized = normalizeGitOrigin(info.origin);
    return { key: sha256Prefix(`origin:${normalized}`), source: 'git-origin', normalizedOrigin: normalized };
  }
  if (info) {
    return { key: sha256Prefix(`gitroot:${info.root}`), source: 'git-root' };
  }
  return { key: sha256Prefix(`cwd:${resolve(startDir)}`), source: 'cwd' };
}
