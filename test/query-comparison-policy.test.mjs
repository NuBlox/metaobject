import assert from "node:assert/strict";
import test from "node:test";
import {
  DETERMINISTIC_CODEPOINT_V1_COMPARISON_SEMANTICS,
  MemoryStorageAdapter,
  ObjectTypeRegistry,
  QueryEngine,
  QueryPlanner,
  createDefaultTypeRegistry,
  defineObjectType,
} from "../dist/index.js";

async function setup() {
  const types = createDefaultTypeRegistry();
  const objects = new ObjectTypeRegistry(types);
  const Item = defineObjectType({
    id: "query.comparison.item",
    name: "ComparisonItem",
    version: 1,
    attributes: {
      label: { type: "string", required: true },
    },
  });
  objects.register(Item);

  const storage = new MemoryStorageAdapter();
  for (const [index, label] of ["á", "a", "Z", "😀"].entries()) {
    await storage.insert({
      id: `item-${index + 1}`,
      type: Item.id,
      schemaVersion: 1,
      version: 0,
      values: { label },
      relationships: {},
    });
  }

  return {
    Item,
    storage,
    engine: new QueryEngine(storage, new QueryPlanner(objects)),
  };
}

test("MemoryStorageAdapter applies deterministic semantics to range and ordering", async () => {
  const { Item, storage } = await setup();
  const rows = await storage.query({
    objectType: Item.id,
    comparisonSemantics: DETERMINISTIC_CODEPOINT_V1_COMPARISON_SEMANTICS,
    where: [{ attribute: "label", operator: "gt", value: "Z" }],
    orderBy: [{ attribute: "label", direction: "asc" }],
  });

  assert.deepEqual(rows.map((row) => row.values.label), ["a", "á", "😀"]);
});

test("QueryEngine applies deterministic semantics to filters, ordering and cursor pages", async () => {
  const { Item, engine } = await setup();
  const first = await engine.execute({
    objectType: Item.id,
    comparisonSemantics: DETERMINISTIC_CODEPOINT_V1_COMPARISON_SEMANTICS,
    where: { path: "label", operator: "gte", value: "Z" },
    select: [{ path: "label" }],
    orderBy: [{ path: "label", direction: "asc" }],
    page: { first: 2 },
  });

  assert.deepEqual(first.rows.map((row) => row.values.label), ["Z", "a"]);
  assert.equal(first.pageInfo.hasNextPage, true);
  assert.ok(first.pageInfo.endCursor);

  const second = await engine.execute({
    objectType: Item.id,
    comparisonSemantics: DETERMINISTIC_CODEPOINT_V1_COMPARISON_SEMANTICS,
    where: { path: "label", operator: "gte", value: "Z" },
    select: [{ path: "label" }],
    orderBy: [{ path: "label", direction: "asc" }],
    page: { first: 2, after: first.pageInfo.endCursor },
  });

  assert.deepEqual(second.rows.map((row) => row.values.label), ["á", "😀"]);
  assert.equal(second.pageInfo.hasNextPage, false);
});

test("reference execution fails closed for unknown comparison semantics", async () => {
  const { Item, storage, engine } = await setup();

  await assert.rejects(
    storage.query({
      objectType: Item.id,
      comparisonSemantics: "unknown-semantics",
      orderBy: [{ attribute: "label", direction: "asc" }],
    }),
    /Unsupported query comparison semantics/,
  );

  await assert.rejects(
    engine.execute({
      objectType: Item.id,
      comparisonSemantics: "unknown-semantics",
      where: { path: "label", operator: "gte", value: "Z" },
    }),
    /Unsupported query comparison semantics/,
  );
});
