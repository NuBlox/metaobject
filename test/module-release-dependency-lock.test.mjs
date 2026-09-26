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

test("dependency deprecation is blocked by a releasing module's locked manifest", async () => {
  const catalog = new MetadataModuleCatalog(new MemoryMetadataModuleStore());
  const Foundation = defineMetadataModule({
    id: "foundation-lock",
    name: "Foundation Lock",
    version: 1,
    members: [{ objectTypeId: "lock.foundation", version: 1 }],
  });
  const Feature = defineMetadataModule({
    id: "feature-lock",
    name: "Feature Lock",
    version: 1,
    dependencies: [{ moduleId: Foundation.id, minimumVersion: 1, maximumVersion: 1 }],
    members: [{ objectTypeId: "lock.feature", version: 1 }],
  });

  const foundationDraft = await catalog.saveDraft(Foundation);
  let registry = new MetadataModuleRegistry();
  registry.register(Foundation);
  const foundationPublished = await catalog.publish(
    Foundation.id,
    1,
    foundationDraft.revision,
    manifestFor(registry, Foundation.id, 1),
  );

  const featureDraft = await catalog.saveDraft(Feature);
  registry = await catalog.createPublishedRegistry();
  registry.register(Feature);
  const locked = await catalog.beginRelease(
    Feature.id,
    1,
    featureDraft.revision,
    manifestFor(registry, Feature.id, 1),
  );
  assert.equal(locked.status, "releasing");

  await assert.rejects(
    () => catalog.deprecate(Foundation.id, 1, foundationPublished.revision),
    /releasing module 'feature-lock@1' locks it as a dependency/,
  );
});
