import type { QueryPushdownCapabilities } from "@nublox/metaobject";

/**
 * Proven native-query subset for the stable MySQL adapter.
 *
 * Ordered comparison and attribute ordering intentionally advertise no
 * semantics yet because MySQL collation ordering has not been proven equivalent
 * to either stable-v1 legacy JavaScript ordering or deterministic-codepoint-v1.
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
