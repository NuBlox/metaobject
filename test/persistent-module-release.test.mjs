import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryMetadataModuleStore,
  MemoryMetadataStore,
  MetadataCatalog,
  MetadataModuleCatalog,
  MetadataReleaseManager,
  PersistentMetadataModuleReleaseManager,
  createDefaultTypeRegistry,
  defineMetadataModule,
  defineObjectType,
} from "../dist/index.js";

function setup() {
  const metadata = new MetadataCatalog(new MemoryMetadataStore(), createDefaultTypeRegistry());
  const modules = new MetadataModuleCatalog(new MemoryMetadataModuleStore());
  const metadataReleases = new MetadataReleaseManager(metadata);
  const releases = new PersistentMetadataModuleReleaseManager(modules, metadata, metadataReleases);
  return { metadata, modules, releases };
}

function manifest(module) {
  return {
    format: "nublox-metaobject-module",
    formatVersion: 1,
    moduleId: module.id,
    moduleVersion: module.version,
    dependencies: [],
    members: module.members.map((member) => ({ ...member })),
  };
}

test("persistent module release publishes members then completes the durable module record", async () => {
  const { metadata, modules, releases } = setup();
  const Person = defineObjectType({
    id: "persistent.person",
    name: "Person",
    version: 1,
    attributes: { name: { type: "string", required: true } },
  });
  const Workforce = defineMetadataModule({
    id: "workforce",
    name: "Workforce",
    version: 1,
    members: [{ objectTypeId: Person.id, version: 1 }],
  });
  await metadata.saveDraft(Person);
  await modules.saveDraft(Workforce);

  const result = await releases.release(Workforce.id, 1, { artifactGenerators: ["json-schema"] });

  assert.equal(result.moduleRecord.status, "published");
  assert.equal(result.moduleRecord.releasedManifest.moduleId, Workforce.id);
  assert.equal((await metadata.get(Person.id, 1)).status, "published");
  assert.equal(result.release.release.artifacts.length, 1);
});

test("beginRelease locks module metadata against draft edits and abort unlocks it", async () => {
  const { modules } = setup();
  const Definition = defineMetadataModule({
    id: "locked",
    name: "Locked",
    version: 1,
    members: [{ objectTypeId: "persistent.locked", version: 1 }],
  });
  const draft = await modules.saveDraft(Definition);
  const locked = await modules.beginRelease(Definition.id, 1, draft.revision, manifest(Definition));
  assert.equal(locked.status, "releasing");
  await assert.rejects(() => modules.saveDraft({ ...Definition, name: "Changed" }, locked.revision), /releasing.*cannot be edited/i);

  const aborted = await modules.abortRelease(Definition.id, 1, locked.revision);
  assert.equal(aborted.status, "draft");
  assert.equal(aborted.releasedManifest, undefined);
});

test("failed migration leaves module releasing until an explicit abort or recovery decision", async () => {
  const { metadata, modules, releases } = setup();
  const AssetV1 = defineObjectType({
    id: "persistent.asset",
    name: "Asset",
    version: 1,
    attributes: { code: { type: "string", required: true } },
  });
  const ModuleV1 = defineMetadataModule({
    id: "assets",
    name: "Assets",
    version: 1,
    members: [{ objectTypeId: AssetV1.id, version: 1 }],
  });
  await metadata.saveDraft(AssetV1);
  await modules.saveDraft(ModuleV1);
  await releases.release(ModuleV1.id, 1);

  const AssetV2 = defineObjectType({
    ...AssetV1,
    version: 2,
    attributes: {
      ...AssetV1.attributes,
      status: { type: "string", required: true, default: "draft" },
    },
  });
  const ModuleV2 = defineMetadataModule({
    ...ModuleV1,
    version: 2,
    members: [{ objectTypeId: AssetV2.id, version: 2 }],
  });
  await metadata.saveDraft(AssetV2);
  await modules.saveDraft(ModuleV2);

  await assert.rejects(() => releases.release(ModuleV2.id, 2, {
    migrationExecutor: {
      async execute() { throw new Error("migration failed"); },
    },
  }), /migration failed/);

  assert.equal((await modules.get(ModuleV2.id, 2)).status, "releasing");
  assert.equal((await metadata.get(AssetV2.id, 2)).status, "draft");

  const aborted = await releases.abort(ModuleV2.id, 2);
  assert.equal(aborted.status, "draft");
});

test("partial member publication blocks abort and recovery until the graph is complete", async () => {
  const { metadata, modules, releases } = setup();
  const A = defineObjectType({ id: "persistent.a", name: "A", version: 1, attributes: {} });
  const B = defineObjectType({ id: "persistent.b", name: "B", version: 1, attributes: {} });
  const Bundle = defineMetadataModule({
    id: "bundle",
    name: "Bundle",
    version: 1,
    members: [
      { objectTypeId: A.id, version: 1 },
      { objectTypeId: B.id, version: 1 },
    ],
  });
  const aDraft = await metadata.saveDraft(A);
  const bDraft = await metadata.saveDraft(B);
  const moduleDraft = await modules.saveDraft(Bundle);
  await modules.beginRelease(Bundle.id, 1, moduleDraft.revision, manifest(Bundle));

  await metadata.publish(A.id, 1, aDraft.revision);
  await assert.rejects(() => releases.abort(Bundle.id, 1), /after member publication.*persistent.a@1/);
  await assert.rejects(() => releases.recover(Bundle.id, 1), /unpublished members.*persistent.b@1/);

  await metadata.publish(B.id, 1, bDraft.revision);
  const recovered = await releases.recover(Bundle.id, 1);
  assert.equal(recovered.status, "published");
});
