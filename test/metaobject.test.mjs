import assert from "node:assert/strict";
import test from "node:test";
import {
  ConcurrencyError,
  MemoryStorageAdapter,
  MetaObjectRepository,
  ObjectFactory,
  ObjectTypeRegistry,
  Validator,
  createDefaultTypeRegistry,
  defineObjectType,
  generateTypeScriptInterface,
} from "../dist/index.js";

function setup() {
  const types = createDefaultTypeRegistry();
  const objects = new ObjectTypeRegistry(types);
  const Person = defineObjectType({
    id: "example.person",
    name: "Person",
    version: 1,
    attributes: {
      firstName: { type: "string", required: true, constraints: [{ type: "minLength", value: 2 }] },
      age: { type: "integer", constraints: [{ type: "range", minimum: 0, maximum: 130 }] },
      active: { type: "boolean", default: true },
      bornAt: { type: "date" },
    },
    relationships: {
      manager: { target: "example.person", cardinality: "many-to-one" },
    },
  });
  objects.register(Person);
  objects.validateRelationships();
  let id = 0;
  const factory = new ObjectFactory(objects, types, () => `person-${++id}`);
  const validator = new Validator();
  const storage = new MemoryStorageAdapter();
  const repository = new MetaObjectRepository(storage, factory, validator);
  return { types, objects, Person, factory, validator, storage, repository };
}

test("creates metadata-defined object and applies defaults", () => {
  const { Person, factory } = setup();
  const person = factory.create(Person, { firstName: "Stephen", age: 41 });
  assert.equal(person.get("firstName"), "Stephen");
  assert.equal(person.get("age"), 41);
  assert.equal(person.get("active"), true);
  assert.equal(person.state, "new");
});

test("enforces runtime attribute types", () => {
  const { factory } = setup();
  assert.throws(() => factory.create("example.person", { firstName: "Stephen", age: "41" }), /requires type 'integer'/);
});

test("validates required attributes and constraints", () => {
  const { factory, validator } = setup();
  const missing = factory.create("example.person", { age: 200 });
  const result = validator.validate(missing);
  assert.equal(result.valid, false);
  assert.deepEqual(result.issues.map((item) => item.code).sort(), ["MAXIMUM", "REQUIRED"]);
});

test("checks relationship target type", () => {
  const { factory } = setup();
  const person = factory.create("example.person", { firstName: "Stephen" });
  assert.throws(() => person.setRelationship("manager", { id: "x", type: "wrong.type" }), /requires target type/);
  person.setRelationship("manager", { id: "person-99", type: "example.person" });
  assert.deepEqual(person.getRelationship("manager"), { id: "person-99", type: "example.person" });
});

test("tracks dirty attributes", async () => {
  const { factory, repository } = setup();
  const person = factory.create("example.person", { firstName: "Stephen", age: 41 });
  await repository.save(person);
  person.set("age", 42);
  assert.equal(person.state, "dirty");
  assert.deepEqual(person.changedAttributes().age, { before: 41, after: 42 });
});

test("serializes dates using registered types", () => {
  const { factory } = setup();
  const bornAt = new Date("1985-09-10T00:00:00.000Z");
  const person = factory.create("example.person", { firstName: "Stephen", bornAt });
  assert.equal(person.toJSON().bornAt, "1985-09-10T00:00:00.000Z");
});

test("repository persists, retrieves and queries objects", async () => {
  const { factory, repository } = setup();
  const a = factory.create("example.person", { firstName: "Alice", age: 30 });
  const b = factory.create("example.person", { firstName: "Bob", age: 45 });
  await repository.save(a);
  await repository.save(b);
  const found = await repository.find({ id: a.id, type: "example.person" });
  assert.equal(found?.get("firstName"), "Alice");
  const results = await repository.query({
    objectType: "example.person",
    where: [{ attribute: "age", operator: "gte", value: 40 }],
  });
  assert.equal(results.length, 1);
  assert.equal(results[0]?.get("firstName"), "Bob");
});

test("detects optimistic concurrency conflicts", async () => {
  const { factory, repository } = setup();
  const person = factory.create("example.person", { firstName: "Stephen", age: 41 });
  await repository.save(person);
  const first = await repository.find({ id: person.id, type: "example.person" });
  const second = await repository.find({ id: person.id, type: "example.person" });
  first.set("age", 42);
  await repository.save(first);
  second.set("age", 43);
  await assert.rejects(() => repository.save(second), ConcurrencyError);
});

test("generates a TypeScript interface", () => {
  const { Person } = setup();
  const output = generateTypeScriptInterface(Person);
  assert.match(output, /export interface Person/);
  assert.match(output, /firstName: string;/);
  assert.match(output, /age\?: number;/);
});
