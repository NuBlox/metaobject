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
 * Storage-level query contract. M4 intentionally preserves this compact shape so
 * existing adapters remain source compatible. Advanced queries are executed from
 * MetaQuery through QueryEngine and may later be pushed down by capable adapters.
 */
export interface ObjectQuery {
  readonly objectType: string;
  readonly where?: readonly QueryFilter[];
  readonly orderBy?: readonly QuerySort[];
  readonly offset?: number;
  readonly limit?: number;
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

/** Database-neutral M4 query model. */
export interface MetaQuery {
  readonly objectType: string;
  readonly includeSubtypes?: boolean;
  readonly where?: QueryExpression;
  readonly select?: readonly QueryProjection[];
  readonly orderBy?: readonly QueryOrder[];
  readonly aggregates?: readonly QueryAggregate[];
  readonly page?: CursorPagination;
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
