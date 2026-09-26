import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryMetadataModuleStore,
  MetadataModuleCatalog,
  MetadataModuleRegistry,
  defineMetadataModule,
} from "../dist/index.js";

function manifestFor(registry, moduleId, version) {
  const resolution = registry.resolve(moduleId, version);
  return {
    format: "nublox-metaobject-module",
    formatVersion: 1,
    moduleId,
    moduleVersion: version,
    dependencies: resolution.order
      .filter((module) => module !== resolution.root)
      .map((module) => ({ moduleId: module.id, version: module.version })),
    members: resolution.root.members.map((member) => ({ ...member })),
  };
}

test("bundle import rejects published records without a locked manifest before writing anything", async () => {
  const catalog = new MetadataModuleCatalog(new MemoryMetadataModuleStore());
  const definition = defineMetadataModule({
    id: "broken",
    name: "Broken",
    version: 1,
    members: [{ objectTypeId: "example.broken", version: 1 }],
  });
  const bundle = {
    format: "nublox-metaobject-modules",
    formatVersion: 1,
    records: [{
      moduleId: definition.id,
      moduleVersion: definition.version,
      status: "published",
      revision: 1,
      definition,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
  };

  await assert.rejects(() => catalog.importBundle(bundle), /missing a released manifest/);
  assert.equal(await catalog.get(definition.id, definition.version), null);
});

test("bundle import preserves historical locked dependency versions when newer compatible versions exist", async () => {
  const source = new MetadataModuleCatalog(new MemoryMetadataModuleStore());
  const FoundationV1 = defineMetadataModule({
    id: "foundation",
    name: "Foundation",
    version: 1,
    members: [{ objectTypeId: "example.foundation-v1", version: 1 }],
  });
  const FoundationV2 = defineMetadataModule({
    id: "foundation",
    name: "Foundation",
    version: 2,
    members: [{ objectTypeId: "example.foundation-v2", version: 1 }],
  });
  const Assets = defineMetadataModule({
    id: "assets",
    name: "Assets",
    version: 1,
    dependencies: [{ moduleId: "foundation", minimumVersion: 1 }],
    members: [{ objectTypeId: "example.asset", version: 1 }],
  });

  let registry = new MetadataModuleRegistry();
  registry.register(FoundationV1);
  const foundationV1Draft = await source.saveDraft(FoundationV1);
  await source.publish(FoundationV1.id, 1, foundationV1Draft.revision, manifestFor(registry, FoundationV1.id, 1));

  const assetsDraft = await source.saveDraft(Assets);
  registry = await source.createPublishedRegistry();
  registry.register(Assets);
  const assetsManifest = manifestFor(registry, Assets.id, 1);
  assert.equal(assetsManifest.dependencies[0].version, 1);
  await source.publish(Assets.id, 1, assetsDraft.revision, assetsManifest);

  const foundationV2Draft = await source.saveDraft(FoundationV2);
  registry = await source.createPublishedRegistry();
  registry.register(FoundationV2);
  await source.publish(FoundationV2.id, 2, foundationV2Draft.revision, manifestFor(registry, FoundationV2.id, 2));

  const bundle = await source.exportBundle("published");
  const target = new MetadataModuleCatalog(new MemoryMetadataModuleStore());
  await target.importBundle(bundle);

  const importedAssets = await target.get(Assets.id, 1);
  assert.equal(importedAssets.releasedManifest.dependencies[0].version, 1);
  const runtime = await target.createPublishedRegistry();
  assert.equal(runtime.latest("foundation").version, 2);
});

test("bundle import rejects locked dependency versions that are absent", async () => {
  const catalog = new MetadataModuleCatalog(new MemoryMetadataModuleStore());
  const definition = defineMetadataModule({
    id: "dependent",
    name: "Dependent",
    version: 1,
    dependencies: [{ moduleId: "missing", minimumVersion: 1 }],
    members: [{ objectTypeId: "example.dependent", version: 1 }],
  });
  const bundle = {
    format: "nublox-metaobject-modules",
    formatVersion: 1,
    records: [{
      moduleId: definition.id,
      moduleVersion: 1,
      status: "published",
      revision: 1,
      definition,
      releasedManifest: {
        format: "nublox-metaobject-module",
        formatVersion: 1,
        moduleId: definition.id,
        moduleVersion: 1,
        dependencies: [{ moduleId: "missing", version: 1 }],
        members: definition.members,
      },
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
  };

  await assert.rejects(() => catalog.importBundle(bundle), /locks missing dependency 'missing@1'/);
  assert.equal(await catalog.get(definition.id, 1), null);
});
