import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryMetadataModuleStore,
  MemoryMetadataStore,
  MemoryRuntimeProfileStore,
  MetadataCatalog,
  MetadataModuleCatalog,
  MetadataModuleSetResolver,
  RuntimeProfileCatalog,
  RuntimeProfileUpgradePlanner,
  createDefaultTypeRegistry,
  defineMetadataModule,
  defineObjectType,
  defineRuntimeProfile,
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
  const moduleSets = new MetadataModuleSetResolver(modules, metadata, types);
  const profiles = new RuntimeProfileCatalog(new MemoryRuntimeProfileStore(), moduleSets);
  const upgrades = new RuntimeProfileUpgradePlanner(profiles, metadata);
  return { metadata, modules, profiles, upgrades };
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

async function activateProfile(profiles, definition) {
  const draft = await profiles.saveDraft(definition);
  return profiles.activate(definition.id, definition.version, draft.revision);
}

test("upgrade plan follows target module dependency order and emits semantic object migrations", async () => {
  const { metadata, modules, profiles, upgrades } = setup();

  const FoundationV1 = defineObjectType({
    id: "upgrade.foundation",
    name: "Foundation",
    version: 1,
    attributes: { code: { type: "string", required: true } },
  });
  const AssetV1 = defineObjectType({
    id: "upgrade.asset",
    name: "Asset",
    version: 1,
    attributes: { name: { type: "string", required: true } },
    relationships: { foundation: { target: FoundationV1.id, cardinality: "many-to-one" } },
  });
  await publishMetadata(metadata, FoundationV1);
  await publishMetadata(metadata, AssetV1);
  await publishModule(modules, defineMetadataModule({
    id: "foundation",
    name: "Foundation",
    version: 1,
    members: [{ objectTypeId: FoundationV1.id, version: 1 }],
  }));
  await publishModule(modules, defineMetadataModule({
    id: "assets",
    name: "Assets",
    version: 1,
    dependencies: [{ moduleId: "foundation", minimumVersion: 1, maximumVersion: 1 }],
    members: [{ objectTypeId: AssetV1.id, version: 1 }],
  }));
  await activateProfile(profiles, defineRuntimeProfile({
    id: "production",
    name: "Production",
    version: 1,
    requirements: [{ moduleId: "assets", minimumVersion: 1, maximumVersion: 1 }],
  }));

  const FoundationV2 = defineObjectType({
    ...FoundationV1,
    version: 2,
    attributes: { ...FoundationV1.attributes, label: { type: "string" } },
  });
  const AssetV2 = defineObjectType({
    ...AssetV1,
    version: 2,
    attributes: { ...AssetV1.attributes, note: { type: "string" } },
  });
  await publishMetadata(metadata, FoundationV2);
  await publishMetadata(metadata, AssetV2);
  await publishModule(modules, defineMetadataModule({
    id: "foundation",
    name: "Foundation",
    version: 2,
    members: [{ objectTypeId: FoundationV2.id, version: 2 }],
  }));
  await publishModule(modules, defineMetadataModule({
    id: "assets",
    name: "Assets",
    version: 2,
    dependencies: [{ moduleId: "foundation", minimumVersion: 2, maximumVersion: 2 }],
    members: [{ objectTypeId: AssetV2.id, version: 2 }],
  }));
  await activateProfile(profiles, defineRuntimeProfile({
    id: "production",
    name: "Production",
    version: 2,
    requirements: [{ moduleId: "assets", minimumVersion: 2, maximumVersion: 2 }],
  }));

  const plan = await upgrades.plan("production", 1, 2);
  assert.equal(plan.impact, "compatible");
  assert.equal(plan.requiresManualReview, false);
  assert.equal(plan.blockingStepCount, 0);
  assert.deepEqual(
    plan.moduleChanges.map((change) => `${change.moduleId}:${change.kind}`),
    ["foundation:upgraded", "assets:upgraded"],
  );
  assert.deepEqual(
    plan.steps.map((step) => `${step.kind}:${step.objectTypeId ?? step.moduleId}`),
    [
      "upgrade-module:foundation",
      "migrate-object-type:upgrade.foundation",
      "upgrade-module:assets",
      "migrate-object-type:upgrade.asset",
    ],
  );
  assert.equal(plan.objectChanges[0].diff.impact, "compatible");
  assert.equal(plan.objectChanges[0].migrationPlan.steps[0].kind, "apply-metadata");
});

test("upgrade plan exposes blocking data migrations", async () => {
  const { metadata, modules, profiles, upgrades } = setup();
  const V1 = defineObjectType({
    id: "upgrade.migrating",
    name: "Migrating",
    version: 1,
    attributes: { name: { type: "string", required: true } },
  });
  await publishMetadata(metadata, V1);
  await publishModule(modules, defineMetadataModule({
    id: "migrating",
    name: "Migrating",
    version: 1,
    members: [{ objectTypeId: V1.id, version: 1 }],
  }));
  await activateProfile(profiles, defineRuntimeProfile({
    id: "migration-profile",
    name: "Migration Profile",
    version: 1,
    requirements: [{ moduleId: "migrating", maximumVersion: 1 }],
  }));

  const V2 = defineObjectType({
    ...V1,
    version: 2,
    attributes: {
      ...V1.attributes,
      status: { type: "string", required: true, default: "active" },
    },
  });
  await publishMetadata(metadata, V2);
  await publishModule(modules, defineMetadataModule({
    id: "migrating",
    name: "Migrating",
    version: 2,
    members: [{ objectTypeId: V2.id, version: 2 }],
  }));
  await activateProfile(profiles, defineRuntimeProfile({
    id: "migration-profile",
    name: "Migration Profile",
    version: 2,
    requirements: [{ moduleId: "migrating", minimumVersion: 2 }],
  }));

  const plan = await upgrades.plan("migration-profile", 1, 2);
  assert.equal(plan.impact, "requires-migration");
  assert.equal(plan.requiresManualReview, false);
  assert.equal(plan.blockingStepCount, 1);
  const migration = plan.steps.find((step) => step.kind === "migrate-object-type");
  assert.equal(migration.blocking, true);
  assert.equal(migration.migrationPlan.steps[0].kind, "backfill-existing-data");
});

test("breaking schema changes and capability removals require explicit review", async () => {
  const { metadata, modules, profiles, upgrades } = setup();
  const CoreV1 = defineObjectType({
    id: "upgrade.core",
    name: "Core",
    version: 1,
    attributes: { keep: { type: "string" }, removeMe: { type: "string" } },
  });
  const Legacy = defineObjectType({
    id: "upgrade.legacy",
    name: "Legacy",
    version: 1,
    attributes: { code: { type: "string" } },
  });
  await publishMetadata(metadata, CoreV1);
  await publishMetadata(metadata, Legacy);
  await publishModule(modules, defineMetadataModule({
    id: "core",
    name: "Core",
    version: 1,
    members: [{ objectTypeId: CoreV1.id, version: 1 }],
  }));
  await publishModule(modules, defineMetadataModule({
    id: "legacy",
    name: "Legacy",
    version: 1,
    members: [{ objectTypeId: Legacy.id, version: 1 }],
  }));
  await activateProfile(profiles, defineRuntimeProfile({
    id: "breaking-profile",
    name: "Breaking Profile",
    version: 1,
    requirements: [{ moduleId: "core", maximumVersion: 1 }, { moduleId: "legacy" }],
  }));

  const CoreV2 = defineObjectType({
    id: CoreV1.id,
    name: CoreV1.name,
    version: 2,
    attributes: { keep: { type: "string" } },
  });
  await publishMetadata(metadata, CoreV2);
  await publishModule(modules, defineMetadataModule({
    id: "core",
    name: "Core",
    version: 2,
    members: [{ objectTypeId: CoreV2.id, version: 2 }],
  }));
  await activateProfile(profiles, defineRuntimeProfile({
    id: "breaking-profile",
    name: "Breaking Profile",
    version: 2,
    requirements: [{ moduleId: "core", minimumVersion: 2 }],
  }));

  const plan = await upgrades.plan("breaking-profile", 1, 2);
  assert.equal(plan.impact, "breaking");
  assert.equal(plan.requiresManualReview, true);
  assert.ok(plan.blockingStepCount >= 3);
  const kinds = plan.steps.map((step) => step.kind);
  assert.ok(kinds.includes("migrate-object-type"));
  assert.ok(kinds.includes("remove-object-type"));
  assert.equal(kinds.at(-1), "remove-module");
  assert.equal(plan.objectChanges.find((change) => change.objectTypeId === CoreV1.id).diff.impact, "breaking");
});

test("upgrade planning rejects drafts and non-forward profile versions", async () => {
  const { metadata, modules, profiles, upgrades } = setup();
  const Type = defineObjectType({ id: "upgrade.guard", name: "Guard", version: 1, attributes: {} });
  await publishMetadata(metadata, Type);
  await publishModule(modules, defineMetadataModule({
    id: "guard",
    name: "Guard",
    version: 1,
    members: [{ objectTypeId: Type.id, version: 1 }],
  }));
  await activateProfile(profiles, defineRuntimeProfile({
    id: "guard-profile",
    name: "Guard Profile",
    version: 1,
    requirements: [{ moduleId: "guard" }],
  }));
  await profiles.saveDraft(defineRuntimeProfile({
    id: "guard-profile",
    name: "Guard Profile",
    version: 2,
    requirements: [{ moduleId: "guard" }],
  }));

  await assert.rejects(() => upgrades.plan("guard-profile", 1, 2), /must be active or deprecated/);
  await assert.rejects(() => upgrades.plan("guard-profile", 1, 1), /greater than source version/);
});
