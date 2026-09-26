import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryMetadataStore,
  MetadataCatalog,
  MetadataReleaseManager,
  createDefaultTypeRegistry,
  defineObjectType,
} from "../dist/index.js";

function setup() {
  const types = createDefaultTypeRegistry();
  const catalog = new MetadataCatalog(new MemoryMetadataStore(), types);
  return { catalog, releases: new MetadataReleaseManager(catalog) };
}

test("batch release publishes mutually dependent object types together", async () => {
  const { catalog, releases } = setup();
  const Team = defineObjectType({
    id: "release.team",
    name: "Team",
    version: 1,
    attributes: { name: { type: "string", required: true } },
    relationships: {
      members: { target: "release.person", cardinality: "one-to-many", inverse: "team" },
    },
  });
  const Person = defineObjectType({
    id: "release.person",
    name: "Person",
    version: 1,
    attributes: { name: { type: "string", required: true } },
    relationships: {
      team: { target: "release.team", cardinality: "many-to-one", inverse: "members" },
    },
  });

  await catalog.saveDraft(Team);
  await catalog.saveDraft(Person);

  await assert.rejects(() => releases.release(Team.id, 1), /unknown target object type/i);

  const prepared = await releases.prepareMany([
    { objectTypeId: Team.id, targetVersion: 1 },
    { objectTypeId: Person.id, targetVersion: 1 },
  ], ["json-schema"]);
  assert.equal(prepared.releases.length, 2);
  assert.equal(prepared.artifacts.length, 2);
  assert.equal(prepared.blockingMigrationSteps, 0);

  const result = await releases.releaseMany([
    { objectTypeId: Team.id, targetVersion: 1 },
    { objectTypeId: Person.id, targetVersion: 1 },
  ], { artifactGenerators: ["json-schema"] });

  assert.deepEqual(result.published.map((record) => record.status), ["published", "published"]);
  const runtime = await catalog.createPublishedRegistry();
  runtime.validateRelationships();
  assert.equal(runtime.resolve(Team.id).relationships.members.target, Person.id);
  assert.equal(runtime.resolve(Person.id).relationships.team.target, Team.id);
});

test("batch preparation rejects duplicate object types", async () => {
  const { catalog, releases } = setup();
  const Definition = defineObjectType({ id: "release.duplicate", name: "Duplicate", version: 1, attributes: {} });
  await catalog.saveDraft(Definition);
  await assert.rejects(() => releases.prepareMany([
    { objectTypeId: Definition.id, targetVersion: 1 },
    { objectTypeId: Definition.id, targetVersion: 1 },
  ]), /Duplicate object type/);
});
