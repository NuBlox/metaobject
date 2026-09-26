# Runtime profiles

M14 makes an M13 module-set lockfile durable as a versioned runtime profile.

A runtime profile is deliberately application-agnostic. It represents a named runtime schema configuration, not a NuBlox tenant, site, environment or deployment target.

## Definition and activation

A profile definition records human-readable module requirements:

```ts
const profile = defineRuntimeProfile({
  id: "production",
  name: "Production",
  version: 3,
  requirements: [
    { moduleId: "workforce", minimumVersion: 2 },
    { moduleId: "assets", minimumVersion: 4, maximumVersion: 6 },
  ],
});
```

Draft definitions remain editable under optimistic revision control.

Activation resolves those ranges through `MetadataModuleSetResolver` and stores the resulting exact lockfile with the profile record:

```ts
const draft = await profiles.saveDraft(profile);
const active = await profiles.activate(
  profile.id,
  profile.version,
  draft.revision,
);
```

After activation the profile version is immutable. A changed runtime schema is represented by a new profile version.

## Lifecycle

```text
draft -> active -> deprecated
```

- `draft`: requirements may be edited.
- `active`: the requirements have been resolved and the exact module-set lockfile is frozen.
- `deprecated`: no longer current, but its exact historical runtime schema remains reconstructable.

New profile versions must be greater than the latest active version of the same profile id.

## Exact runtime reconstruction

```ts
const objectTypes = await profiles.buildObjectTypeRegistry(
  "production",
  3,
);
```

When the version is omitted, the latest active version is used.

The registry is rebuilt from the profile's persisted M13 lockfile. It therefore uses the exact module versions and exact metadata member versions selected at activation time, even if newer compatible modules are now published.

Deprecated versions remain reconstructable for audit, rollback and historical processing.

## Persistence

`RuntimeProfileStore` is a pluggable persistence contract with optimistic revisions:

```ts
interface RuntimeProfileStore {
  get(profileId: string, version: number): Promise<RuntimeProfileRecord | null>;
  list(filter?: RuntimeProfileRecordFilter): Promise<readonly RuntimeProfileRecord[]>;
  save(record: RuntimeProfileRecord, expectedRevision?: number): Promise<RuntimeProfileRecord>;
  delete(profileId: string, version: number, expectedRevision: number): Promise<void>;
}
```

`MemoryRuntimeProfileStore` is the core reference implementation. Database-backed implementations belong in adapter packages.

## Portable bundles

Profiles export as `nublox-metaobject-runtime-profiles` bundles.

```ts
const bundle = await profiles.exportBundle();
await targetProfiles.importBundle(bundle);
```

Import validates every record before writing:

- record identity matches the definition;
- definitions contain valid non-duplicate module requirements;
- drafts do not contain lockfiles;
- active/deprecated records contain lockfiles;
- every lockfile is validated against the current published module catalogue.

Existing records are rejected by default. `replaceDrafts` may replace only draft records with other drafts.

## Why definitions and lockfiles are both retained

The profile definition answers:

> What compatibility ranges did the operator request?

The lockfile answers:

> What exact schema did this profile activate?

Keeping both gives readable intent and reproducible execution without allowing dependency drift.

## Architectural sequence

```text
Published metadata
       ↓
Published modules + locked manifests
       ↓
M13 module-set resolution
       ↓
Exact module-set lockfile
       ↓
M14 runtime profile activation
       ↓
Durable versioned runtime schema
       ↓
Exact ObjectTypeRegistry
```

Higher-level products can associate a runtime-profile id/version with a tenant, environment, project or deployment without introducing those product concepts into this core library.
