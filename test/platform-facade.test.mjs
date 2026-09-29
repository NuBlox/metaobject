import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryStorageAdapter,
  createMetaObject,
  defineObject,
  meta,
} from "../dist/index.js";

const Person = defineObject({
  id: "Person",
  name: "Person",
  version: 1,
  attributes: {
    name: meta.string({ required: true }),
    age: meta.integer(),
    active: meta.boolean({ default: true }),
  },
});

test("createMetaObject provides a usable single-entry memory runtime", async () => {
  const runtime = createMetaObject({
    idGenerator: () => "person-1",
  });
  runtime.define(Person);

  const person = runtime.create(Person, { name: "Stephen", age: 41 });
  assert.equal(person.get("active"), true);
  await runtime.save(person);

  const loaded = await runtime.find({ type: "Person", id: "person-1" });
  assert.ok(loaded);
  assert.equal(loaded.get("name"), "Stephen");
  assert.equal(loaded.get("age"), 41);

  const rows = await runtime.query({
    objectType: "Person",
    where: [{ attribute: "age", operator: "gte", value: 40 }],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "person-1");

  assert.equal(runtime.storageName, "memory");
  assert.equal(runtime.supports("metadata-driven-types"), true);
  assert.equal(runtime.supports("deterministic-comparison"), true);
  assert.equal(runtime.supports("query-pushdown"), false);
});

test("createMetaObject accepts a caller-owned storage adapter", () => {
  const adapter = new MemoryStorageAdapter();
  const runtime = createMetaObject({ storage: { adapter, name: "test-storage" } });

  assert.equal(runtime.storage, adapter);
  assert.deepEqual(runtime.descriptor(), {
    storage: "test-storage",
    capabilities: {
      "metadata-driven-types": true,
      validation: true,
      relationships: true,
      "optimistic-concurrency": true,
      "batch-write": true,
      query: true,
      "query-pushdown": false,
      "deterministic-comparison": true,
    },
  });
});
