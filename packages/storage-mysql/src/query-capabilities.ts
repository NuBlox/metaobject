import type { QueryPushdownCapabilities } from "@nublox/metaobject";

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
} as const satisfies QueryPushdownCapabilities;
