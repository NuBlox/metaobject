import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryStorageAdapter,
  MetaObjectRepository,
  MetadataError,
  ObjectFactory,
  ObjectGraph,
  ObjectTypeRegistry,
  ValidationError,
  Validator,
  createDefaultTypeRegistry,
  defineObjectType,
} from "../dist/index.js";

function graphSetup() {
  const types = createDefaultTypeRegistry();
  const objects = new ObjectTypeRegistry(types);

  const Team = defineObjectType({
    id: "example.team",
    name: "Team",
    version: 1,
    attributes: {
      name: { type: "string", required: true },
    },
    relationships: {
      members: {
        target: "example.person",
        cardinality: "one-to-many",
        inverse: "team",
        ownership: "source",
        ordered: true,
      },
    },
  });

  const Person = defineObjectType({
    id: "example.person",
    name: "Person",
    version: 1,
    attributes: {
      name: { type: "string", required: true },
    },
    relationships: {
      team: {
        target: "example.team",
        cardinality: "many-to-one",
        inverse: "members",
        ownership: "target",
      },
    },
  });

  objects.register(Team);
  objects.register(Person);
  objects.validateRelationships();

  let id = 0;
  const factory = new ObjectFactory(objects, types, () => `object-${++id}`);
  const graph = new ObjectGraph(objects);
  return { types, objects, Team, Person, factory, graph };
}

test("validates inverse relationship metadata", () => {
  const { objects } = graphSetup();
  assert.doesNotThrow(() => objects.validateRelationships());

  const types = createDefaultTypeRegistry();
  const invalid = new ObjectTypeRegistry(types);
  invalid.register(defineObjectType({
    id: "a",
    name: "A",
    version: 1,
    attributes: {},
    relationships: {
      bs: { target: "b", cardinality: "one-to-many", inverse: "a" },
    },
  }));
  invalid.register(defineObjectType({
    id: "b",
    name: "B",
    version: 1,
    attributes: {},
    relationships: {
      a: { target: "a", cardinality: "one-to-one", inverse: "bs" },
    },
  }));
  assert.throws(() => invalid.validateRelationships(), /inverse cardinality/);
});

test("graph connect synchronizes inverse relationships", () => {
  const { Team, Person, factory, graph } = graphSetup();
  const team = factory.create(Team, { name: "Platform" });
  const stephen = factory.create(Person, { name: "Stephen" });

  graph.connect(team, "members", stephen);

  assert.deepEqual(team.getRelationship("members"), [
    { id: stephen.id, type: "example.person" },
  ]);
  assert.deepEqual(stephen.getRelationship("team"), {
    id: team.id,
    type: "example.team",
  });
  assert.deepEqual(graph.related(team, "members"), [stephen]);
});

test("to-many relationship collections reject duplicate identity and support ordered insertion", () => {
  const { Team, Person, factory, graph } = graphSetup();
  const team = factory.create(Team, { name: "Platform" });
  const one = factory.create(Person, { name: "One" });
  const two = factory.create(Person, { name: "Two" });

  graph.connect(team, "members", one);
  graph.connect(team, "members", one);
  graph.connect(team, "members", two, 0);

  assert.deepEqual(team.relationshipReferences("members").map((ref) => ref.id), [two.id, one.id]);
  assert.equal(team.relationshipCount("members"), 2);
});

test("disconnect synchronizes both ends", () => {
  const { Team, Person, factory, graph } = graphSetup();
  const team = factory.create(Team, { name: "Platform" });
  const person = factory.create(Person, { name: "Stephen" });
  graph.connect(team, "members", person);

  graph.disconnect(team, "members", person);

  assert.equal(team.relationshipCount("members"), 0);
  assert.equal(person.getRelationship("team"), undefined);
});

test("inverse singular cardinality conflicts are rejected", () => {
  const types = createDefaultTypeRegistry();
  const objects = new ObjectTypeRegistry(types);
  const Person = defineObjectType({
    id: "person",
    name: "Person",
    version: 1,
    attributes: { name: { type: "string", required: true } },
    relationships: {
      spouse: { target: "person", cardinality: "one-to-one", inverse: "spouse" },
    },
  });
  objects.register(Person);
  objects.validateRelationships();
  let id = 0;
  const factory = new ObjectFactory(objects, types, () => `p-${++id}`);
  const graph = new ObjectGraph(objects);
  const a = factory.create(Person, { name: "A" });
  const b = factory.create(Person, { name: "B" });
  const c = factory.create(Person, { name: "C" });

  graph.connect(a, "spouse", b);
  assert.throws(() => graph.connect(c, "spouse", b), /inverse cardinality/);
});

test("tracks relationship changes independently of attribute changes", async () => {
  const { Team, Person, factory, graph } = graphSetup();
  const storage = new MemoryStorageAdapter();
  const repository = new MetaObjectRepository(storage, factory, new Validator());
  const team = factory.create(Team, { name: "Platform" });
  const person = factory.create(Person, { name: "Stephen" });
  await repository.save(team);
  await repository.save(person);

  graph.connect(team, "members", person);

  assert.equal(team.state, "dirty");
  assert.deepEqual(team.changedRelationships().members, {
    before: undefined,
    after: [{ id: person.id, type: "example.person" }],
  });
});

test("repository rejects dangling references and resolves persisted relationships", async () => {
  const { Team, Person, factory, graph } = graphSetup();
  const storage = new MemoryStorageAdapter();
  const repository = new MetaObjectRepository(storage, factory, new Validator());
  const dangling = factory.create(Team, { name: "Dangling" });
  dangling.setRelationship("members", { id: "missing", type: "example.person" });
  await assert.rejects(() => repository.save(dangling), ValidationError);

  const team = factory.create(Team, { name: "Platform" });
  const person = factory.create(Person, { name: "Stephen" });
  graph.connect(team, "members", person);
  await repository.saveAll([team, person]);

  const related = await repository.related(team, "members");
  assert.equal(related.length, 1);
  assert.equal(related[0]?.get("name"), "Stephen");
});

test("target delete defaults to detach", () => {
  const { Team, Person, factory, graph } = graphSetup();
  const team = factory.create(Team, { name: "Platform" });
  const person = factory.create(Person, { name: "Stephen" });
  graph.connect(team, "members", person);

  graph.delete(person);

  assert.equal(person.state, "deleted");
  assert.equal(team.relationshipCount("members"), 0);
});

test("restrict delete policy prevents deletion while related", () => {
  const types = createDefaultTypeRegistry();
  const objects = new ObjectTypeRegistry(types);
  const Parent = defineObjectType({
    id: "parent",
    name: "Parent",
    version: 1,
    attributes: {},
    relationships: {
      children: {
        target: "child",
        cardinality: "one-to-many",
        onTargetDelete: "restrict",
      },
    },
  });
  const Child = defineObjectType({ id: "child", name: "Child", version: 1, attributes: {} });
  objects.register(Parent);
  objects.register(Child);
  objects.validateRelationships();
  let id = 0;
  const factory = new ObjectFactory(objects, types, () => `x-${++id}`);
  const graph = new ObjectGraph(objects);
  const parent = factory.create(Parent, {});
  const child = factory.create(Child, {});
  graph.connect(parent, "children", child);

  assert.throws(() => graph.delete(child), MetadataError);
  assert.notEqual(child.state, "deleted");
});

test("cascade source deletion propagates to related targets", () => {
  const types = createDefaultTypeRegistry();
  const objects = new ObjectTypeRegistry(types);
  const Node = defineObjectType({
    id: "node",
    name: "Node",
    version: 1,
    attributes: {},
    relationships: {
      children: {
        target: "node",
        cardinality: "one-to-many",
        onSourceDelete: "cascade",
      },
    },
  });
  objects.register(Node);
  objects.validateRelationships();
  let id = 0;
  const factory = new ObjectFactory(objects, types, () => `n-${++id}`);
  const graph = new ObjectGraph(objects);
  const parent = factory.create(Node, {});
  const child = factory.create(Node, {});
  graph.connect(parent, "children", child);

  graph.delete(parent);

  assert.equal(parent.state, "deleted");
  assert.equal(child.state, "deleted");
});
