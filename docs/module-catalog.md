# Persistent module catalogue

M11 makes M10 module definitions durable. Module metadata can now be stored through a database-neutral `MetadataModuleStore`, versioned with optimistic revisions, published with a locked release manifest, reconstructed into a runtime module registry and moved between environments as portable bundles.

## Store contract

`MetadataModuleStore` exposes:

```ts
get(moduleId, version)
list(filter?)
save(record, expectedRevision?)
delete(moduleId, version, expectedRevision)
```

`MemoryMetadataModuleStore` is the reference implementation. Database packages should implement the same contract rather than adding a driver dependency to core.

A record contains:

```text
moduleId
moduleVersion
status              draft | published | deprecated
revision
module definition
released manifest   published versions
createdAt
updatedAt
```

## Draft lifecycle

```ts
const catalog = new MetadataModuleCatalog(store);
const draft = await catalog.saveDraft(moduleDefinition);
```

Draft updates require the current revision:

```ts
await catalog.saveDraft(changedDefinition, draft.revision);
```

Stale revisions produce a concurrency error. Once a module version is published or deprecated it cannot be edited as a draft.

A newly created draft version must be greater than the latest published version for the same module id.

## Publication

Publication requires the exact manifest produced by module resolution/release:

```ts
await catalog.publish(
  "assets",
  3,
  draft.revision,
  releasedManifest,
);
```

Before publication the catalogue verifies:

- the target is still a draft
- the version advances beyond the latest published version
- dependency ranges resolve against published module versions
- every selected dependency module version is published
- the supplied manifest exactly matches the resolved dependency graph and module members

The manifest is stored with the published record. It therefore becomes the durable record of what dependency versions that module release actually used.

## Published registry reconstruction

```ts
const modules = await catalog.createPublishedRegistry();
```

All published versions are loaded, not only the newest version. This is important because a module dependency can constrain a maximum version and therefore legitimately resolve an older published module.

## Safe deprecation

A published module version cannot be deprecated while another published module currently resolves it as a dependency.

This prevents removing a dependency version that is still needed by an active module graph.

## Portable bundles

```ts
const bundle = await catalog.exportBundle();
await targetCatalog.importBundle(bundle);
```

Bundle format:

```text
format:        nublox-metaobject-modules
formatVersion: 1
records:       MetadataModuleRecord[]
```

Imports are validated as a complete batch before any writes occur.

For every imported published record M11 verifies:

- a released manifest exists
- every manifest dependency points to a published record in the resulting catalogue
- the root module plus the exact dependency versions locked in that manifest reproduce the manifest exactly

This validation intentionally uses the **locked dependency versions**, not today's highest compatible versions. A module released against `foundation@1` remains historically valid after `foundation@2` is published.

Draft replacement is optional and only permits draft-to-draft replacement.

## Database mapping

A relational adapter can persist module catalogue state with tables conceptually similar to:

```text
meta_module
meta_module_member
meta_module_dependency
meta_module_release_dependency
```

The core package does not prescribe SQL column types or dialect-specific DDL. The eventual MySQL adapter can implement `MetadataModuleStore` and generate the physical schema through the M7 artifact-generator extension point.
