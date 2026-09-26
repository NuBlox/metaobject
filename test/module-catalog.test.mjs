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

test("module drafts use optimistic revision concurrency", async () => {
  const catalog = new MetadataModuleCatalog(new MemoryMetadataModuleStore(), () => new Date("2026-01-01T00:00:00.000Z"));
  const V1 = defineMetadataModule({
    id: "identity",
    name: "Identity",
    version: 1,
    members: [{ objectTypeId: "example.person", version: 1 }],
  });
  const first = await catalog.saveDraft(V1);
  assert.equal(first.revision, 1);
  const changed = defineMetadataModule({ ...V1, name: "Identity changed" });
  const second = await catalog.saveDraft(changed, first.revision);
  assert.equal(second.revision, 2);
  await assert.rejects(() => catalog.saveDraft(V1, first.revision), /concurrency conflict/i);
});

test("publishes module definitions only when dependency modules and manifest match", async () => {
  const catalog = new MetadataModuleCatalog(new MemoryMetadataModuleStore());
  const Identity = defineMetadataModule({
    id: "identity",
    name: "Identity",
    version: 1,
    members: [{ objectTypeId: "example.person", version: 1 }],
  });
  const Assets = defineMetadataModule({
    id: "assets",
    name: "Assets",
    version: 1,
    dependencies: [{ moduleId: "identity", minimumVersion: 1 }],
    members: [{ objectTypeId: "example.asset", version: 1 }],
  });
  const identityDraft = await catalog.saveDraft(Identity);
  const assetsDraft = await catalog.saveDraft(Assets);

  const identityRegistry = new MetadataModuleRegistry();
  identityRegistry.register(Identity);
  const identityPublished = await catalog.publish(
    Identity.id,
    Identity.version,
    identityDraft.revision,
    manifestFor(identityRegistry, Identity.id, Identity.version),
  );
  assert.equal(identityPublished.status, "published");

  await assert.rejects(() => catalog.publish(
    Assets.id,
    Assets.version,
    assetsDraft.revision,
    { format: "nublox-metaobject-module", formatVersion: 1, moduleId: Assets.id, moduleVersion: 1, dependencies: [], members: Assets.members },
  ), /manifest.*does not match/i);

  const registry = await catalog.createPublishedRegistry();
  registry.register(Assets);
  const assetsPublished = await catalog.publish(
    Assets.id,
    Assets.version,
    assetsDraft.revision,
    manifestFor(registry, Assets.id, Assets.version),
  );
  assert.equal(assetsPublished.status, "published");
  assert.equal(assetsPublished.releasedManifest.dependencies[0].moduleId, Identity.id);
});

test("published registry retains all module versions for range resolution", async () => {
  const catalog = new MetadataModuleCatalog(new MemoryMetadataModuleStore());
  for (const version of [1, 2]) {
    const definition = defineMetadataModule({
      id: "foundation",
      name: "Foundation",
      version,
      members: [{ objectTypeId: `example.foundation-${version}`, version: 1 }],
    });
    const draft = await catalog.saveDraft(definition);
    const registry = await catalog.createPublishedRegistry();
    registry.register(definition);
    await catalog.publish(definition.id, version, draft.revision, manifestFor(registry, definition.id, version));
  }

  const runtime = await catalog.createPublishedRegistry();
  assert.equal(runtime.get("foundation", 1).version, 1);
  assert.equal(runtime.get("foundation", 2).version, 2);
  assert.equal(runtime.resolveDependency({ moduleId: "foundation", maximumVersion: 1 }).version, 1);
  assert.equal(runtime.resolveDependency({ moduleId: "foundation", minimumVersion: 1 }).version, 2);
});

test("deprecation is blocked while another published module resolves that version", async () => {
  const catalog = new MetadataModuleCatalog(new MemoryMetadataModuleStore());
  const Foundation = defineMetadataModule({
    id: "foundation",
    name: "Foundation",
    version: 1,
    members: [{ objectTypeId: "example.foundation", version: 1 }],
  });
  const Assets = defineMetadataModule({
    id: "assets",
    name: "Assets",
    version: 1,
    dependencies: [{ moduleId: "foundation", maximumVersion: 1 }],
    members: [{ objectTypeId: "example.asset", version: 1 }],
  });
  const foundationDraft = await catalog.saveDraft(Foundation);
  let registry = new MetadataModuleRegistry();
  registry.register(Foundation);
  const foundationPublished = await catalog.publish(Foundation.id, 1, foundationDraft.revision, manifestFor(registry, Foundation.id, 1));

  const assetsDraft = await catalog.saveDraft(Assets);
  registry = await catalog.createPublishedRegistry();
  registry.register(Assets);
  await catalog.publish(Assets.id, 1, assetsDraft.revision, manifestFor(registry, Assets.id, 1));

  await assert.rejects(
    () => catalog.deprecate(Foundation.id, 1, foundationPublished.revision),
    /Cannot deprecate.*assets@1/,
  );
});

test("module bundles export and import durable records", async () => {
  const source = new MetadataModuleCatalog(new MemoryMetadataModuleStore());
  const Definition = defineMetadataModule({
    id: "bundle",
    name: "Bundle",
    version: 1,
    members: [{ objectTypeId: "example.bundle", version: 1 }],
  });
  const draft = await source.saveDraft(Definition);
  const registry = new MetadataModuleRegistry();
  registry.register(Definition);
  await source.publish(Definition.id, 1, draft.revision, manifestFor(registry, Definition.id, 1));
  const bundle = await source.exportBundle();

  const target = new MetadataModuleCatalog(new MemoryMetadataModuleStore());
  await target.importBundle(bundle);
  const imported = await target.get(Definition.id, 1);
  assert.equal(imported.status, "published");
  assert.deepEqual(imported.definition, Definition);
  assert.equal(imported.releasedManifest.moduleId, Definition.id);
});

test("new module draft versions must advance beyond published versions", async () => {
  const catalog = new MetadataModuleCatalog(new MemoryMetadataModuleStore());
  const V2 = defineMetadataModule({
    id: "versioned",
    name: "Versioned",
    version: 2,
    members: [{ objectTypeId: "example.v2", version: 1 }],
  });
  const draft = await catalog.saveDraft(V2);
  const registry = new MetadataModuleRegistry();
  registry.register(V2);
  await catalog.publish(V2.id, 2, draft.revision, manifestFor(registry, V2.id, 2));

  await assert.rejects(() => catalog.saveDraft(defineMetadataModule({
    id: "versioned",
    name: "Versioned",
    version: 1,
    members: [{ objectTypeId: "example.v1", version: 1 }],
  })), /must be greater than published version 2/);
});
