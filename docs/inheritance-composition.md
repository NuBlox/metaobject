# Inheritance and Composition

M2 adds type hierarchy semantics to `@nublox/metaobject` while preserving the package's metadata-first model.

## Single inheritance

Object types may declare one `baseType`:

```ts
const Party = defineObjectType({
  id: "example.party",
  name: "Party",
  version: 1,
  abstract: true,
  attributes: {
    name: { type: "string", required: true },
  },
});

const Employee = defineDerivedObjectType(Party, {
  id: "example.employee",
  name: "Employee",
  version: 1,
  baseType: "example.party",
  attributes: {
    employeeNumber: { type: "string", required: true },
  },
});
```

`defineDerivedObjectType()` is optional at runtime. Metadata loaded from JSON or a database can continue to use `baseType` directly. The helper exists so TypeScript can recursively infer inherited attribute and relationship shapes from literal metadata.

## Declared versus resolved definitions

`ObjectTypeRegistry.get(id)` returns the exact definition registered for an object type.

`ObjectTypeRegistry.resolve(id)` returns a flattened `ResolvedObjectTypeDefinition` containing:

- inherited and declared attributes;
- inherited and declared relationships;
- inherited and declared indexes;
- root-to-leaf `lineage`;
- the original unflattened definition in `declared`.

Runtime objects are created from the resolved definition, so inherited defaults, validation rules and relationships behave exactly like locally declared members.

## Hierarchy rules

The M2 hierarchy is deliberately strict:

- one base type per object type;
- base types must exist;
- inheritance cycles are rejected;
- `sealed` types cannot be extended;
- `abstract` types cannot be instantiated;
- attributes cannot shadow inherited attributes;
- relationships cannot shadow inherited relationships;
- index names cannot shadow inherited index names;
- indexes on a derived type may reference inherited attributes.

Explicit non-shadowing keeps schema evolution deterministic. Override semantics can be added later as a separately specified feature rather than emerging accidentally from merge order.

## Type queries

The registry exposes hierarchy operations:

```ts
objects.lineage("example.manager");
objects.isA("example.manager", "example.party");
objects.directSubtypes("example.party");
objects.subtypes("example.party");
```

`isA(actual, expected)` is also used by the runtime relationship engine. A relationship targeting `example.party` therefore accepts an `example.employee` or any other transitive subtype.

## Compile-time inheritance

`InferValues<T>` and `InferRelationships<T>` recursively include parent metadata when the type was declared with `defineDerivedObjectType()`:

```ts
type EmployeeValues = InferValues<typeof Employee>;
// {
//   name: string;
//   employeeNumber: string;
// }
```

The brand used for this inference is type-only and is not added to serialized metadata.

## Composition

Relationships can declare a semantic kind:

```ts
relationships: {
  lines: {
    target: "example.order-line",
    cardinality: "one-to-many",
    kind: "composition",
  },
}
```

Supported kinds are:

- `association` — ordinary reference semantics;
- `aggregation` — shared whole/part semantics without exclusive lifecycle ownership;
- `composition` — exclusive source-owned whole/part semantics.

When `kind: "composition"` is used:

- cardinality from owner to part must be `one-to-one` or `one-to-many`;
- explicit `ownership`, when supplied, must be `source`;
- source deletion cascades to parts by default;
- an explicit non-cascade `onSourceDelete` is invalid;
- an attached part may have only one composite parent across the object graph.

This is intentionally stronger than ordinary `ownership` metadata. M1's rule remains unchanged: setting `ownership: "source"` on a normal association does **not** silently imply lifecycle cascade.

## Polymorphic relationships

Relationship targets are assignability constraints, not exact runtime type strings.

If:

```text
Party
└── Employee
```

and `Organisation.people` targets `Party`, then an `Employee` can be connected to `Organisation.people`. The snapshot still stores the concrete runtime type (`Employee`), preserving correct hydration and identity.

## Persistence

Snapshots persist the concrete object type. On hydration, `ObjectFactory` resolves that type through the current registry and reconstructs the flattened definition.

Inheritance therefore remains a metadata concern rather than requiring a particular SQL inheritance strategy. Future storage adapters may choose table-per-hierarchy, table-per-type, JSON, generic typed values or another representation without changing the object API.
