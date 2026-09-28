import type { QueryOperator } from "./query.js";

/**
 * Stable identifier for the comparison behaviour used by the v1 reference
 * implementation. String and mixed-type ordering ultimately use
 * JavaScript String#localeCompare and are therefore not assumed portable to a
 * database collation.
 */
export const LEGACY_JS_V1_COMPARISON_SEMANTICS = "legacy-js-v1" as const;

/**
 * Comparison-semantics identifiers are deliberately open strings so future
 * minor releases and third-party adapters can introduce named, testable
 * semantics without changing this structural contract.
 */
export type QueryComparisonSemanticsId = string;

export interface QueryPaginationPushdownCapabilities {
  /** Adapter can push non-negative safe-integer offset/limit pagination. */
  readonly offsetLimit: boolean;
  /** Pagination is safe only when every filter has already been pushed. */
  readonly requiresFullyPushedFilters: boolean;
  /** Pagination is safe only when no attribute ordering remains in JavaScript. */
  readonly requiresNoAttributeOrdering: boolean;
}

/**
 * Declares only database-native query work that an adapter can prove preserves
 * the public StorageAdapter semantics. It does not describe residual work that
 * the adapter can still complete in JavaScript after reading candidates.
 */
export interface QueryPushdownCapabilities {
  /** Operators that can be pushed without relying on ordered comparison semantics. */
  readonly filterOperators: readonly QueryOperator[];
  /** Named comparison semantics for which gt/gte/lt/lte are natively equivalent. */
  readonly orderedFilterSemantics: readonly QueryComparisonSemanticsId[];
  /** Named comparison semantics for which attribute ORDER BY is natively equivalent. */
  readonly attributeOrderingSemantics: readonly QueryComparisonSemanticsId[];
  readonly pagination: QueryPaginationPushdownCapabilities;
}

export function supportsFilterPushdown(
  capabilities: QueryPushdownCapabilities | undefined,
  operator: QueryOperator,
): boolean {
  return capabilities?.filterOperators.includes(operator) ?? false;
}

export function supportsOrderedFilterSemantics(
  capabilities: QueryPushdownCapabilities | undefined,
  semanticsId: QueryComparisonSemanticsId,
): boolean {
  return capabilities?.orderedFilterSemantics.includes(semanticsId) ?? false;
}

export function supportsAttributeOrderingSemantics(
  capabilities: QueryPushdownCapabilities | undefined,
  semanticsId: QueryComparisonSemanticsId,
): boolean {
  return capabilities?.attributeOrderingSemantics.includes(semanticsId) ?? false;
}
