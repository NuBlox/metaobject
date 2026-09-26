# Metadata modules

M10 groups exact object-type versions into versioned metadata modules. A module is the deployment and ownership boundary above individual object types: it says which schemas belong together, which other modules they require, and which exact metadata graph is released as one unit.

## Module definition

```ts
const identity = defineMetadataModule({
  id: "identity",
  name: "Identity",
  version: 2,
  members: [
    { objectTypeId: "nublox.person", version: 4 },
    { objectTypeId: "nublox.organisation", version: 3 },
  ],
});

const assets = defineMetadataModule({
  id: "assets",
  name: "Assets",
  version: 1,
  dependencies: [
    { moduleId: "identity", minimumVersion: 2, maximumVersion: 3 },
  ],
  members: [
    { objectTypeId: "nublox.asset", version: 5 },
  ],
});
```

Module versions are positive integers. Members always identify an exact object-type version; dependencies can specify a minimum version, maximum version, both, or neither.

## Dependency resolution

`MetadataModuleRegistry` resolves the highest registered dependency version that satisfies each range and returns dependency-first order:

```ts
modules.register(identity);
modules.register(assets);

const resolution = modules.resolve("assets", 1);
```

The registry rejects:

- empty modules
- duplicate object-type ids within a module
- duplicate dependency ids
- self-dependencies
- invalid version ranges
- missing compatible dependency versions
- dependency cycles
- dependency graphs that resolve two different versions of the same module

The last rule prevents ambiguous diamond graphs. One resolved module graph has exactly one selected version for each module id.

## Object-type ownership

Within a resolved module graph, one object type can have only one owning module.

For each object type in the root module, M10 checks dependencies created by:

- `baseType`
- relationship targets

Every referenced object type must be owned by the root module or a module in its resolved dependency closure. This makes module dependencies explicit instead of allowing hidden coupling to arbitrary globally published metadata.

## Dependency publication gate

Before releasing a module, every member of every dependency module must already be published at the exact version selected by dependency resolution.

```ts
await moduleReleases.release("identity", 2);
await moduleReleases.release("assets", 1);
```

Attempting to release `assets` first is rejected.

## Module-wide release

`MetadataModuleReleaseManager` delegates the root module's members to the M9 batch release pipeline:

```ts
const moduleReleases = new MetadataModuleReleaseManager(
  modules,
  catalog,
  metadataReleases,
);

const result = await moduleReleases.release("workforce", 1, {
  migrationExecutor,
  artifactGenerators: ["typescript", "json-schema"],
});
```

All M9 guarantees still apply:

- semantic diff and migration planning for each evolving object type
- explicit approval for breaking changes
- blocking migration execution
- optimistic draft-revision locking
- mutually dependent object-type publication through `publishMany()`
- reproducible generated artifacts

A single module may therefore contain bidirectionally related schemas that cannot be published independently.

## Module manifest

Every preparation/release produces a deterministic portable manifest:

```json
{
  "format": "nublox-metaobject-module",
  "formatVersion": 1,
  "moduleId": "assets",
  "moduleVersion": 1,
  "dependencies": [
    { "moduleId": "identity", "version": 2 }
  ],
  "members": [
    { "objectTypeId": "nublox.asset", "version": 5 }
  ]
}
```

The manifest records the versions actually selected by dependency resolution rather than only the declared ranges.

## Intended NuBlox usage

Metadata modules provide a clean layer for large enterprise capability sets:

```text
foundation
   │
   ├── identity
   │      │
   │      ├── organisation
   │      └── workforce
   │
   ├── finance
   ├── commercial
   ├── supply-chain
   ├── engineering
   └── project-controls
```

Each module can own many related object types while still depending on stable shared foundations. This allows the overall NuBlox metamodel to grow into independently versioned capability areas without losing explicit dependency control.
