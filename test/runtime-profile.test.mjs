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
  return { metadata, modules, profiles };
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

async function seedWorkforce(metadata, modules) {
  const Person = defineObjectType({
    id: "profile.person",
    name: "Person",
    version: 1,
    attributes: { name: { type: "string", required: true } },
  });
  await publishMetadata(metadata, Person);
  const Workforce = defineMetadataModule({
    id: "workforce",
    name: "Workforce",
    version: 1,
    members: [{ objectTypeId: Person.id, version: 1 }],
  });
  await publishModule(modules, Workforce);
  return { Person, Workforce };
}

test("runtime profile drafts use optimistic revisions and activated versions become immutable", async () => {
  const { metadata, modules, profiles } = setup();
  await seedWorkforce(metadata, modules);
  const Profile = defineRuntimeProfile({
    id: "production",
    name: "Production",
    version: 1,
    requirements: [{ moduleId: "workforce", minimumVersion: 1 }],
  });

  const first = await profiles.saveDraft(Profile);
  assert.equal(first.revision, 1);
  const changed = defineRuntimeProfile({ ...Profile, name: "Production Runtime" });
  const second = await profiles.saveDraft(changed, first.revision);
  assert.equal(second.revision, 2);
  await assert.rejects(() => profiles.saveDraft(Profile, first.revision), /concurrency conflict/i);

  const active = await profiles.activate(Profile.id, 1, second.revision);
  assert.equal(active.status, "active");
  assert.equal(active.lockfile.roots[0].moduleId, "workforce");
  await assert.rejects(() => profiles.saveDraft(changed, active.revision), /active.*cannot be edited/i);
});

test("active runtime profile retains its exact module lock after newer compatible modules are published", async () => {
  const { metadata, modules, profiles } = setup();
  const { Person } = await seedWorkforce(metadata, modules);
  const Profile = defineRuntimeProfile({
    id: "stable",
    name: "Stable",
    version: 1,
    requirements: [{ moduleId: "workforce", minimumVersion: 1 }],
  });
  const draft = await profiles.saveDraft(Profile);
  const active = await profiles.activate(Profile.id, 1, draft.revision);
  assert.equal(active.lockfile.roots[0].version, 1);

  const PersonV2 = defineObjectType({
    id: Person.id,
    name: Person.name,
    version: 2,
    attributes: { ...Person.attributes, email: { type: "string" } },
  });
  await publishMetadata(metadata, PersonV2);
  await publishModule(modules, defineMetadataModule({
    id: "workforce",
    name: "Workforce",
    version: 2,
    members: [{ objectTypeId: PersonV2.id, version: 2 }],
  }));

  const stored = await profiles.get(Profile.id, 1);
  assert.equal(stored.lockfile.roots[0].version, 1);
  const runtime = await profiles.buildObjectTypeRegistry(Profile.id, 1);
  assert.equal(runtime.resolve(Person.id).version, 1);
  assert.equal(runtime.resolve(Person.id).attributes.email, undefined);
});

test("new runtime profile versions advance and can adopt newer module versions", async () => {
  const { metadata, modules, profiles } = setup();
  const { Person } = await seedWorkforce(metadata, modules);
  const V1 = defineRuntimeProfile({
    id: "rolling",
    name: "Rolling",
    version: 1,
    requirements: [{ moduleId: "workforce", minimumVersion: 1 }],
  });
  let draft = await profiles.saveDraft(V1);
  await profiles.activate(V1.id, 1, draft.revision);

  const PersonV2 = defineObjectType({ id: Person.id, name: Person.name, version: 2, attributes: { email: { type: "string" } } });
  await publishMetadata(metadata, PersonV2);
  await publishModule(modules, defineMetadataModule({
    id: "workforce",
    name: "Workforce",
    version: 2,
    members: [{ objectTypeId: PersonV2.id, version: 2 }],
  }));

  const V3 = defineRuntimeProfile({
    ...V1,
    version: 3,
    requirements: [{ moduleId: "workforce", minimumVersion: 2 }],
  });
  draft = await profiles.saveDraft(V3);
  const activeV3 = await profiles.activate(V3.id, 3, draft.revision);
  assert.equal(activeV3.lockfile.roots[0].version, 2);
  assert.equal((await profiles.latest(V1.id, "active")).profileVersion, 3);

  const skippedV2 = defineRuntimeProfile({
    ...V1,
    version: 2,
    requirements: [{ moduleId: "workforce", minimumVersion: 2 }],
  });
  await assert.rejects(() => profiles.saveDraft(skippedV2), /greater than active version 3/);
});

test("runtime profile bundles validate activated lockfiles before import writes", async () => {
  const { metadata, modules, profiles } = setup();
  await seedWorkforce(metadata, modules);
  const Profile = defineRuntimeProfile({
    id: "bundle-profile",
    name: "Bundle Profile",
    version: 1,
    requirements: [{ moduleId: "workforce", minimumVersion: 1 }],
  });
  const draft = await profiles.saveDraft(Profile);
  await profiles.activate(Profile.id, 1, draft.revision);
  const bundle = await profiles.exportBundle();

  const types = createDefaultTypeRegistry();
  const targetMetadata = metadata;
  const targetModules = modules;
  const targetSets = new MetadataModuleSetResolver(targetModules, targetMetadata, types);
  const target = new RuntimeProfileCatalog(new MemoryRuntimeProfileStore(), targetSets);
  await target.importBundle(bundle);
  assert.equal((await target.get(Profile.id, 1)).status, "active");

  const invalid = structuredClone(bundle);
  invalid.records[0].lockfile.modules[0].version = 99;
  const rejectedTarget = new RuntimeProfileCatalog(new MemoryRuntimeProfileStore(), targetSets);
  await assert.rejects(() => rejectedTarget.importBundle(invalid), /not published|altered/i);
  assert.equal(await rejectedTarget.get(Profile.id, 1), null);
});

test("deprecated profiles remain reproducible while drafts cannot build a runtime registry", async () => {
  const { metadata, modules, profiles } = setup();
  const { Person } = await seedWorkforce(metadata, modules);
  const Profile = defineRuntimeProfile({
    id: "historical",
    name: "Historical",
    version: 1,
    requirements: [{ moduleId: "workforce" }],
  });
  const draft = await profiles.saveDraft(Profile);
  await assert.rejects(() => profiles.buildObjectTypeRegistry(Profile.id, 1), /not activated/);
  const active = await profiles.activate(Profile.id, 1, draft.revision);
  const deprecated = await profiles.deprecate(Profile.id, 1, active.revision);
  assert.equal(deprecated.status, "deprecated");
  const registry = await profiles.buildObjectTypeRegistry(Profile.id, 1);
  assert.equal(registry.resolve(Person.id).version, 1);
});
