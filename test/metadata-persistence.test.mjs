import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryMetadataStore,
  MetadataCatalog,
  createDefaultTypeRegistry,
  defineObjectType,
  denormalizeObjectType,
  normalizeObjectType,
} from "../dist/index.js";

const comprehensive = defineObjectType({
  id: "meta.example",
  name: "Example",
  namespace: "test",
  version: 3,
  extensible: true,
  attributes: {
    code: {
      type: "string",
      required: true,
      unique: true,
      default: "NEW",
      constraints: [
        { type: "minLength", value: 2, message: "Too short" },
        { type: "pattern", pattern: "^[A-Z]+$", flags: "i" },
      ],
    },
    amount: { type: "decimal", nullable: true, constraints: [{ type: "range", minimum: 0, maximum: 100 }] },
    total: { type: "decimal", computed: { resolver: "example.total", dependencies: ["amount"], cache: true } },
  },
  relationships: {
    parent: {
      target: "meta.parent",
      cardinality: "many-to-one",
      inverse: "children",
      ownership: "none",
      kind: "association",
      onTargetDelete: "detach",
    },
  },
  indexes: [
    { name: "ux-example-code", unique: true, attributes: [{ attribute: "code", direction: "asc" }] },
  ],
  rules: [
    { id: "amount-rule", type: "amountRule", severity: "warning", parameters: { threshold: 10 } },
  ],
  operations: {
    approve: { handler: "example.approve", description: "Approve example" },
  },
  events: {
    approved: { description: "Example approved" },
  },
  hooks: [
    { id: "validate-hook", phase: "beforeValidate", handler: "example.beforeValidate" },
  ],
});

test("normalized metadata round-trips a comprehensive object definition", () => {
  const snapshot = normalizeObjectType(comprehensive);
  assert.equal(snapshot.objectType.objectTypeId, comprehensive.id);
  assert.equal(snapshot.attributes.length, 3);
  assert.equal(snapshot.attributeConstraints.length, 3);
  assert.equal(snapshot.relationships.length, 1);
  assert.equal(snapshot.indexes.length, 1);
  assert.equal(snapshot.indexAttributes.length, 1);
  assert.equal(snapshot.rules.length, 1);
  assert.equal(snapshot.operations.length, 1);
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.hooks.length, 1);
  assert.deepEqual(denormalizeObjectType(snapshot), comprehensive);
});

test("metadata drafts use optimistic revision concurrency", async () => {
  const types = createDefaultTypeRegistry();
  const catalog = new MetadataCatalog(new MemoryMetadataStore(), types, () => new Date("2026-01-01T00:00:00.000Z"));
  const V1 = defineObjectType({ id: "meta.concurrent", name: "Concurrent", version: 1, attributes: { name: { type: "string" } } });
  const first = await catalog.saveDraft(V1);
  assert.equal(first.revision, 1);

  const changed = defineObjectType({ id: "meta.concurrent", name: "Concurrent changed", version: 1, attributes: { name: { type: "string" } } });
  const second = await catalog.saveDraft(changed, first.revision);
  assert.equal(second.revision, 2);
  await assert.rejects(() => catalog.saveDraft(V1, first.revision), /concurrency conflict/i);
});

test("batch publication validates a dependent metadata graph before activation", async () => {
  const types = createDefaultTypeRegistry();
  const catalog = new MetadataCatalog(new MemoryMetadataStore(), types);
  const Parent = defineObjectType({
    id: "meta.parent",
    name: "Parent",
    version: 1,
    attributes: { name: { type: "string" } },
    relationships: { children: { target: "meta.child", cardinality: "one-to-many", inverse: "parent" } },
  });
  const Child = defineObjectType({
    id: "meta.child",
    name: "Child",
    version: 1,
    baseType: Parent.id,
    attributes: { childCode: { type: "string" } },
    relationships: { parent: { target: Parent.id, cardinality: "many-to-one", inverse: "children" } },
  });
  const parentDraft = await catalog.saveDraft(Parent);
  const childDraft = await catalog.saveDraft(Child);

  await assert.rejects(() => catalog.publish(Child.id, Child.version, childDraft.revision), /unknown base object type/i);
  const published = await catalog.publishMany([
    { objectTypeId: Parent.id, version: Parent.version, expectedRevision: parentDraft.revision },
    { objectTypeId: Child.id, version: Child.version, expectedRevision: childDraft.revision },
  ]);
  assert.deepEqual(published.map((record) => record.status), ["published", "published"]);

  const runtime = await catalog.createPublishedRegistry();
  assert.equal(runtime.isA(Child.id, Parent.id), true);
  runtime.validateRelationships();
});

test("latest published version is selected for runtime loading", async () => {
  const types = createDefaultTypeRegistry();
  const catalog = new MetadataCatalog(new MemoryMetadataStore(), types);
  const V1 = defineObjectType({ id: "meta.versioned", name: "Versioned", version: 1, attributes: { one: { type: "string" } } });
  const V2 = defineObjectType({ id: "meta.versioned", name: "Versioned", version: 2, attributes: { two: { type: "string" } } });
  const d1 = await catalog.saveDraft(V1);
  await catalog.publish(V1.id, V1.version, d1.revision);
  const d2 = await catalog.saveDraft(V2);
  await catalog.publish(V2.id, V2.version, d2.revision);

  const latest = await catalog.latest(V1.id, "published");
  assert.equal(latest.objectTypeVersion, 2);
  const runtime = await catalog.createPublishedRegistry();
  assert.ok(runtime.resolve(V1.id).attributes.two);
  assert.equal(runtime.resolve(V1.id).attributes.one, undefined);
});

test("metadata bundles export and import catalogue records", async () => {
  const types = createDefaultTypeRegistry();
  const source = new MetadataCatalog(new MemoryMetadataStore(), types);
  const Definition = defineObjectType({ id: "meta.bundle", name: "Bundle", version: 1, attributes: { code: { type: "string" } } });
  const draft = await source.saveDraft(Definition);
  await source.publish(Definition.id, Definition.version, draft.revision);
  const bundle = await source.exportBundle();

  const target = new MetadataCatalog(new MemoryMetadataStore(), types);
  await target.importBundle(bundle);
  const imported = await target.getDefinition(Definition.id, Definition.version);
  assert.deepEqual(imported, Definition);
  assert.equal((await target.get(Definition.id, Definition.version)).status, "published");
});
