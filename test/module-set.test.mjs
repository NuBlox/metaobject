import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryMetadataModuleStore,
  MemoryMetadataStore,
  MetadataCatalog,
  MetadataModuleCatalog,
  MetadataModuleSetResolver,
  createDefaultTypeRegistry,
  defineMetadataModule,
  defineObjectType,
} from "../dist/index.js";

function moduleManifest(registry, definition) {
  const resolution = registry.resolve(definition.id, definition.version);
  return {
    format: "nublox-metaobject-module",
    formatVersion: 1,
    moduleId: definition.id,
    moduleVersion: definition.version,
    dependencies: resolution.order
      .filter((module) => module !== resolution.root)
      .map((module) => ({ moduleId: module.id, version: module.version })),
    members: definition.members.map((member) => ({ ...member })),
  };
}

function setup() {
  const types = createDefaultTypeRegistry();
  const metadata = new MetadataCatalog(new MemoryMetadataStore(), types);
  const modules = new MetadataModuleCatalog(new MemoryMetadataModuleStore());
  const sets = new MetadataModuleSetResolver(modules, metadata, types);
  return { types, metadata, modules, sets };
}

async function publishMetadata(catalog, definition) {
  const draft = await catalog.saveDraft(definition);
  return catalog.publish(definition.id, definition.version, draft.revision);
}

async function publishModule(catalog, definition) {
  const draft = await catalog.saveDraft(definition);
  const registry = await catalog.createPublishedRegistry();
  registry.register(definition);
  return catalog.publish(
    definition.id,
    definition.version,
    draft.revision,
    moduleManifest(registry, definition),
  );
}

test("module-set resolution follows historical locked dependencies instead of newer compatible versions", async () => {
  const { metadata, modules, sets } = setup();
  const FoundationV1 = defineObjectType({
    id: "set.foundation",
    name: "Foundation",
    version: 1,
    attributes: { code: { type: "string" } },
  });
  const FoundationV2 = defineObjectType({
    id: "set.foundation",
    name: "Foundation",
    version: 2,
    attributes: { code: { type: "string" }, label: { type: "string" } },
  });
  const Asset = defineObjectType({
    id: "set.asset",
    name: "Asset",
    version: 1,
    attributes: { assetCode: { type: "string" } },
    relationships: { foundation: { target: FoundationV1.id, cardinality: "many-to-one" } },
  });

  await publishMetadata(metadata, FoundationV1);
  await publishMetadata(metadata, Asset);
  const FoundationModuleV1 = defineMetadataModule({
    id: "foundation",
    name: "Foundation",
    version: 1,
    members: [{ objectTypeId: FoundationV1.id, version: 1 }],
  });
  await publishModule(modules, FoundationModuleV1);

  const AssetsModule = defineMetadataModule({
    id: "assets",
    name: "Assets",
    version: 1,
    dependencies: [{ moduleId: "foundation", minimumVersion: 1 }],
    members: [{ objectTypeId: Asset.id, version: 1 }],
  });
  const publishedAssets = await publishModule(modules, AssetsModule);
  assert.equal(publishedAssets.releasedManifest.dependencies[0].version, 1);

  await publishMetadata(metadata, FoundationV2);
  const FoundationModuleV2 = defineMetadataModule({
    id: "foundation",
    name: "Foundation",
    version: 2,
    members: [{ objectTypeId: FoundationV2.id, version: 2 }],
  });
  await publishModule(modules, FoundationModuleV2);

  const lockfile = await sets.resolve([{ moduleId: "assets", minimumVersion: 1 }]);
  assert.deepEqual(lockfile.roots, [{ moduleId: "assets", version: 1 }]);
  assert.deepEqual(
    lockfile.modules.map((module) => `${module.moduleId}@${module.version}`),
    ["foundation@1", "assets@1"],
  );

  const runtime = await sets.buildObjectTypeRegistry(lockfile);
  assert.equal(runtime.resolve(FoundationV1.id).version, 1);
  assert.equal(runtime.resolve(Asset.id).version, 1);
});

test("multiple roots reject conflicting exact dependency locks", async () => {
  const { metadata, modules, sets } = setup();
  const FoundationV1 = defineObjectType({ id: "set.conflict.foundation", name: "Foundation", version: 1, attributes: {} });
  const FoundationV2 = defineObjectType({ id: FoundationV1.id, name: "Foundation", version: 2, attributes: { next: { type: "string" } } });
  const AType = defineObjectType({ id: "set.a", name: "A", version: 1, attributes: {} });
  const BType = defineObjectType({ id: "set.b", name: "B", version: 1, attributes: {} });
  await publishMetadata(metadata, FoundationV1);
  await publishMetadata(metadata, AType);
  await publishMetadata(metadata, BType);

  await publishModule(modules, defineMetadataModule({
    id: "foundation",
    name: "Foundation",
    version: 1,
    members: [{ objectTypeId: FoundationV1.id, version: 1 }],
  }));
  await publishModule(modules, defineMetadataModule({
    id: "app-a",
    name: "App A",
    version: 1,
    dependencies: [{ moduleId: "foundation", minimumVersion: 1, maximumVersion: 1 }],
    members: [{ objectTypeId: AType.id, version: 1 }],
  }));

  await publishMetadata(metadata, FoundationV2);
  await publishModule(modules, defineMetadataModule({
    id: "foundation",
    name: "Foundation",
    version: 2,
    members: [{ objectTypeId: FoundationV2.id, version: 2 }],
  }));
  await publishModule(modules, defineMetadataModule({
    id: "app-b",
    name: "App B",
    version: 1,
    dependencies: [{ moduleId: "foundation", minimumVersion: 2 }],
    members: [{ objectTypeId: BType.id, version: 1 }],
  }));

  await assert.rejects(
    () => sets.resolve([{ moduleId: "app-a" }, { moduleId: "app-b" }]),
    /version conflict.*foundation/i,
  );
});

test("lockfile validation rejects altered dependency locks", async () => {
  const { metadata, modules, sets } = setup();
  const Foundation = defineObjectType({ id: "set.tamper.foundation", name: "Foundation", version: 1, attributes: {} });
  const App = defineObjectType({ id: "set.tamper.app", name: "App", version: 1, attributes: {} });
  await publishMetadata(metadata, Foundation);
  await publishMetadata(metadata, App);
  await publishModule(modules, defineMetadataModule({
    id: "tamper-foundation",
    name: "Foundation",
    version: 1,
    members: [{ objectTypeId: Foundation.id, version: 1 }],
  }));
  await publishModule(modules, defineMetadataModule({
    id: "tamper-app",
    name: "App",
    version: 1,
    dependencies: [{ moduleId: "tamper-foundation", minimumVersion: 1 }],
    members: [{ objectTypeId: App.id, version: 1 }],
  }));

  const lockfile = await sets.resolve([{ moduleId: "tamper-app" }]);
  const tampered = structuredClone(lockfile);
  const appLock = tampered.modules.find((entry) => entry.moduleId === "tamper-app");
  appLock.dependencies[0].version = 99;

  await assert.rejects(() => sets.validate(tampered), /altered dependencies/);
});

test("lockfile validation rejects unreachable extra modules", async () => {
  const { metadata, modules, sets } = setup();
  const RootType = defineObjectType({ id: "set.root", name: "Root", version: 1, attributes: {} });
  const ExtraType = defineObjectType({ id: "set.extra", name: "Extra", version: 1, attributes: {} });
  await publishMetadata(metadata, RootType);
  await publishMetadata(metadata, ExtraType);
  await publishModule(modules, defineMetadataModule({
    id: "root",
    name: "Root",
    version: 1,
    members: [{ objectTypeId: RootType.id, version: 1 }],
  }));
  await publishModule(modules, defineMetadataModule({
    id: "extra",
    name: "Extra",
    version: 1,
    members: [{ objectTypeId: ExtraType.id, version: 1 }],
  }));

  const rootLock = await sets.resolve([{ moduleId: "root" }]);
  const extraLock = await sets.resolve([{ moduleId: "extra" }]);
  const invalid = {
    ...rootLock,
    modules: [...rootLock.modules, ...extraLock.modules],
  };
  await assert.rejects(() => sets.validate(invalid), /unreachable module/);
});
