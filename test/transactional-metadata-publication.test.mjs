import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryMetadataStore,
  MetadataCatalog,
  createDefaultTypeRegistry,
  defineObjectType,
} from "../dist/index.js";

test("publishMany is atomic when one optimistic revision is stale", async () => {
  const catalog = new MetadataCatalog(new MemoryMetadataStore(), createDefaultTypeRegistry());
  const A = defineObjectType({ id: "atomic.a", name: "A", version: 1, attributes: {} });
  const B = defineObjectType({ id: "atomic.b", name: "B", version: 1, attributes: { code: { type: "string" } } });
  const aDraft = await catalog.saveDraft(A);
  const bDraft = await catalog.saveDraft(B);
  await catalog.saveDraft(defineObjectType({
    ...B,
    name: "B changed",
  }), bDraft.revision);

  await assert.rejects(() => catalog.publishMany([
    { objectTypeId: A.id, version: 1, expectedRevision: aDraft.revision },
    { objectTypeId: B.id, version: 1, expectedRevision: bDraft.revision },
  ]), /concurrency conflict/i);

  assert.equal((await catalog.get(A.id, 1)).status, "draft");
  assert.equal((await catalog.get(B.id, 1)).status, "draft");
});

test("publishMany commits every member when all revisions are valid", async () => {
  const catalog = new MetadataCatalog(new MemoryMetadataStore(), createDefaultTypeRegistry());
  const A = defineObjectType({
    id: "atomic.team",
    name: "Team",
    version: 1,
    attributes: {},
    relationships: { members: { target: "atomic.person", cardinality: "one-to-many", inverse: "team" } },
  });
  const B = defineObjectType({
    id: "atomic.person",
    name: "Person",
    version: 1,
    attributes: {},
    relationships: { team: { target: A.id, cardinality: "many-to-one", inverse: "members" } },
  });
  const aDraft = await catalog.saveDraft(A);
  const bDraft = await catalog.saveDraft(B);

  const published = await catalog.publishMany([
    { objectTypeId: A.id, version: 1, expectedRevision: aDraft.revision },
    { objectTypeId: B.id, version: 1, expectedRevision: bDraft.revision },
  ]);

  assert.deepEqual(published.map((record) => record.status), ["published", "published"]);
  assert.equal((await catalog.get(A.id, 1)).status, "published");
  assert.equal((await catalog.get(B.id, 1)).status, "published");
});
