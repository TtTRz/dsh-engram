/**
 * Budget checks (§3.3, I-4).
 *
 * Two budgets:
 * - entryBudget: per-entry text length. Exceeding it throws BudgetExceededError
 *   (never silently truncates).
 * - snapshotBudget: total stable current-version text length. Exceeding it at
 *   propose time flags the pending row (⚠️), not a throw — the approver decides.
 */

import type { MemoryProvider } from './provider.js';
import { BudgetExceededError } from './types.js';

export function checkEntryBudget(text: string, limit: number): void {
  if (text.length > limit) {
    throw new BudgetExceededError(
      `entry text ${text.length} chars exceeds budget ${limit}`,
      text.length,
      limit,
      text.length - limit,
    );
  }
}

export interface SnapshotBudgetCheck {
  withinBudget: boolean;
  usedAfterApprove: number;
  limit: number;
}

/**
 * Pre-check: would approving this stable entry push the total over the
 * snapshot budget? Non-stable kinds always pass (they go to recall, not
 * snapshot — §5.4 data sources don't overlap).
 */
export function checkSnapshotBudget(
  store: MemoryProvider,
  workspaceKey: string | null,
  kind: 'stable' | 'situational',
  newText: string,
  limit: number,
  replacingEntityId?: string,
): SnapshotBudgetCheck {
  if (kind !== 'stable') return { withinBudget: true, usedAfterApprove: 0, limit };
  // The snapshot channel renders GLOBAL stable only (§5.1/§5.2). A
  // workspace-scoped stable never enters the snapshot, so its approval can
  // never overflow the snapshot budget — pre-checking it against a partition
  // the renderer ignores would silently void the §3.3 warning.
  if (workspaceKey !== null) return { withinBudget: true, usedAfterApprove: 0, limit };
  let used = store.stableTextSum(null);
  if (replacingEntityId !== undefined) {
    const entity = store.getEntity(replacingEntityId);
    if (entity !== null && entity.kind === 'stable') {
      const version = store.getVersion(replacingEntityId, entity.currentRev);
      if (version !== null) used -= version.text.length;
    }
  }
  const usedAfterApprove = used + newText.length;
  return { withinBudget: usedAfterApprove <= limit, usedAfterApprove, limit };
}
