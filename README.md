# @nublox/metaobject

A standalone, application-agnostic metadata-driven object model and runtime for TypeScript.

`@nublox/metaobject` turns object metadata into runtime objects with type enforcement, validation, relationships, change tracking, database-neutral querying, versioned metadata persistence, persistence contracts and optional TypeScript code generation. It has no dependency on NuBlox application products or on any database engine.

## Design principles

- **Metadata is the source of truth.** Object definitions describe attributes, types, relationships, constraints, behaviours and indexes.
- **Compile-time and runtime models coexist.** Metadata declared with `as const` can infer TypeScript value shapes; metadata loaded from JSON or a database receives the same runtime validation.
- **Storage is pluggable.** The core package exposes storage contracts rather than embedding MySQL, PostgreSQL or another database.
- **Relationships are first-class.** Object relationships are distinct from primitive attributes and can be coordinated bidirectionally through `ObjectGraph`.
- **Behaviours remain serializable.** Metadata stores stable handler names; executable functions live in runtime registries.
- **Queries are database-neutral.** The advanced query AST and planner sit above storage, allowing later adapters to push plans down natively.
- **Metadata persistence is normalized.** Definitions can be flattened into database-ready object-type, attribute, relationship, constraint, index, rule and behaviour records.
- **Type systems are extensible.** Applications can register additional attribute types without changing the kernel.
- **Optimistic concurrency is part of the object contract.** Runtime objects and metadata drafts both use explicit version/revision checks.

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

## Relationship engine

M1 adds graph-level relationship semantics without coupling objects to a database or ORM.

```ts
const graph = new ObjectGraph(objects);

graph.connect(team, "members", person);
team.relationshipReferences("members");
person.getRelationship("team");
graph.disconnect(team, "members", person);
```

Relationship metadata supports one-to-one, one-to-many, many-to-one and many-to-many cardinality, inverse synchronization, ownership, ordering, required relationships, explicit referential actions and compile-time relationship inference.

M2 adds single inheritance and semantic relationship kinds. `ObjectTypeRegistry.resolve()` flattens inherited metadata, `isA()` drives subtype assignment, and `defineDerivedObjectType()` preserves inherited compile-time shapes. Composition adds exclusive parentage and source-owned lifecycle cascade. See `docs/inheritance-composition.md`.

`MetaObjectRepository` validates persisted references by default. New cyclic or bidirectional object graphs can be persisted through `saveAll()`.

## Constraints and behaviours

M3 makes validation and object behaviour extensible while preserving serializable metadata.

- `ConstraintRegistry` supports built-in and custom attribute constraints.
- Object-level `rules` support cross-field validation with error, warning and info severities.
- Computed attributes reference named resolvers and are excluded from persisted values and create-input types.
- `BehaviorRegistry` hosts computed resolvers, operation handlers and lifecycle hooks.
- `ObjectBehaviorRuntime` evaluates computed values, invokes declared operations and emits declared domain events.
- `EventBus` provides synchronous event dispatch to named or wildcard listeners.
- Rules, operations, events and hooks are inherited through the object type hierarchy with shadow protection.

See `docs/constraints-behaviors.md`.

## Storage model

The core package defines `StorageAdapter` with insert, update, delete, get and query operations. `MemoryStorageAdapter` provides the reference implementation and test harness.

Database-specific adapters remain separate packages, for example:

```text
@nublox/metaobject-storage-mysql
@nublox/metaobject-storage-postgresql
@nublox/metaobject-storage-sqlite
```

## Query engine

M4 adds `MetaQuery`, `QueryPlanner` and `QueryEngine` while retaining the original flat `ObjectQuery` for storage-adapter compatibility.

```ts
const planner = new QueryPlanner(objects);
const queryEngine = new QueryEngine(storage, planner);

const result = await queryEngine.execute({
  objectType: "example.person",
  where: {
    and: [
      { path: "age", operator: "gte", value: 18 },
      { path: "department.name", operator: "eq", value: "Engineering" },
    ],
  },
  select: [
    { path: "name" },
    { path: "department.name", as: "department" },
  ],
  orderBy: [{ path: "salary", direction: "desc" }],
  aggregates: [
    { function: "count", as: "people" },
    { function: "avg", path: "salary", as: "averageSalary" },
  ],
  page: { first: 50 },
});
```

M4 supports recursive logical expressions, metadata-validated multi-hop paths, projections, aggregates, stable cursor pagination, explicit null ordering, subtype expansion and portable query planning. See `docs/query-engine.md`.

## Metadata persistence

M6 adds a database-neutral, normalized metadata catalogue.

```ts
const metadataStore = new MemoryMetadataStore();
const catalog = new MetadataCatalog(metadataStore, types);

const draft = await catalog.saveDraft(Person);
await catalog.publish(Person.id, Person.version, draft.revision);

const runtimeRegistry = await catalog.createPublishedRegistry();
```

`normalizeObjectType()` flattens an object definition into row collections suitable for tables such as:

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

`denormalizeObjectType()` reconstructs the definition. Metadata records support draft/published/deprecated lifecycle, optimistic revision concurrency, version history, batch publication for mutually-dependent schemas, latest-published loading, and portable bundle export/import.

See `docs/metadata-persistence.md`.

## Implemented scope

The standalone kernel now includes:

- metadata definitions, registry and validation
- compile-time value and relationship inference
- extensible attribute type registry
- dynamic object factory and typed attribute enforcement
- defaults and nullability
- first-class relationships and graph navigation
- inverse synchronization, ordered collections and referential actions
- inheritance, polymorphism, aggregation and composition
- extensible validation constraints and cross-field rules
- computed attributes, operations, hooks and domain events
- dirty tracking, serialization, identity and versioning
- storage adapter contract and in-memory persistence
- optimistic runtime concurrency
- database-neutral advanced query engine and planner
- recursive logical expressions and relationship-path traversal
- projections, aggregates, cursor pagination and subtype queries
- normalized metadata persistence model
- versioned metadata store and in-memory reference implementation
- draft / published / deprecated metadata lifecycle
- batch metadata graph publication
- metadata bundle export/import
- runtime registry reconstruction from persisted metadata
- minimal TypeScript interface generation

## Roadmap

### M1 — Relationship engine ✅

Implemented: inverse synchronization, referential integrity, ownership metadata, collection mutation, graph navigation, batch persistence and delete policies.

### M2 — Inheritance and composition ✅

Implemented: resolved base types, inherited metadata, abstract/sealed semantics, lineage/type queries, subtype-compatible relationships, compile-time derived inference and exclusive composition lifecycle rules.

### M3 — Constraint and behaviour registry ✅

Implemented: custom constraints, cross-field rules, severity-aware validation, computed attributes, runtime behaviour registries, validation hooks, declared events, operations and behaviour metadata inheritance.

### M4 — Query engine ✅

Implemented: logical groups, relationship traversal, projections, aggregates, cursor pagination, subtype expansion and metadata-aware query planning.

### M5 — SQL storage adapters

External package milestone. Begin with MySQL while keeping database drivers outside this core package.

### M6 — Metadata persistence ✅

Implemented: normalized metadata rows, versioned store contract, optimistic catalogue revisions, lifecycle states, batch publication, published-registry loading and portable bundles.

### M7 — Code generation

Expand generation to TypeScript interfaces/classes, validators, JSON Schema and adapter-specific artifacts.

### M8 — Schema evolution

Version metadata, calculate differences and provide migration planning hooks.

## Development

```bash
npm run check
```

This runs strict TypeScript checks, compile-time inference tests, builds the package and executes the runtime test suite with Node's built-in test runner.

## Licensing

The package is currently marked `UNLICENSED`. Choose and add the intended NuBlox licence before public package publication.
