# Metadata persistence catalogue

M6 makes object metadata persistable without coupling `@nublox/metaobject` to a database engine.

## Core idea

Runtime metadata:

```text
ObjectTypeDefinition
```

is normalized into database-ready collections:

```text
ObjectType
├── Attribute
│   └── AttributeConstraint
├── Relationship
├── Index
│   └── IndexAttribute
├── ObjectRule
├── Operation
├── Event
└── Hook
```

The normalized model is deliberately relational. A MySQL/PostgreSQL/SQL Server/Oracle metadata-store adapter can map these rows directly to tables. A document store can persist the whole `NormalizedMetadataSnapshot` atomically.

## Suggested SQL tables

The TypeScript row interfaces map naturally to tables such as:

```text
meta_object_type
meta_attribute
meta_attribute_constraint
meta_relationship
meta_index
meta_index_attribute
meta_object_rule
meta_operation
meta_event
meta_hook
```

All child records carry:

```text
object_type_id
object_type_version
```

so multiple schema versions can coexist.

### `meta_object_type`

Representative columns:

```text
object_type_id
version
name
namespace
base_type
is_abstract
is_sealed
is_extensible
```

### `meta_attribute`

Representative columns:

```text
object_type_id
object_type_version
name
ordinal
type
is_required
is_nullable
is_multiple
is_read_only
is_unique
has_default
default_value
computed_resolver
computed_dependencies
computed_cache
```

`default_value` and parameter collections are represented as `unknown` by the core and can be persisted as native JSON where supported.

### `meta_attribute_constraint`

```text
object_type_id
object_type_version
attribute_name
ordinal
type
minimum
maximum
value
pattern
flags
message
parameters
```

### `meta_relationship`

```text
object_type_id
object_type_version
name
ordinal
target
cardinality
is_required
inverse
ownership
kind
is_ordered
on_source_delete
on_target_delete
```

### Index metadata

`meta_index` stores the logical index and `meta_index_attribute` stores its ordered attributes. Physical storage adapters may translate these logical indexes into database-specific indexes later.

## Normalization

```ts
const normalized = normalizeObjectType(definition);
```

The result is `NormalizedMetadataSnapshot` containing the row collections above.

Reconstruction is lossless for supported metadata:

```ts
const definition = denormalizeObjectType(normalized);
```

Ordering is retained explicitly with `ordinal` fields rather than relying on database row order.

## Metadata store

`MetadataStore` is the persistence boundary:

```ts
interface MetadataStore {
  get(objectTypeId, version): Promise<MetadataRecord | null>;
  list(filter?): Promise<readonly MetadataRecord[]>;
  save(record, expectedRevision?): Promise<MetadataRecord>;
  delete(objectTypeId, version, expectedRevision): Promise<void>;
}
```

`MemoryMetadataStore` is the reference implementation. Database-specific implementations remain external packages.

## Metadata records

A record adds catalogue lifecycle information around a normalized snapshot:

```text
objectTypeId
objectTypeVersion
status
revision
snapshot
createdAt
updatedAt
```

Statuses are:

- `draft`
- `published`
- `deprecated`

`revision` is independent of the object-type schema version and is used for optimistic editing concurrency.

## Draft editing

```ts
const first = await catalog.saveDraft(definition);

const updated = await catalog.saveDraft(
  changedDefinition,
  first.revision,
);
```

Updating an existing draft without the current revision is rejected.

Published/deprecated versions are immutable through `saveDraft`; create a new object-type version for schema evolution.

## Publication

Publishing validates the candidate against the currently active metadata graph:

```ts
await catalog.publish(
  definition.id,
  definition.version,
  draft.revision,
);
```

Validation includes inheritance and relationship integrity.

## Batch publication

Mutually-dependent definitions need to become valid together. For example, two object types may contain inverse relationships to each other.

```ts
await catalog.publishMany([
  {
    objectTypeId: parent.id,
    version: parent.version,
    expectedRevision: parentDraft.revision,
  },
  {
    objectTypeId: child.id,
    version: child.version,
    expectedRevision: childDraft.revision,
  },
]);
```

The entire candidate graph is validated before publication begins.

A database-backed `MetadataStore` should execute multi-record publication in a transaction when atomic activation is required.

## Multiple published versions

Historical published versions may coexist. Runtime loading chooses the highest published version for each object type:

```ts
const registry = await catalog.createPublishedRegistry();
```

This reconstructs definitions, registers them into `ObjectTypeRegistry`, then validates inheritance and relationships.

Older versions can explicitly transition to `deprecated`.

## Bundles

A catalogue can be exported:

```ts
const bundle = await catalog.exportBundle();
```

Bundle format:

```text
format: "nublox-metaobject-metadata"
formatVersion: 1
records: [...]
```

and imported into another compatible store:

```ts
await targetCatalog.importBundle(bundle);
```

This gives NuBlox a portable metadata interchange format independent of storage engine.

## Relationship to runtime object data

M6 persists **object definitions**, not business object instances.

The conceptual separation is:

```text
METADATA
ObjectType / Attribute / Relationship / Constraint / ...

        defines
           |
           v
RUNTIME DATA
ObjectInstance / ObjectValue / RelationshipInstance
```

The metadata catalogue therefore supplies the schema used by the runtime object engine. Database-specific instance storage remains behind `StorageAdapter`.

## MySQL adapter boundary

The core intentionally does not import `mysql2` or any database driver. A separate package should implement:

```text
@nublox/metaobject-storage-mysql
```

and, if desired, a MySQL `MetadataStore` implementation using the normalized M6 row model.
