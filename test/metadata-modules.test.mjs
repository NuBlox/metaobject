import assert from "node:assert/strict";
import test from "node:test";
import {
  MemoryMetadataStore,
  MetadataCatalog,
  MetadataModuleRegistry,
  MetadataModuleReleaseManager,
  MetadataReleaseManager,
  createDefaultTypeRegistry,
  defineMetadataModule,
  defineObjectType,
} from "../dist/index.js";

function setup() {
  const types = createDefaultTypeRegistry();
  const catalog = new MetadataCatalog(new MemoryMetadataStore(), types);
  const releases = new MetadataReleaseManager(catalog);
  const modules = new MetadataModuleRegistry();
  const moduleReleases = new MetadataModuleReleaseManager(modules, catalog, releases);
  return { catalog, releases, modules, moduleReleases };
}

test("module registry resolves highest compatible dependency versions in dependency-first order", () => {
  const modules = new MetadataModuleRegistry();
  modules.register(defineMetadataModule({
    id: "identity",
    name: "Identity",
    version: 1,
    members: [{ objectTypeId: "example.person", version: 1 }],
  }));
  modules.register(defineMetadataModule({
    id: "identity",
    name: "Identity",
    version: 2,
    members: [{ objectTypeId: "example.person", version: 2 }],
  }));
  modules.register(defineMetadataModule({
    id: "assets",
    name: "Assets",
    version: 1,
    dependencies: [{ moduleId: "identity", minimumVersion: 1, maximumVersion: 2 }],
    members: [{ objectTypeId: "example.asset", version: 1 }],
  }));

  const resolved = modules.resolve("assets", 1);
  assert.deepEqual(resolved.order.map((module) => `${module.id}@${module.version}`), ["identity@2", "assets@1"]);
});

test("module registry rejects invalid definitions and dependency cycles", () => {
  const modules = new MetadataModuleRegistry();
  assert.throws(() => modules.register(defineMetadataModule({
    id: "empty",
    name: "Empty",
    version: 1,
    members: [],
  })), /at least one object type/);

  modules.register(defineMetadataModule({
    id: "a",
    name: "A",
    version: 1,
    dependencies: [{ moduleId: "b", minimumVersion: 1 }],
    members: [{ objectTypeId: "example.a", version: 1 }],
  }));
  modules.register(defineMetadataModule({
    id: "b",
    name: "B",
    version: 1,
    dependencies: [{ moduleId: "a", minimumVersion: 1 }],
    members: [{ objectTypeId: "example.b", version: 1 }],
  }));
  assert.throws(() => modules.resolve("a", 1), /dependency cycle/);
});

test("module release requires dependency module members to be published", async () => {
  const { catalog, modules, moduleReleases } = setup();
  const Person = defineObjectType({
    id: "example.person",
    name: "Person",
    version: 1,
    attributes: { name: { type: "string", required: true } },
  });
  const Asset = defineObjectType({
    id: "example.asset",
    name: "Asset",
    version: 1,
    attributes: { code: { type: "string", required: true } },
    relationships: { owner: { target: Person.id, cardinality: "many-to-one" } },
  });
  await catalog.saveDraft(Person);
  await catalog.saveDraft(Asset);

  modules.register(defineMetadataModule({
    id: "identity",
    name: "Identity",
    version: 1,
    members: [{ objectTypeId: Person.id, version: 1 }],
  }));
  modules.register(defineMetadataModule({
    id: "assets",
    name: "Assets",
    version: 1,
    dependencies: [{ moduleId: "identity", minimumVersion: 1 }],
    members: [{ objectTypeId: Asset.id, version: 1 }],
  }));

  await assert.rejects(() => moduleReleases.prepare("assets", 1), /not published/);
  await moduleReleases.release("identity", 1, { artifactGenerators: ["json-schema"] });
  const prepared = await moduleReleases.prepare("assets", 1, ["json-schema"]);
  assert.equal(prepared.manifest.dependencies[0].moduleId, "identity");
  assert.equal(prepared.manifest.dependencies[0].version, 1);
  assert.equal(prepared.release.artifacts.length, 1);

  const result = await moduleReleases.release("assets", 1, { artifactGenerators: ["json-schema"] });
  assert.equal(result.release.published[0].status, "published");
});

test("module release rejects undeclared cross-module object dependencies", async () => {
  const { catalog, modules, moduleReleases } = setup();
  const Person = defineObjectType({
    id: "example.external-person",
    name: "External Person",
    version: 1,
    attributes: {},
  });
  const Asset = defineObjectType({
    id: "example.bad-asset",
    name: "Bad Asset",
    version: 1,
    attributes: {},
    relationships: { owner: { target: Person.id, cardinality: "many-to-one" } },
  });
  await catalog.saveDraft(Person);
  await catalog.saveDraft(Asset);

  modules.register(defineMetadataModule({
    id: "identity",
    name: "Identity",
    version: 1,
    members: [{ objectTypeId: Person.id, version: 1 }],
  }));
  await moduleReleases.release("identity", 1);
  modules.register(defineMetadataModule({
    id: "assets",
    name: "Assets",
    version: 1,
    members: [{ objectTypeId: Asset.id, version: 1 }],
  }));

  await assert.rejects(() => moduleReleases.prepare("assets", 1), /no module.*owns/i);
});

test("a module can release mutually dependent object types as one graph", async () => {
  const { catalog, modules, moduleReleases } = setup();
  const Team = defineObjectType({
    id: "example.module-team",
    name: "Team",
    version: 1,
    attributes: {},
    relationships: { members: { target: "example.module-person", cardinality: "one-to-many", inverse: "team" } },
  });
  const Person = defineObjectType({
    id: "example.module-person",
    name: "Person",
    version: 1,
    attributes: {},
    relationships: { team: { target: Team.id, cardinality: "many-to-one", inverse: "members" } },
  });
  await catalog.saveDraft(Team);
  await catalog.saveDraft(Person);
  modules.register(defineMetadataModule({
    id: "workforce",
    name: "Workforce",
    version: 1,
    members: [
      { objectTypeId: Team.id, version: 1 },
      { objectTypeId: Person.id, version: 1 },
    ],
  }));

  const result = await moduleReleases.release("workforce", 1, { artifactGenerators: ["metadata-snapshot"] });
  assert.equal(result.release.published.length, 2);
  assert.deepEqual(result.manifest.members.map((member) => member.objectTypeId), [Team.id, Person.id]);
  const runtime = await catalog.createPublishedRegistry();
  runtime.validateRelationships();
});

test("resolved module graph rejects duplicate object type ownership", async () => {
  const { catalog, modules, moduleReleases } = setup();
  const Shared = defineObjectType({ id: "example.shared", name: "Shared", version: 1, attributes: {} });
  const Root = defineObjectType({ id: "example.root", name: "Root", version: 1, attributes: {} });
  await catalog.saveDraft(Shared);
  await catalog.saveDraft(Root);
  modules.register(defineMetadataModule({
    id: "foundation",
    name: "Foundation",
    version: 1,
    members: [{ objectTypeId: Shared.id, version: 1 }],
  }));
  await moduleReleases.release("foundation", 1);
  modules.register(defineMetadataModule({
    id: "root",
    name: "Root",
    version: 1,
    dependencies: [{ moduleId: "foundation", minimumVersion: 1 }],
    members: [
      { objectTypeId: Shared.id, version: 1 },
      { objectTypeId: Root.id, version: 1 },
    ],
  }));

  await assert.rejects(() => moduleReleases.prepare("root", 1), /owned by multiple modules/);
});
