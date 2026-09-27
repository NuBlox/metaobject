import assert from "node:assert/strict";
import test from "node:test";
import { compileMySqlObjectQueryPlan } from "../dist/index.js";

test("safe equality and pagination are pushed into prepared SQL", () => {
  const plan = compileMySqlObjectQueryPlan("metaobject_objects", {
    objectType: "example.item",
    where: [{ attribute: "score", operator: "eq", value: 20 }],
    offset: 2,
    limit: 5,
  });

  assert.equal(plan.pushedFilters.length, 1);
  assert.equal(plan.residualFilters.length, 0);
  assert.equal(plan.paginationPushed, true);
  assert.match(plan.sql, /JSON_EXTRACT\(values_json, \?\)/);
  assert.match(plan.sql, /LIMIT \? OFFSET \?/);
  assert.equal(plan.parameters[0], "example.item");
  assert.deepEqual(plan.parameters.slice(-2), [5, 2]);
});

test("attribute names remain bound JSON paths instead of SQL text", () => {
  const attribute = 'value") OR 1 = 1 --';
  const plan = compileMySqlObjectQueryPlan("metaobject_objects", {
    objectType: "example.item",
    where: [{ attribute, operator: "eq", value: "safe" }],
  });

  assert.equal(plan.sql.includes(attribute), false);
  assert.ok(plan.parameters.some((value) => typeof value === "string" && value.includes(attribute)));
});

test("comparison and string predicates remain residual to preserve core semantics", () => {
  const plan = compileMySqlObjectQueryPlan("metaobject_objects", {
    objectType: "example.item",
    where: [
      { attribute: "score", operator: "gte", value: 10 },
      { attribute: "label", operator: "contains", value: "abc" },
      { attribute: "active", operator: "eq", value: true },
    ],
    limit: 1,
  });

  assert.equal(plan.pushedFilters.length, 1);
  assert.deepEqual(plan.residualFilters.map((filter) => filter.operator), ["gte", "contains"]);
  assert.equal(plan.paginationPushed, false);
  assert.doesNotMatch(plan.sql, /LIMIT/);
});

test("attribute ordering keeps pagination in JavaScript fallback", () => {
  const plan = compileMySqlObjectQueryPlan("metaobject_objects", {
    objectType: "example.item",
    where: [{ attribute: "score", operator: "eq", value: 20 }],
    orderBy: [{ attribute: "score", direction: "desc" }],
    offset: 1,
    limit: 2,
  });

  assert.equal(plan.residualFilters.length, 0);
  assert.equal(plan.paginationPushed, false);
  assert.doesNotMatch(plan.sql, /LIMIT/);
});

test("negative or fractional pagination is not pushed down", () => {
  const negative = compileMySqlObjectQueryPlan("metaobject_objects", {
    objectType: "example.item",
    offset: -1,
    limit: 1,
  });
  assert.equal(negative.paginationPushed, false);

  const fractional = compileMySqlObjectQueryPlan("metaobject_objects", {
    objectType: "example.item",
    offset: 0,
    limit: 1.5,
  });
  assert.equal(fractional.paginationPushed, false);
});

test("IN, NOT IN and null predicates are SQL-safe", () => {
  const plan = compileMySqlObjectQueryPlan("metaobject_objects", {
    objectType: "example.item",
    where: [
      { attribute: "state", operator: "in", value: ["open", "closed"] },
      { attribute: "deletedAt", operator: "isNull" },
      { attribute: "priority", operator: "notIn", value: [1, 2] },
    ],
  });

  assert.equal(plan.pushedFilters.length, 3);
  assert.equal(plan.residualFilters.length, 0);
  assert.equal(plan.paginationPushed, true);
});
