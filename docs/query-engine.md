# Query engine

M4 adds a database-neutral advanced query model while preserving the existing `StorageAdapter.query(ObjectQuery)` contract.

## Architecture

```text
MetaQuery
   |
   v
QueryPlanner
   |
   v
QueryPlan
   |
   v
QueryEngine
   |
   +--> StorageAdapter.query()  base candidates
   +--> StorageAdapter.get()    relationship traversal
```

The portable engine can execute against any current storage adapter. Future SQL adapters can translate the same `MetaQuery`/`QueryPlan` natively and avoid application-side traversal.

## Logical expressions

Predicates can be combined recursively:

```ts
const where = {
  and: [
    { path: "age", operator: "gte", value: 18 },
    {
      or: [
        { path: "department.name", operator: "eq", value: "Engineering" },
        { path: "name", operator: "startsWith", value: "C" },
      ],
    },
  ],
};
```

Supported operators are:

- `eq`, `neq`
- `gt`, `gte`, `lt`, `lte`
- `in`, `notIn`
- `contains`, `startsWith`, `endsWith`
- `isNull`, `isNotNull`

`and`, `or` and `not` may be nested to arbitrary depth.

## Relationship traversal

Paths use dot notation:

```text
department.name
manager.department.name
project.owner.name
```

`QueryPlanner` validates each segment against resolved object metadata. Attribute segments must be terminal. Relationship segments advance to the relationship target type.

To-many traversal returns a collection of resolved values. Positive predicates match when any resolved value matches; negative predicates such as `neq` and `notIn` require all resolved values to satisfy the negative condition.

The engine caches `StorageAdapter.get()` results for the duration of one query execution so repeated relationship traversal does not repeatedly load the same object.

## System paths

Queries may reference:

- `$id`
- `$type`
- `$version`
- `$schemaVersion`

`$id` is automatically appended to sorting when absent, providing deterministic cursor ordering.

## Projections

```ts
select: [
  { path: "name" },
  { path: "department.name", as: "department" },
]
```

Rows always contain `$id` and `$type`. Selected values are returned under their alias or path name.

When `select` is omitted, all stored root-object attribute values are returned. Relationship values are only included when explicitly projected.

## Ordering

```ts
orderBy: [
  { path: "salary", direction: "desc", nulls: "last" },
]
```

Ordering supports multiple paths, ascending/descending direction and explicit null placement. A final `$id ASC` order is added automatically unless the query already orders by `$id`.

## Cursor pagination

```ts
page: {
  first: 50,
  after: previous.pageInfo.endCursor,
}
```

Cursors encode the complete stable order tuple. They are opaque implementation values and callers should not parse them.

Results expose:

```ts
{
  rows,
  totalMatched,
  aggregates,
  pageInfo: {
    hasNextPage,
    endCursor,
  },
}
```

`totalMatched` counts all objects matching the predicate before cursor/window pagination.

## Aggregates

Supported functions:

- `count`
- `sum`
- `avg`
- `min`
- `max`

Example:

```ts
aggregates: [
  { function: "count", as: "people" },
  { function: "sum", path: "salary", as: "payroll" },
  { function: "avg", path: "salary", as: "averageSalary" },
  { function: "max", path: "salary", as: "highestSalary" },
]
```

Aggregates are calculated across the complete filtered result set before cursor pagination. `sum` and `avg` require numeric values. Aggregates may set `distinct: true`.

## Polymorphic queries

```ts
{
  objectType: "example.party",
  includeSubtypes: true,
}
```

When enabled, `QueryPlanner` expands the root object type using `ObjectTypeRegistry.subtypes()`. The engine retrieves candidates for the root and every registered subtype.

## Query planning

A `QueryPlan` exposes:

- root object types
- all referenced paths
- relationship traversal prefixes
- stable normalized ordering
- the original portable query

This gives database adapters a clear translation boundary for future push-down optimization.

## Compatibility

M4 does not replace the existing storage query API. The original flat model remains available:

```ts
storage.query({
  objectType: "example.person",
  where: [{ attribute: "age", operator: "gte", value: 18 }],
  orderBy: [{ attribute: "age", direction: "desc" }],
  limit: 100,
});
```

Use `QueryEngine` for relationship traversal, logical groups, projections, aggregates, subtype expansion and cursor pagination.
