export type QueryNullOrdering = "first" | "last";

function compareLegacyScalar(
  left: unknown,
  right: unknown,
  nulls: QueryNullOrdering,
  equal: (left: unknown, right: unknown) => boolean,
): number {
  if (equal(left, right)) return 0;
  const leftNull = left === null || left === undefined;
  const rightNull = right === null || right === undefined;
  if (leftNull || rightNull) {
    if (leftNull && rightNull) return 0;
    const nullResult = leftNull ? -1 : 1;
    return nulls === "first" ? nullResult : -nullResult;
  }
  if (left instanceof Date && right instanceof Date) return left.getTime() - right.getTime();
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
  return String(left).localeCompare(String(right));
}

/**
 * Stable-v1 scalar comparison used by StorageAdapter.query implementations.
 *
 * The strict-equality short circuit intentionally preserves the original
 * MemoryStorageAdapter behaviour. In particular, `NaN` reaches numeric
 * subtraction and therefore produces `NaN` rather than comparing equal.
 */
export function compareLegacyStorageScalar(
  left: unknown,
  right: unknown,
  nulls: QueryNullOrdering = "first",
): number {
  return compareLegacyScalar(left, right, nulls, (a, b) => a === b);
}

/**
 * Stable-v1 scalar comparison used by MetaQuery/QueryEngine.
 *
 * QueryEngine historically used Object.is for its equality short circuit,
 * which differs from StorageAdapter.query for NaN. M81 preserves that public
 * behaviour while making the distinction explicit and testable.
 */
export function compareLegacyMetaQueryScalar(
  left: unknown,
  right: unknown,
  nulls: QueryNullOrdering = "first",
): number {
  return compareLegacyScalar(left, right, nulls, Object.is);
}
