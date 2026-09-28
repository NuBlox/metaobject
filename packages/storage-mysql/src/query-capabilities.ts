import type { QueryOperator } from "@nublox/metaobject";

export interface MySqlQueryPaginationPushdownCapabilities {
  readonly offsetLimit: boolean;
  readonly requiresFullyPushedFilters: boolean;
  readonly requiresNoAttributeOrdering: boolean;
}

/**
 * Structural mirror of the M81 core capability contract.
 *
 * This package remains independently qualifiable against published core 1.0.0,
 * so the type is intentionally declared here until the next core minor is
 * published and the adapter dependency can advance safely.
 */
export interface MySqlQueryPushdownCapabilities {
  readonly filterOperators: readonly QueryOperator[];
  readonly orderedFilterSemantics: readonly string[];
  readonly attributeOrderingSemantics: readonly string[];
  readonly pagination: MySqlQueryPaginationPushdownCapabilities;
}

/**
 * Proven native-query subset for the stable MySQL adapter.
 *
 * Ordered comparison and attribute ordering intentionally advertise no
 * `legacy-js-v1` support because MySQL collation ordering is not generally
 * equivalent to JavaScript String#localeCompare semantics.
 */
export const MYSQL_QUERY_PUSHDOWN_CAPABILITIES = {
  filterOperators: ["eq", "neq", "in", "notIn", "isNull", "isNotNull"],
  orderedFilterSemantics: [],
  attributeOrderingSemantics: [],
  pagination: {
    offsetLimit: true,
    requiresFullyPushedFilters: true,
    requiresNoAttributeOrdering: true,
  },
} as const satisfies MySqlQueryPushdownCapabilities;
