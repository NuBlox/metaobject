import assert from "node:assert/strict";
import test from "node:test";
import {
  MetadataError,
  ObjectFactory,
  ObjectGraph,
  ObjectTypeRegistry,
  createDefaultTypeRegistry,
  defineDerivedObjectType,
  defineObjectType,
} from "../dist/index.js";

function inheritanceSetup() {
  const types = createDefaultTypeRegistry();
  const objects = new ObjectTypeRegistry(types);

  const Party = defineObjectType({
    id: "example.party",
    name: "Party",
    version: 1,
    abstract: true,
    attributes: {
      name: { type: "string", required: true },
      active: { type: "boolean", default: true },
    },
    relationships: {
      owner: {
        target: "example.organisation",
        cardinality: "many-to-one",
      },
    },
    indexes: [
      { name: "idx-party-name", attributes: [{ attribute: "name" }] },
    ],
  });

  const Employee = defineDerivedObjectType(Party, {
    id: "example.employee",
    name: "Employee",
    version: 1,
    baseType: "example.party",
    attributes: {
      employeeNumber: { type: "string", required: true },
    },
    indexes: [
      { name: "idx-employee-number", unique: true, attributes: [{ attribute: "employeeNumber" }] },
      { name: "idx-employee-name", attributes: [{ attribute: "name" }] },
    ],
  });

  const Organisation = defineObjectType({
    id: "example.organisation",
    name: "Organisation",
    version: 1,
    attributes: {
      name: { type: "string", required: true },
    },
    relationships: {
      people: {
        target: "example.party",
        cardinality: "one-to-many",
      },
    },
  });

  objects.register(Party);
  objects.register(Employee);
  objects.register(Organisation);
  objects.validateHierarchy();
  objects.validateRelationships();

  let id = 0;
  const factory = new ObjectFactory(objects, types, () => `object-${++id}`);
  return { types, objects, Party, Employee, Organisation, factory };
}

test("resolves inherited attributes, relationships, indexes and lineage", () => {
  const { objects } = inheritanceSetup();
  const employee = objects.resolve("example.employee");

  assert.deepEqual(employee.lineage, ["example.party", "example.employee"]);
  assert.ok(employee.attributes.name);
  assert.ok(employee.attributes.active);
  assert.ok(employee.attributes.employeeNumber);
  assert.ok(employee.relationships?.owner);
  assert.deepEqual(employee.indexes?.map((index) => index.name), [
    "idx-party-name",
    "idx-employee-number",
    "idx-employee-name",
  ]);
});

test("factory applies inherited defaults and rejects abstract types", () => {
  const { Party, Employee, factory } = inheritanceSetup();
  assert.throws(() => factory.create(Party, { name: "Abstract" }), /abstract object type/);

  const employee = factory.create(Employee, {
    name: "Stephen",
    employeeNumber: "E-001",
  });
  assert.equal(employee.get("name"), "Stephen");
  assert.equal(employee.get("employeeNumber"), "E-001");
  assert.equal(employee.get("active"), true);
});

test("registry exposes isA, direct subtypes and transitive subtypes", () => {
  const { types, objects, Employee } = inheritanceSetup();
  const Manager = defineDerivedObjectType(Employee, {
    id: "example.manager",
    name: "Manager",
    version: 1,
    baseType: "example.employee",
    attributes: { grade: { type: "integer" } },
  });
  objects.register(Manager);
  objects.validateHierarchy();

  assert.equal(objects.isA("example.manager", "example.party"), true);
  assert.equal(objects.isA("example.party", "example.manager"), false);
  assert.deepEqual(objects.lineage("example.manager"), [
    "example.party",
    "example.employee",
    "example.manager",
  ]);
  assert.deepEqual(objects.directSubtypes("example.party").map((type) => type.id), ["example.employee"]);
  assert.deepEqual(objects.subtypes("example.party").map((type) => type.id), ["example.employee", "example.manager"]);
  void types;
});

test("sealed types cannot be inherited", () => {
  const types = createDefaultTypeRegistry();
  const objects = new ObjectTypeRegistry(types);
  const Base = defineObjectType({
    id: "base",
    name: "Base",
    version: 1,
    sealed: true,
    attributes: {},
  });
  const Child = defineDerivedObjectType(Base, {
    id: "child",
    name: "Child",
    version: 1,
    baseType: "base",
    attributes: {},
  });
  objects.register(Base);
  objects.register(Child);
  assert.throws(() => objects.validateHierarchy(), /sealed object type/);
});

test("inheritance cycles are rejected", () => {
  const types = createDefaultTypeRegistry();
  const objects = new ObjectTypeRegistry(types);
  objects.register(defineObjectType({ id: "a", name: "A", version: 1, baseType: "b", attributes: {} }));
  objects.register(defineObjectType({ id: "b", name: "B", version: 1, baseType: "a", attributes: {} }));
  assert.throws(() => objects.validateHierarchy(), /Inheritance cycle detected/);
});

test("derived metadata cannot shadow inherited members or index names", () => {
  const types = createDefaultTypeRegistry();
  const objects = new ObjectTypeRegistry(types);
  const Base = defineObjectType({
    id: "base",
    name: "Base",
    version: 1,
    attributes: { code: { type: "string" } },
    relationships: { parent: { target: "base", cardinality: "many-to-one" } },
    indexes: [{ name: "idx-code", attributes: [{ attribute: "code" }] }],
  });
  objects.register(Base);
  objects.register(defineObjectType({
    id: "attribute-child",
    name: "AttributeChild",
    version: 1,
    baseType: "base",
    attributes: { code: { type: "string" } },
  }));
  assert.throws(() => objects.resolve("attribute-child"), /shadows inherited attribute/);

  const objects2 = new ObjectTypeRegistry(types);
  objects2.register(Base);
  objects2.register(defineObjectType({
    id: "relationship-child",
    name: "RelationshipChild",
    version: 1,
    baseType: "base",
    attributes: {},
    relationships: { parent: { target: "base", cardinality: "many-to-one" } },
  }));
  assert.throws(() => objects2.resolve("relationship-child"), /shadows inherited relationship/);

  const objects3 = new ObjectTypeRegistry(types);
  objects3.register(Base);
  objects3.register(defineObjectType({
    id: "index-child",
    name: "IndexChild",
    version: 1,
    baseType: "base",
    attributes: {},
    indexes: [{ name: "idx-code", attributes: [{ attribute: "code" }] }],
  }));
  assert.throws(() => objects3.resolve("index-child"), /shadows an inherited index/);
});

test("relationships targeting a base type accept subtype instances", () => {
  const { Employee, Organisation, factory, objects } = inheritanceSetup();
  const graph = new ObjectGraph(objects);
  const organisation = factory.create(Organisation, { name: "NuBlox" });
  const employee = factory.create(Employee, { name: "Stephen", employeeNumber: "E-001" });

  assert.doesNotThrow(() => graph.connect(organisation, "people", employee));
  assert.equal(organisation.relationshipReferences("people")[0]?.type, "example.employee");
});

test("composition enforces a single composite parent", () => {
  const types = createDefaultTypeRegistry();
  const objects = new ObjectTypeRegistry(types);
  const Folder = defineObjectType({
    id: "folder",
    name: "Folder",
    version: 1,
    attributes: {},
    relationships: {
      files: {
        target: "file",
        cardinality: "one-to-many",
        kind: "composition",
        ownership: "source",
      },
    },
  });
  const File = defineObjectType({ id: "file", name: "File", version: 1, attributes: {} });
  objects.register(Folder);
  objects.register(File);
  objects.validateRelationships();
  let id = 0;
  const factory = new ObjectFactory(objects, types, () => `c-${++id}`);
  const graph = new ObjectGraph(objects);
  const first = factory.create(Folder, {});
  const second = factory.create(Folder, {});
  const file = factory.create(File, {});

  graph.connect(first, "files", file);
  assert.equal(graph.compositeParent(file)?.object, first);
  assert.throws(() => graph.connect(second, "files", file), /already has composite parent/);
});

test("composition source deletion cascades by default", () => {
  const types = createDefaultTypeRegistry();
  const objects = new ObjectTypeRegistry(types);
  const Aggregate = defineObjectType({
    id: "aggregate",
    name: "Aggregate",
    version: 1,
    attributes: {},
    relationships: {
      parts: {
        target: "part",
        cardinality: "one-to-many",
        kind: "composition",
      },
    },
  });
  const Part = defineObjectType({ id: "part", name: "Part", version: 1, attributes: {} });
  objects.register(Aggregate);
  objects.register(Part);
  objects.validateRelationships();
  let id = 0;
  const factory = new ObjectFactory(objects, types, () => `d-${++id}`);
  const graph = new ObjectGraph(objects);
  const aggregate = factory.create(Aggregate, {});
  const part = factory.create(Part, {});
  graph.connect(aggregate, "parts", part);

  graph.delete(aggregate);
  assert.equal(aggregate.state, "deleted");
  assert.equal(part.state, "deleted");
});

test("invalid composition metadata is rejected", () => {
  const types = createDefaultTypeRegistry();
  const objects = new ObjectTypeRegistry(types);
  assert.throws(() => objects.register(defineObjectType({
    id: "invalid",
    name: "Invalid",
    version: 1,
    attributes: {},
    relationships: {
      parts: {
        target: "part",
        cardinality: "many-to-many",
        kind: "composition",
      },
    },
  })), /composition must be/);
});
