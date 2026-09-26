# Architecture

## Purpose

`@nublox/metaobject` is a standalone metadata-driven object kernel. It deliberately contains no ERP, tenant, construction, finance, HCM or other application-domain concepts.

Its responsibility is to turn metadata into runtime object semantics and expose stable contracts that storage, code-generation and application layers can consume.

## Layers

```text
Metadata definitions
        |
        v
TypeRegistry + ObjectTypeRegistry
        |
        v
ObjectFactory
        |
        v
MetaObject runtime
        |
        +--> validation
        +--> relationships
        +--> change tracking
        +--> serialization
        +--> snapshots
        |
        v
MetaObjectRepository
        |
        v
StorageAdapter
        |
        +--> MemoryStorageAdapter
        +--> future MySQL adapter
        +--> future PostgreSQL adapter
        +--> future SQLite adapter
```

## Compile-time and runtime typing

The package supports two complementary modes.

### Compile-time metadata

Metadata defined in TypeScript with literal types can be converted into an inferred value shape using `InferValues<T>`.

```ts
const Person = defineObjectType({
  id: "example.person",
  name: "Person",
  version: 1,
  attributes: {
    firstName: { type: "string", required: true },
    age: { type: "integer" },
  },
} as const);

type PersonValues = InferValues<typeof Person>;
```

### Runtime metadata

Definitions loaded from JSON, a database or an API are registered with `ObjectTypeRegistry`. Runtime values are checked through `TypeRegistry` and validated independently from the TypeScript compiler.

These two modes use the same object definition structure so callers do not need separate domain models.

## Metadata model

M0 contains:

```text
ObjectTypeDefinition
    |
    +-- AttributeDefinition
    |       |
    |       +-- AttributeType (registered by name)
    |       +-- ConstraintDefinition
    |
    +-- RelationshipDefinition
    +-- IndexDefinition
```

Later milestones can extend the model with inheritance, computed attributes, operations, events, lifecycle metadata and schema evolution without changing the basic runtime identity model.

## Runtime identity

Every runtime object has two pieces of identity:

```text
ObjectIdentity
    id
    type
```

Persistence version is intentionally separate from identity and is used for optimistic concurrency.

## Object state

The runtime tracks persistence state:

```text
new -> clean -> dirty -> clean
       |         |
       +-------> deleted

(detached is also supported)
```

This allows storage adapters and future unit-of-work implementations to avoid unnecessary writes and to support audit/event generation from tracked changes.

## Attribute types

`TypeRegistry` owns runtime scalar semantics. Each `AttributeType<T>` supplies:

- `validate`
- `serialize`
- `deserialize`
- optional equality semantics

The core ships common primitive types but does not close the type system. Consumers can register types such as money, duration, rich text, vectors or geospatial values.

## Relationships

Relationships are first-class metadata rather than pretending every reference is a primitive attribute. M0 validates target object type and relationship cardinality at mutation time.

Future relationship work should add:

- inverse maintenance
- referential integrity
- ownership/cascade semantics
- relationship collection operations
- relationship traversal in queries

## Validation

Runtime type checking and business validation are separate concerns.

Type checking answers:

> Can this value inhabit this attribute type?

Validation answers:

> Is this object valid according to its metadata rules?

M0 supports required/nullability rules plus length, range and regular-expression constraints.

## Persistence contract

The core package exposes `StorageAdapter` using object snapshots. It contains no SQL syntax, connection handling or database-driver dependency.

```text
MetaObjectRepository
        |
        v
StorageAdapter
        |
        +-- insert
        +-- update(expectedVersion)
        +-- delete(expectedVersion)
        +-- get
        +-- query
```

Database adapters should live in independent packages and translate the abstract query model into the target database's native capabilities.

## Optimistic concurrency

Stored snapshots carry a persistence version. Updates and deletes supply an expected version. A storage adapter must reject stale writes with `ConcurrencyError`.

This behaviour is part of the package contract rather than an implementation detail of any single database.

## Query model

`ObjectQuery` is an adapter-neutral query AST containing filters, sorting, offset and limit. It must remain free of SQL-specific syntax.

Future milestones can introduce nested logical groups, joins/relationship traversal, projection, aggregation and cursor pagination while preserving the adapter boundary.

## Code generation

The first generator produces TypeScript interfaces from object definitions. Code generation is intentionally downstream from metadata: generated code is a representation of the model, never the source of truth.

## Package boundaries

The intended package family is:

```text
@nublox/metaobject
@nublox/metaobject-storage-mysql
@nublox/metaobject-storage-postgresql
@nublox/metaobject-storage-sqlite
@nublox/metaobject-codegen
```

The core must not depend on any storage adapter or application package. Dependency arrows always point toward `@nublox/metaobject`, never back out from it.
