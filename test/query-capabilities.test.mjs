import assert from "node:assert/strict";
import test from "node:test";

import {
  LEGACY_JS_V1_COMPARISON_SEMANTICS,
  supportsAttributeOrderingSemantics,
  supportsFilterPushdown,
  supportsOrderedFilterSemantics,
} from "../dist/index.js";

const capabilities = {
  filterOperators: ["eq", "neq", "in", "notIn", "isNull", "isNotNull"],
  orderedFilterSemantics: [],
  attributeOrderingSemantics: [],
  pagination: {
    offsetLimit: true,
    requiresFullyPushedFilters: true,
    requiresNoAttributeOrdering: true,
  },
};

test("query pushdown capability helpers fail closed when capabilities are absent", () => {
  assert.equal(supportsFilterPushdown(undefined, "eq"), false);
  assert.equal(supportsOrderedFilterSemantics(undefined, LEGACY_JS_V1_COMPARISON_SEMANTICS), false);
  assert.equal(supportsAttributeOrderingSemantics(undefined, LEGACY_JS_V1_COMPARISON_SEMANTICS), false);
});

test("query pushdown capability helpers expose only explicitly declared semantics", () => {
  assert.equal(supportsFilterPushdown(capabilities, "eq"), true);
  assert.equal(supportsFilterPushdown(capabilities, "gt"), false);
  assert.equal(supportsOrderedFilterSemantics(capabilities, LEGACY_JS_V1_COMPARISON_SEMANTICS), false);
  assert.equal(supportsAttributeOrderingSemantics(capabilities, LEGACY_JS_V1_COMPARISON_SEMANTICS), false);
  assert.equal(capabilities.pagination.offsetLimit, true);
});
