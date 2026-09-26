# @nublox/metaobject

A standalone, application-agnostic metadata-driven object model and runtime for TypeScript.

`@nublox/metaobject` turns object metadata into runtime objects with type enforcement, validation, relationships, change tracking, abstract querying, persistence contracts and optional TypeScript code generation. It has no dependency on NuBlox application products or on any database engine.

## Design principles

- **Metadata is the source of truth.** Object definitions describe attributes, types, relationships, constraints and indexes.
- **Compile-time and runtime models coexist.** Metadata declared with `as const` can infer TypeScript value shapes; metadata loaded from JSON or a database receives the same runtime validation.
- **Storage is pluggable.** The core package exposes a storage contract rather than embedding MySQL, PostgreSQL or another database.
- **Relationships are first-class.** Object relationships are distinct from primitive attributes.
- **Type systems are extensible.** Applications can register additional attribute types without changing the kernel.
- **Optimistic concurrency is part of the object contract.** Storage adapters enforce version checks consistently.

## Quick start

```ts
import {
  MemoryStorageAdapter,
  MetaObjectRepository,
  ObjectFactory,
  ObjectTypeRegistry,
  Validator,
  createDefaultTypeRegistry,
  defineObjectType,
} from "@nublox/metaobject";

const types = createDefaultTypeRegistry();
const objects = new ObjectTypeRegistry(types);

const Person = defineObjectType({
  id: "example.person",
  name: "Person",
  version: 1,
  attributes: {
    firstName: { type: "string", required: true },
    age: { type: "integer" },
  },
} as const);

objects.register(Person);

const factory = new ObjectFactory(objects, types);
const repository = new MetaObjectRepository(
  new MemoryStorageAdapter(),
  factory,
  new Validator(),
);

const person = factory.create(Person, {
  firstName: "Stephen",
  age: 41,
});

await repository.save(person);
```

The `factory.create(Person, ...)` overload infers the value shape directly from the metadata. Passing a string type id instead supports fully dynamic metadata loaded at runtime.

## Built-in attribute types

- `string`
- `integer`
- `number`
- `decimal`
- `boolean`
- `date`
- `datetime`
- `uuid`
- `json`
- `binary`

Additional types implement `AttributeType<T>` and are registered through `TypeRegistry`.

## Runtime object states

Objects transition through:

```text
new -> clean -> dirty -> clean
       |         |
       +-------> deleted
```

`detached` is also available for objects intentionally removed from a persistence context.

## Storage model

The core package defines `StorageAdapter` with insert, update, delete, get and query operations. `MemoryStorageAdapter` provides the M0 reference implementation and test harness.

Database-specific adapters should be separate packages, for example:

```text
@nublox/metaobject-storage-mysql
@nublox/metaobject-storage-postgresql
@nublox/metaobject-storage-sqlite
```

## Query model

Queries are database-independent:

```ts
const adults = await repository.query({
  objectType: "example.person",
  where: [
    { attribute: "age", operator: "gte", value: 18 },
  ],
  orderBy: [
    { attribute: "age", direction: "desc" },
  ],
});
```

Adapters translate this query AST to their native query language.

## M0 scope

The initial kernel includes:

- metadata definitions
- metadata registry and validation
- compile-time value inference
- extensible attribute type registry
- dynamic object factory
- typed attribute enforcement
- defaults and nullability
- first-class object references/relationships
- validation constraints
- dirty tracking
- serialization and snapshots
- object identity and versioning
- storage adapter contract
- in-memory persistence adapter
- abstract query model
- optimistic concurrency
- minimal TypeScript interface generation

## Roadmap

### M1 — Relationship engine

Inverse relationships, referential integrity, ownership semantics and collection mutation APIs.

### M2 — Inheritance and composition

Base object types, inherited attributes, sealed/abstract types and metadata resolution.

### M3 — Constraint and behaviour registry

Custom constraints, cross-field rules, computed attributes, hooks, events and operations.

### M4 — Query engine

Logical groups, relationship traversal, projections, aggregates, cursor pagination and query planning.

### M5 — SQL storage adapters

Begin with MySQL while keeping dialect implementation outside the core package.

### M6 — Metadata persistence

Persist `ObjectType`, `Attribute`, `AttributeType`, `Relationship`, constraints, indexes and schema versions as data.

### M7 — Code generation

Generate TypeScript interfaces/classes, validators, JSON Schema and adapter-specific artifacts.

### M8 — Schema evolution

Version metadata, calculate differences and provide migration planning hooks.

## Development

```bash
npm run check
```

This runs strict TypeScript checks, compile-time inference tests, builds the package and executes the runtime test suite with Node's built-in test runner.

## Licensing

The package is currently marked `UNLICENSED`. Choose and add the intended NuBlox licence before public package publication.
