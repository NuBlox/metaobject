# Relationship Engine

`@nublox/metaobject` treats relationships as first-class metadata and runtime state rather than encoding them as ordinary attributes.

## Metadata

A relationship describes the target object type, cardinality and optional bidirectional semantics.

```ts
const Team = defineObjectType({
  id: "example.team",
  name: "Team",
  version: 1,
  attributes: {},
  relationships: {
    members: {
      target: "example.person",
      cardinality: "one-to-many",
      inverse: "team",
      ownership: "source",
      ordered: true,
      onSourceDelete: "detach",
      onTargetDelete: "restrict",
    },
  },
});
```

Supported cardinalities are `one-to-one`, `one-to-many`, `many-to-one` and `many-to-many`.

## Inverse validation

`ObjectTypeRegistry.validateRelationships()` verifies that:

- the target object type exists;
- the named inverse exists;
- the inverse points back to the source object type;
- inverse cardinality is compatible;
- an inverse that names its reverse relationship points back to the correct name;
- explicitly declared ownership is complementary;
- explicitly declared delete policies do not contradict the inverse end.

Cardinality complements are:

| Relationship | Inverse |
| --- | --- |
| one-to-one | one-to-one |
| one-to-many | many-to-one |
| many-to-one | one-to-many |
| many-to-many | many-to-many |

## Runtime mutation

A `MetaObject` can manipulate its own reference state directly:

```ts
object.setRelationship("manager", managerRef);
object.addRelationship("members", personRef);
object.removeRelationship("members", personRef);
object.clearRelationship("members");
```

To-many relationships de-duplicate targets by object identity. `addRelationship` can insert at a specific position for ordered collections.

Relationship mutations are tracked separately from attribute mutations:

```ts
object.changedRelationships();
```

## ObjectGraph

`ObjectGraph` coordinates relationships between loaded objects.

```ts
const graph = new ObjectGraph(objectTypes);
graph.connect(team, "members", person);
```

If `members` declares `inverse: "team"`, the graph updates both objects. Disconnecting either through the graph also updates the inverse.

`graph.related(object, relationship)` resolves references to objects currently attached to the graph and preserves relationship order.

## Referential actions

Delete behavior is explicit:

- `detach` removes the edge and keeps the other object;
- `restrict` rejects deletion while the edge exists;
- `cascade` propagates deletion across the edge.

`onSourceDelete` controls deletion of the source object. `onTargetDelete` controls what happens when a referenced target is deleted. Both default to `detach`.

`ownership` records semantic ownership of the relationship but does **not** imply cascade deletion. This keeps destructive lifecycle behavior opt-in and visible in metadata.

## Repository integrity

`MetaObjectRepository` verifies by default that relationship targets already exist in storage before saving an object. Self-references are allowed.

New bidirectional graphs create a persistence cycle, so `saveAll()` validates references against both storage and the batch being written:

```ts
await repository.saveAll([team, person]);
```

This is a logical batch contract. Transactionality is the responsibility of storage adapters; SQL adapters can later map the same contract to database transactions and deferred constraints where supported.

## Compile-time inference

Literal metadata can infer relationship shapes:

```ts
type Relationships = InferRelationships<typeof Person>;
```

Target `type` values remain literal, so TypeScript rejects references to the wrong object type at compile time.

## Persistence representation

Snapshots continue to store relationships independently of primitive values:

```ts
{
  id,
  type,
  values: { ... },
  relationships: {
    team: { id: "...", type: "example.team" },
    reports: [
      { id: "...", type: "example.person" },
    ],
  },
}
```

This separation lets future SQL adapters choose dedicated relationship tables, foreign keys, join tables or another physical representation without changing the public object API.
