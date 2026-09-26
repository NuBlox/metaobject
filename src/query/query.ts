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

export interface QueryFilter {
  readonly attribute: string;
  readonly operator: QueryOperator;
  readonly value?: unknown;
}

export interface QuerySort {
  readonly attribute: string;
  readonly direction?: "asc" | "desc";
}

export interface ObjectQuery {
  readonly objectType: string;
  readonly where?: readonly QueryFilter[];
  readonly orderBy?: readonly QuerySort[];
  readonly offset?: number;
  readonly limit?: number;
}
