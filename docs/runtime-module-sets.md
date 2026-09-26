# Runtime module sets and lockfiles

M13 turns published metadata modules into an exact runtime schema selection.

Publishing a module does not by itself answer a deployment question such as:

> Which exact versions of Workforce, Assets and their dependencies should this runtime use?

`MetadataModuleSetResolver` answers that question and produces a portable lockfile containing the exact published module closure and exact object-type members.

## Resolve a module set

```ts
const resolver = new MetadataModuleSetResolver(
  moduleCatalog,
  metadataCatalog,
  typeRegistry,
);

const lockfile = await resolver.resolve([
  { moduleId: "workforce", minimumVersion: 2 },
  { moduleId: "assets", minimumVersion: 3, maximumVersion: 5 },
]);
```

Root version ranges are resolved against published module versions. Once a root version is selected, all transitive dependencies follow that module's persisted `releasedManifest` exactly.

This is intentionally different from re-resolving dependency ranges at runtime.

If `assets@1` was released against `foundation@1`, publishing a newer compatible `foundation@2` later does not silently change the meaning of `assets@1`. The runtime lockfile continues to contain `foundation@1`.

## Lockfile format

```ts
interface MetadataModuleSetLockfile {
  format: "nublox-metaobject-module-set";
  formatVersion: 1;
  roots: readonly {
    moduleId: string;
    version: number;
  }[];
  modules: readonly {
    moduleId: string;
    version: number;
    dependencies: readonly {
      moduleId: string;
      version: number;
    }[];
    members: readonly {
      objectTypeId: string;
      version: number;
    }[];
  }[];
}
```

`modules` is emitted in dependency-first order.

The lockfile is suitable for persistence, source control, deployment manifests, environment configuration and later adapter-specific deployment tooling.

## Runtime registry reconstruction

```ts
const objectTypes = await resolver.buildObjectTypeRegistry(lockfile);
```

The resolver validates the lockfile first, loads the exact published metadata member versions and constructs an `ObjectTypeRegistry` from those exact definitions.

It then validates inheritance and relationship links across the complete locked object graph.

This allows two environments to run different historical metadata versions without relying on whichever version happens to be newest in the catalogue.

## Validation guarantees

`validate()` rejects a lockfile when:

- its format/version is unsupported;
- a root is missing from the locked closure;
- multiple versions of the same module appear;
- a module's dependencies differ from its published locked release manifest;
- a module's members differ from its published locked release manifest;
- an exact locked dependency is absent;
- a dependency cycle exists;
- unreachable extra modules have been inserted;
- two locked modules claim ownership of the same object type;
- an exact object-type member is not published metadata;
- the reconstructed object-type graph has invalid inheritance or relationships.

## Multiple roots and dependency conflicts

A module set may have multiple roots. All roots share one exact dependency graph.

If two roots were historically released against different versions of the same dependency, resolution fails rather than choosing one silently:

```text
app-a@1 -> foundation@1
app-b@1 -> foundation@2

module set -> conflict
```

The caller must choose compatible root versions or explicitly release a new compatible module version.

## Architectural role

The core sequence is now:

```text
Object metadata
    ↓
Metadata catalogue
    ↓
Governed metadata release
    ↓
Versioned metadata modules
    ↓
Persistent module releases
    ↓
Runtime module-set lockfile
    ↓
Exact ObjectTypeRegistry
    ↓
Application runtime
```

This remains application-agnostic. A NuBlox tenant/environment layer can persist one of these lockfiles as its schema deployment state without adding tenant concepts to `@nublox/metaobject` itself.
