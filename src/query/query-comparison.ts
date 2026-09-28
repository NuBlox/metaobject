import { MetadataError } from "../errors/errors.js";
import {
  DETERMINISTIC_CODEPOINT_V1_COMPARISON_SEMANTICS,
  LEGACY_JS_V1_COMPARISON_SEMANTICS,
  type QueryComparisonSemanticsId,
} from "./query-capabilities.js";

export type QueryNullOrdering = "first" | "last";

function compareNullish(
  left: unknown,
  right: unknown,
  nulls: QueryNullOrdering,
): number | undefined {
  const leftNull = left === null || left === undefined;
  const rightNull = right === null || right === undefined;
  if (!leftNull && !rightNull) return undefined;
  if (leftNull && rightNull) return 0;
  const nullResult = leftNull ? -1 : 1;
  return nulls === "first" ? nullResult : -nullResult;
}

function compareLegacyScalar(
  left: unknown,
  right: unknown,
  nulls: QueryNullOrdering,
  equal: (left: unknown, right: unknown) => boolean,
): number {
  if (equal(left, right)) return 0;
  const nullResult = compareNullish(left, right, nulls);
  if (nullResult !== undefined) return nullResult;
  if (left instanceof Date && right instanceof Date) return left.getTime() - right.getTime();
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
  return String(left).localeCompare(String(right));
}

function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (value) => value.codePointAt(0)!);
  const rightPoints = Array.from(right, (value) => value.codePointAt(0)!);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const delta = leftPoints[index]! - rightPoints[index]!;
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return leftPoints.length === rightPoints.length ? 0 : leftPoints.length < rightPoints.length ? -1 : 1;
}

function compareDeterministicNumber(left: number, right: number): number {
  if (Object.is(left, right) || left === right) return 0;
  if (Number.isNaN(left)) return Number.isNaN(right) ? 0 : 1;
  if (Number.isNaN(right)) return -1;
  return left < right ? -1 : 1;
}

function deterministicKind(value: unknown): number {
  if (typeof value === "boolean") return 0;
  if (typeof value === "number") return 1;
  if (typeof value === "bigint") return 2;
  if (value instanceof Date) return 3;
  if (typeof value === "string") return 4;
  return 5;
}

/**
 * Portable opt-in M81 ordering.
 *
 * Null and undefined share the configured null bucket. Non-null scalar kinds
 * have a fixed cross-type order: boolean, number, bigint, Date, string, other.
 * Numbers order numerically with -0 equal to +0 and NaN after every non-NaN
 * number. Dates order by epoch milliseconds with invalid Dates following valid
 * Dates. Strings and fallback string representations order lexicographically by
 * Unicode code point, independent of process locale and ICU data.
 */
export function compareDeterministicCodepointScalar(
  left: unknown,
  right: unknown,
  nulls: QueryNullOrdering = "first",
): number {
  if (Object.is(left, right)) return 0;
  const nullResult = compareNullish(left, right, nulls);
  if (nullResult !== undefined) return nullResult;

  const leftKind = deterministicKind(left);
  const rightKind = deterministicKind(right);
  if (leftKind !== rightKind) return leftKind < rightKind ? -1 : 1;

  if (typeof left === "boolean" && typeof right === "boolean") {
    return Number(left) - Number(right);
  }
  if (typeof left === "number" && typeof right === "number") {
    return compareDeterministicNumber(left, right);
  }
  if (typeof left === "bigint" && typeof right === "bigint") {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (left instanceof Date && right instanceof Date) {
    return compareDeterministicNumber(left.getTime(), right.getTime());
  }
  return compareCodePoints(String(left), String(right));
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

export function compareStorageQueryScalar(
  left: unknown,
  right: unknown,
  semanticsId: QueryComparisonSemanticsId = LEGACY_JS_V1_COMPARISON_SEMANTICS,
  nulls: QueryNullOrdering = "first",
): number {
  if (semanticsId === LEGACY_JS_V1_COMPARISON_SEMANTICS) {
    return compareLegacyStorageScalar(left, right, nulls);
  }
  if (semanticsId === DETERMINISTIC_CODEPOINT_V1_COMPARISON_SEMANTICS) {
    return compareDeterministicCodepointScalar(left, right, nulls);
  }
  throw new MetadataError(`Unsupported query comparison semantics '${semanticsId}'.`);
}

export function compareMetaQueryScalar(
  left: unknown,
  right: unknown,
  semanticsId: QueryComparisonSemanticsId = LEGACY_JS_V1_COMPARISON_SEMANTICS,
  nulls: QueryNullOrdering = "first",
): number {
  if (semanticsId === LEGACY_JS_V1_COMPARISON_SEMANTICS) {
    return compareLegacyMetaQueryScalar(left, right, nulls);
  }
  if (semanticsId === DETERMINISTIC_CODEPOINT_V1_COMPARISON_SEMANTICS) {
    return compareDeterministicCodepointScalar(left, right, nulls);
  }
  throw new MetadataError(`Unsupported query comparison semantics '${semanticsId}'.`);
}
