import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryStorageAdapter,
  MetaObjectRepository,
  ObjectFactory,
  ObjectTypeRegistry,
  QueryEngine,
  QueryPlanner,
  Validator,
  createDefaultTypeRegistry,
  defineDerivedObjectType,
  defineObjectType,
} from "../dist/index.js";

async function setup() {
  const types = createDefaultTypeRegistry();
  const objects = new ObjectTypeRegistry(types);
  const Department = defineObjectType({
    id: "query.department",
    name: "Department",
    version: 1,
    attributes: { name: { type: "string", required: true } },
  });
  const Person = defineObjectType({
    id: "query.person",
    name: "Person",
    version: 1,
    attributes: {
      name: { type: "string", required: true },
      age: { type: "integer", required: true },
      salary: { type: "decimal", required: true },
    },
    relationships: {
      department: { target: Department.id, cardinality: "many-to-one" },
    },
  });
  objects.register(Department);
  objects.register(Person);
  objects.validateRelationships();

  let id = 0;
  const factory = new ObjectFactory(objects, types, () => `q-${++id}`);
  const storage = new MemoryStorageAdapter();
  const repository = new MetaObjectRepository(storage, factory, new Validator());
  const engineering = factory.create(Department, { name: "Engineering" });
  const finance = factory.create(Department, { name: "Finance" });
  const alice = factory.create(Person, { name: "Alice", age: 31, salary: 70000 });
  const bob = factory.create(Person, { name: "Bob", age: 42, salary: 90000 });
  const cara = factory.create(Person, { name: "Cara", age: 28, salary: 65000 });
  const dan = factory.create(Person, { name: "Dan", age: 17, salary: 30000 });
  alice.setRelationship("department", { id: engineering.id, type: Department.id });
  bob.setRelationship("department", { id: engineering.id, type: Department.id });
  cara.setRelationship("department", { id: finance.id, type: Department.id });
  dan.setRelationship("department", { id: engineering.id, type: Department.id });
  await repository.saveAll([engineering, finance, alice, bob, cara, dan]);

  const planner = new QueryPlanner(objects);
  const engine = new QueryEngine(storage, planner);
  return { objects, Department, Person, planner, engine };
}

test("planner validates metadata paths and records relationship traversal", async () => {
  const { planner, Person } = await setup();
  const plan = planner.plan({
    objectType: Person.id,
    where: { path: "department.name", operator: "eq", value: "Engineering" },
    select: [{ path: "name" }, { path: "department.name" }],
  });
  assert.deepEqual(plan.relationshipPaths, ["department"]);
  assert.ok(plan.stableOrder.some((item) => item.path === "$id"));
  assert.throws(
    () => planner.plan({ objectType: Person.id, where: { path: "missing.name", operator: "eq", value: "x" } }),
    /unknown member/,
  );
});

test("executes logical groups and relationship traversal", async () => {
  const { engine, Person } = await setup();
  const result = await engine.execute({
    objectType: Person.id,
    where: {
      and: [
        { path: "age", operator: "gte", value: 18 },
        {
          or: [
            { path: "department.name", operator: "eq", value: "Engineering" },
            { path: "name", operator: "startsWith", value: "C" },
          ],
        },
      ],
    },
    select: [
      { path: "name" },
      { path: "department.name", as: "department" },
    ],
    orderBy: [{ path: "salary", direction: "desc" }],
  });
  assert.deepEqual(result.rows.map((row) => row.values.name), ["Bob", "Alice", "Cara"]);
  assert.deepEqual(result.rows.map((row) => row.values.department), ["Engineering", "Engineering", "Finance"]);
  assert.equal(result.totalMatched, 3);
});

test("calculates aggregates before pagination", async () => {
  const { engine, Person } = await setup();
  const result = await engine.execute({
    objectType: Person.id,
    where: { path: "age", operator: "gte", value: 18 },
    aggregates: [
      { function: "count", as: "people" },
      { function: "sum", path: "salary", as: "payroll" },
      { function: "avg", path: "salary", as: "averageSalary" },
      { function: "max", path: "salary", as: "highestSalary" },
    ],
    orderBy: [{ path: "salary", direction: "desc" }],
    page: { first: 1 },
  });
  assert.deepEqual(result.aggregates, {
    people: 3,
    payroll: 225000,
    averageSalary: 75000,
    highestSalary: 90000,
  });
  assert.equal(result.rows.length, 1);
  assert.equal(result.pageInfo.hasNextPage, true);
});

test("cursor pagination is stable across pages", async () => {
  const { engine, Person } = await setup();
  const first = await engine.execute({
    objectType: Person.id,
    select: [{ path: "name" }],
    orderBy: [{ path: "salary", direction: "desc" }],
    page: { first: 2 },
  });
  assert.deepEqual(first.rows.map((row) => row.values.name), ["Bob", "Alice"]);
  assert.equal(first.pageInfo.hasNextPage, true);
  assert.ok(first.pageInfo.endCursor);

  const second = await engine.execute({
    objectType: Person.id,
    select: [{ path: "name" }],
    orderBy: [{ path: "salary", direction: "desc" }],
    page: { first: 2, after: first.pageInfo.endCursor },
  });
  assert.deepEqual(second.rows.map((row) => row.values.name), ["Cara", "Dan"]);
  assert.equal(second.pageInfo.hasNextPage, false);
});

test("planner expands subtype roots on request", () => {
  const types = createDefaultTypeRegistry();
  const objects = new ObjectTypeRegistry(types);
  const Party = defineObjectType({
    id: "query.party",
    name: "Party",
    version: 1,
    attributes: { name: { type: "string" } },
  });
  const Employee = defineDerivedObjectType(Party, {
    id: "query.employee",
    name: "Employee",
    version: 1,
    baseType: Party.id,
    attributes: { employeeNumber: { type: "string" } },
  });
  objects.register(Party);
  objects.register(Employee);
  const plan = new QueryPlanner(objects).plan({ objectType: Party.id, includeSubtypes: true });
  assert.deepEqual(plan.rootTypes, [Party.id, Employee.id]);
});
