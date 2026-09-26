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
  const releases = new MetadataReleaseManager(catalog);
  return { catalog, releases };
}

const V1 = defineObjectType({
  id: "release.asset",
  name: "Asset",
  version: 1,
  attributes: {
    code: { type: "string", required: true },
  },
});

test("initial release publishes a draft and emits portable artifacts", async () => {
  const { catalog, releases } = setup();
  await catalog.saveDraft(V1);

  const prepared = await releases.prepare(V1.id, 1);
  assert.equal(prepared.previousPublishedVersion, undefined);
  assert.equal(prepared.diff, undefined);
  assert.equal(prepared.migrationPlan, undefined);
  assert.deepEqual(prepared.artifacts.map((artifact) => artifact.kind), [
    "typescript",
    "typescript-validator",
    "json-schema",
    "metadata-snapshot",
  ]);

  const result = await releases.release(V1.id, 1);
  assert.equal(result.published.status, "published");
  assert.equal(result.published.objectTypeVersion, 1);
});

test("compatible upgrades publish without a migration executor", async () => {
  const { catalog, releases } = setup();
  await catalog.saveDraft(V1);
  await releases.release(V1.id, 1);

  const V2 = defineObjectType({
    ...V1,
    version: 2,
    attributes: {
      ...V1.attributes,
      description: { type: "string" },
    },
  });
  await catalog.saveDraft(V2);

  const prepared = await releases.prepare(V1.id, 2);
  assert.equal(prepared.diff.impact, "compatible");
  assert.equal(prepared.migrationPlan.steps[0].blocking, false);

  const result = await releases.release(V1.id, 2);
  assert.equal(result.published.status, "published");
  assert.equal(result.previousPublishedVersion, 1);
});

test("migration-required upgrades are blocked until an executor completes blocking steps", async () => {
  const { catalog, releases } = setup();
  await catalog.saveDraft(V1);
  await releases.release(V1.id, 1);

  const V2 = defineObjectType({
    ...V1,
    version: 2,
    attributes: {
      ...V1.attributes,
      status: { type: "string", required: true, default: "draft" },
    },
  });
  await catalog.saveDraft(V2);

  await assert.rejects(() => releases.release(V1.id, 2), /blocking migration step/);

  const executed = [];
  const result = await releases.release(V1.id, 2, {
    migrationExecutor: {
      async execute(step, context) {
        executed.push({ kind: step.kind, fromVersion: context.fromVersion, toVersion: context.toVersion });
      },
    },
  });
  assert.deepEqual(executed, [{ kind: "backfill-existing-data", fromVersion: 1, toVersion: 2 }]);
  assert.equal(result.published.status, "published");
});

test("breaking upgrades require explicit approval", async () => {
  const { catalog, releases } = setup();
  await catalog.saveDraft(V1);
  await releases.release(V1.id, 1);

  const V2 = defineObjectType({
    ...V1,
    version: 2,
    attributes: {
      code: { type: "integer", required: true },
    },
  });
  await catalog.saveDraft(V2);

  await assert.rejects(() => releases.release(V1.id, 2), /requires explicit approval/);
  const approved = await releases.release(V1.id, 2, { approveBreaking: true });
  assert.equal(approved.migrationPlan.requiresManualReview, true);
  assert.equal(approved.published.status, "published");
});

test("release aborts when a draft changes while migration work is executing", async () => {
  const { catalog, releases } = setup();
  await catalog.saveDraft(V1);
  await releases.release(V1.id, 1);

  const V2 = defineObjectType({
    ...V1,
    version: 2,
    attributes: {
      ...V1.attributes,
      status: { type: "string", required: true, default: "draft" },
    },
  });
  const draft = await catalog.saveDraft(V2);

  await assert.rejects(
    () => releases.release(V1.id, 2, {
      migrationExecutor: {
        async execute() {
          const changed = defineObjectType({
            ...V2,
            name: "Asset changed during release",
          });
          await catalog.saveDraft(changed, draft.revision);
        },
      },
    }),
    /changed during release preparation/,
  );

  assert.equal((await catalog.get(V1.id, 2)).status, "draft");
});

test("release can limit generated artifacts", async () => {
  const { catalog, releases } = setup();
  await catalog.saveDraft(V1);
  const result = await releases.release(V1.id, 1, { artifactGenerators: ["json-schema"] });
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].kind, "json-schema");
});
