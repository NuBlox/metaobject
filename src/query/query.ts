import type { QueryComparisonSemanticsId } from "./query-capabilities.js";

export type QueryOperator =
  | "eq"
  | "neq"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "in"
  | "notIn"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "isNull"
  | "isNotNull";

/** Legacy flat filter retained for StorageAdapter.query compatibility. */
export interface QueryFilter {
  readonly attribute: string;
  readonly operator: QueryOperator;
  readonly value?: unknown;
}

/** Legacy flat sort retained for StorageAdapter.query compatibility. */
export interface QuerySort {
  readonly attribute: string;
  readonly direction?: "asc" | "desc";
}

/**
 * Storage-level query contract. Existing callers default to stable-v1
 * `legacy-js-v1` comparison semantics. New deterministic comparison policies
 * are explicit opt-ins so minor releases cannot silently reorder results.
 */
export interface ObjectQuery {
  readonly objectType: string;
  readonly where?: readonly QueryFilter[];
  readonly orderBy?: readonly QuerySort[];
  readonly offset?: number;
  readonly limit?: number;
  readonly comparisonSemantics?: QueryComparisonSemanticsId;
}

export interface QueryPredicate {
  /** Dot-separated attribute/relationship path, e.g. `manager.department.name`. */
  readonly path: string;
  readonly operator: QueryOperator;
  readonly value?: unknown;
}

export interface QueryAnd {
  readonly and: readonly QueryExpression[];
}

export interface QueryOr {
  readonly or: readonly QueryExpression[];
}

export interface QueryNot {
  readonly not: QueryExpression;
}

export type QueryExpression = QueryPredicate | QueryAnd | QueryOr | QueryNot;

export interface QueryProjection {
  readonly path: string;
  readonly as?: string;
}

export interface QueryOrder {
  readonly path: string;
  readonly direction?: "asc" | "desc";
  /** Null ordering is explicit so SQL adapters can preserve engine semantics. */
  readonly nulls?: "first" | "last";
}

export type AggregateFunction = "count" | "sum" | "avg" | "min" | "max";

export interface QueryAggregate {
  readonly function: AggregateFunction;
  /** `count` may omit a path to count matching objects. */
  readonly path?: string;
  readonly as: string;
  readonly distinct?: boolean;
}

export interface CursorPagination {
  readonly first: number;
  readonly after?: string;
}

/** Database-neutral M4 query model with additive M81 comparison selection. */
export interface MetaQuery {
  readonly objectType: string;
  readonly includeSubtypes?: boolean;
  readonly where?: QueryExpression;
  readonly select?: readonly QueryProjection[];
  readonly orderBy?: readonly QueryOrder[];
  readonly aggregates?: readonly QueryAggregate[];
  readonly page?: CursorPagination;
  readonly comparisonSemantics?: QueryComparisonSemanticsId;
}

export interface QueryRow {
  readonly $id: string;
  readonly $type: string;
  readonly values: Readonly<Record<string, unknown>>;
}

export interface QueryPageInfo {
  readonly hasNextPage: boolean;
  readonly endCursor?: string;
}

export interface MetaQueryResult {
  readonly rows: readonly QueryRow[];
  readonly aggregates: Readonly<Record<string, number | string | null>>;
  readonly pageInfo: QueryPageInfo;
  readonly totalMatched: number;
}

export interface QueryPlan {
  readonly query: MetaQuery;
  readonly rootTypes: readonly string[];
  readonly paths: readonly string[];
  readonly relationshipPaths: readonly string[];
  readonly stableOrder: readonly QueryOrder[];
}
