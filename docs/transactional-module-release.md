# Transactional module release

M12 closes the gap between durable module state and metadata publication.

A module release now uses a durable two-phase lifecycle:

1. prepare the complete module release using the M10/M9 pipeline;
2. atomically move the module record from `draft` to `releasing` while locking the exact resolved manifest;
3. execute required migrations;
4. atomically publish every module member through `MetadataStore.saveBatch()`;
5. move the module record from `releasing` to `published`.

The module remains `releasing` when a failure occurs after the release lock is acquired. This is deliberate: adapter migrations can have external side effects, so silently returning the module to `draft` would claim that nothing happened when that may not be true.

## Persistent release manager

```ts
const releases = new PersistentMetadataModuleReleaseManager(
  moduleCatalog,
  metadataCatalog,
  metadataReleaseManager,
);

const result = await releases.release("workforce", 2, {
  approveBreaking: true,
  migrationExecutor,
});
```

`PersistentMetadataModuleReleaseManager` coordinates the durable module catalogue with the metadata release manager. It verifies the module is still the expected draft revision before locking it and uses the locked manifest for recovery decisions.

## Atomic member publication

`MetadataStore` now exposes `saveBatch()`.

```ts
await store.saveBatch([
  { record: personV2, expectedRevision: 3 },
  { record: teamV2, expectedRevision: 7 },
]);
```

The store contract requires all writes and optimistic revision checks to succeed together. `MemoryMetadataStore` stages the complete batch before replacing live state. SQL-backed implementations should use a database transaction.

This prevents a metadata module from becoming half-published because the second or later member failed an optimistic concurrency check.

## Release states

```text
draft
  |
  | beginRelease()
  v
releasing
  | \
  |  \ abortRelease()  (only before any member is published)
  |   \
  |    -> draft
  |
  | completeRelease()
  v
published
  |
  v
deprecated
```

`releasing` is intentionally durable and can survive process interruption.

## Recovery

Use `recover()` after an interrupted release when every module member has already been published:

```ts
await releases.recover("workforce", 2);
```

Recovery verifies every locked module member is `published` before completing the module record.

Use `abort()` only when no module member has been published:

```ts
await releases.abort("workforce", 2);
```

If any member is already published, abort is rejected because returning the module to `draft` would misrepresent the persisted state. Complete the remaining work and recover instead.

## Adapter boundary

The core package still does not own physical database transactions or DDL. An adapter package should implement:

- `MetadataStore.saveBatch()` using its transaction primitive;
- `MigrationExecutor` for physical schema/data changes;
- optional adapter-specific generated artifacts.

For MySQL that belongs in `@nublox/metaobject-storage-mysql`, not in the core package.

## Guarantees

M12 provides the following core guarantees:

- exact module manifest is locked before migrations begin;
- module drafts cannot be edited while `releasing`;
- metadata member publication is atomic at the `MetadataStore` boundary;
- optimistic revision conflicts abort the complete metadata publication batch;
- failed release processes retain a recoverable durable state;
- abort is permitted only before member publication;
- recovery is permitted only when the complete member graph is published;
- published module manifests continue to pin exact dependency versions.
