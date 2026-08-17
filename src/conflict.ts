/**
 * Two-layer conflict detection (§3.5, X1).
 *
 * Layer 1 (deterministic): same name_norm + different text → suspected conflict.
 * Layer 2 (lexical candidates): FTS search with the propose text's terms,
 * returning entity ids that share vocabulary. Candidates only — the system
 * NEVER judges; the approver decides (design invariant).
 */

import type { SQLiteProvider } from './store.js';
import { normalize } from './normalize.js';

export interface ConflictCandidates {
  /** Layer 1: entity ids sharing the same normalized name but different text. */
  sameName: string[];
  /** Layer 2: entity ids lexically similar via FTS (top-N). */
  lexical: string[];
  /** Union, deduped, excluding self. */
  all: string[];
}

export function detectConflicts(
  store: SQLiteProvider,
  nameNorm: string,
  text: string,
  workspaceKey: string | null,
  selfEntityId?: string,
  ftsLimit = 5,
): ConflictCandidates {
  // Layer 1: same name, active, different normalized text
  const sameName: string[] = [];
  const entity = store.findEntityByName(nameNorm, workspaceKey);
  if (entity !== null && entity.id !== selfEntityId) {
    const version = store.getVersion(entity.id, entity.currentRev);
    if (version !== null && normalize(version.text).text !== normalize(text).text) {
      sameName.push(entity.id);
    }
  }

  // Layer 2: FTS candidates (never includes the proposing entity)
  const lexical: string[] = store
    .searchFts(text, ftsLimit)
    .map((r) => r.entityId)
    .filter((id) => id !== selfEntityId && !sameName.includes(id));

  const all = [...new Set([...sameName, ...lexical])];
  return { sameName, lexical, all };
}
