/**
 * Proven native-query subset for the stable MySQL adapter.
 *
 * This declaration is intentionally structural rather than importing the new
 * M81 core type. The adapter still installs published core 1.0.0 during its
 * clean-consumer/release gates, so coupling to an unpublished core minor would
 * break independent package qualification.
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
} as const;
