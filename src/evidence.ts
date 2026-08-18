/**
 * P4 — evidence resolution: the excerpt 三情形 (§4, G2/N5/X5).
 *
 * The system NEVER does semantic locating. Every excerpt comes from one of
 * three deterministic sources:
 *
 * - A (explicit): the citation already carries an excerpt (user-quoted text
 *   or model-quoted anchor). The snapshot is that excerpt, plus adjacent
 *   context when the log is reachable.
 * - B (read-back): the citation points at the running session — the system
 *   reads the cited seq range from the live log, clamping out-of-range
 *   bounds to the usable range (degrade, never reject, G2), plus 1–2
 *   adjacent surface events.
 * - C (cross-session / unreachable): no excerpt is generated; origin stays
 *   heuristic and the panel shows "no verbatim evidence".
 *
 * The persisted excerptSnapshot is the level-one guarantee: self-contained,
 * permanent, never compressed away by folding (§2.3).
 */

import type { Citation } from './types.js';

/** Structural view of a live session (dsh-session Session). */
export interface SessionLike {
  id?: string;
  events?: ReadonlyArray<{ type: string; seq: number; data?: unknown }>;
}

/** Hard cap for one excerpt snapshot — snapshots must stay small forever. */
export const SNAPSHOT_MAX_CHARS = 2000;

/** Adjacent surface events included around the cited range (1–2 each side). */
const CONTEXT_EVENTS = 2;

const SURFACE_TYPES = new Set(['user/message', 'assistant/message', 'tool/result']);

interface MessageLike {
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
}

/** Best-effort text of one session event; null when it carries none. */
function eventText(event: { type: string; data?: unknown }): string | null {
  if (!SURFACE_TYPES.has(event.type)) return null;
  const message = event.data as MessageLike | undefined;
  if (message === null || typeof message !== 'object') return null;
  const parts: string[] = [];
  for (const block of message.content ?? []) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      parts.push(block.text);
    }
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

export interface ResolvedEvidence {
  evidence: Citation[];
  /** cited only when at least one citation carries an excerpt (A) or was read back (B). */
  origin: 'cited' | 'heuristic';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Render the snapshot for one citation against a readable session log. */
function buildSnapshot(
  citation: Citation,
  events: ReadonlyArray<{ type: string; seq: number; data?: unknown }>,
  explicitExcerpt: string | undefined,
): string {
  // Clamp the cited range into the usable surface range (degrade, G2).
  const surface = events.filter((event) => eventText(event) !== null);
  if (surface.length === 0) return explicitExcerpt ?? '';
  const minSeq = surface[0]?.seq ?? citation.startSeq;
  const maxSeq = surface[surface.length - 1]?.seq ?? citation.endSeq;
  let from = citation.startSeq;
  let to = citation.endSeq;
  if (from > to) [from, to] = [to, from];
  // No usable seq → degrade to the latest surface event (the freshest turn).
  if (from <= 0 && to <= 0) to = from = maxSeq;
  from = clamp(from, minSeq, maxSeq);
  to = clamp(Math.max(to, from), minSeq, maxSeq);

  // Cited range + 1–2 adjacent surface events on each side.
  const fromWithContext = clamp(from - CONTEXT_EVENTS, minSeq, maxSeq);
  const toWithContext = clamp(to + CONTEXT_EVENTS, minSeq, maxSeq);
  const lines: string[] = [];
  let cited = false;
  for (const event of surface) {
    if (event.seq < fromWithContext || event.seq > toWithContext) continue;
    const text = eventText(event);
    if (text === null) continue;
    if (event.seq >= from && event.seq <= to && !cited && explicitExcerpt !== undefined) {
      // The explicitly quoted excerpt rides first inside its cited range.
      lines.push(`[${event.seq}] ${explicitExcerpt}`);
      cited = true;
      continue;
    }
    lines.push(`[${event.seq}] ${text}`);
  }
  if (explicitExcerpt !== undefined && !cited) lines.unshift(explicitExcerpt);
  return lines.join('\n').slice(0, SNAPSHOT_MAX_CHARS);
}

/**
 * Resolve proposed citations into persisted evidence. Pure over its inputs —
 * the caller hands in the live session view (or undefined when running
 * outside one) and receives the enriched citation list plus the honest origin.
 */
export function resolveEvidence(
  citations: Citation[] | undefined,
  session: SessionLike | undefined,
): ResolvedEvidence {
  if (citations === undefined || citations.length === 0) {
    return { evidence: [], origin: 'heuristic' };
  }

  const resolved: Citation[] = [];
  let anyExcerpt = false;

  for (const citation of citations) {
    const explicit = citation.excerpt?.trim();
    const readable =
      session !== undefined &&
      Array.isArray(session.events) &&
      (citation.sessionId === undefined ||
        session.id === undefined ||
        citation.sessionId === session.id);
    // Situation A: explicit excerpt; B adds read-back context around it.
    // Situation C: no excerpt and no readable log → keep the pointer only.
    if (explicit === undefined && !readable) {
      resolved.push(citation);
      continue;
    }
    if (readable && session?.events !== undefined) {
      const snapshot = buildSnapshot(citation, session.events, explicit);
      if (snapshot.length > 0) {
        resolved.push({ ...citation, excerptSnapshot: snapshot });
        anyExcerpt = true;
        continue;
      }
      resolved.push(citation);
      continue;
    }
    // Explicit excerpt without a readable log: snapshot = the excerpt itself.
    if (explicit !== undefined) {
      resolved.push({ ...citation, excerptSnapshot: explicit.slice(0, SNAPSHOT_MAX_CHARS) });
      anyExcerpt = true;
      continue;
    }
    resolved.push(citation);
  }

  return { evidence: resolved, origin: anyExcerpt ? 'cited' : 'heuristic' };
}

export interface ReadBack {
  /** The rendered passage: full read-back, or the stored snapshot. */
  text: string;
  /** True when the live log was unreachable — the level-two guarantee degrades to the snapshot. */
  degraded: boolean;
}

/**
 * Expand one citation for display (§4 二级承诺): when the cited session is
 * the live one, read the full original passage back from the log; otherwise
 * degrade explicitly to the persisted excerptSnapshot — never silently.
 */
export function readCitation(citation: Citation, session: SessionLike | undefined): ReadBack | null {
  const readable =
    session !== undefined &&
    citation.sessionId === session.id &&
    Array.isArray(session.events);
  const snapshot =
    citation.excerptSnapshot !== undefined && citation.excerptSnapshot.length > 0
      ? citation.excerptSnapshot
      : citation.excerpt;
  if (!readable) {
    if (snapshot === undefined || snapshot.length === 0) return null;
    return { text: snapshot, degraded: true };
  }
  const events = session?.events as ReadonlyArray<{ type: string; seq: number; data?: unknown }>;
  const surface = events.filter((event) => eventText(event) !== null);
  if (surface.length === 0) {
    if (snapshot === undefined || snapshot.length === 0) return null;
    return { text: snapshot, degraded: true };
  }
  const minSeq = surface[0]?.seq ?? citation.startSeq;
  const maxSeq = surface[surface.length - 1]?.seq ?? citation.endSeq;
  let from = citation.startSeq;
  let to = citation.endSeq;
  if (from > to) [from, to] = [to, from];
  if (from <= 0 && to <= 0) to = from = maxSeq;
  from = clamp(from, minSeq, maxSeq);
  to = clamp(Math.max(to, from), minSeq, maxSeq);
  const lines: string[] = [];
  for (const event of surface) {
    if (event.seq < from || event.seq > to) continue;
    const text = eventText(event);
    if (text !== null) lines.push(`[${event.seq}] ${text}`);
  }
  if (lines.length === 0) {
    if (snapshot === undefined || snapshot.length === 0) return null;
    return { text: snapshot, degraded: true };
  }
  return { text: lines.join('\n').slice(0, SNAPSHOT_MAX_CHARS), degraded: false };
}
