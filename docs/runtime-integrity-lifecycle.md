# Runtime integrity and lifecycle

M15 closes the gap between metadata that declares runtime semantics and repository/storage behaviour that enforces them.

## Lifecycle hooks

`MetaObjectRepository` can execute object lifecycle hooks through a shared `BehaviorRegistry`:

```ts
const repository = new MetaObjectRepository(storage, factory, validator, {
  behaviors,
});
```

Supported persistence phases are:

```text
beforeSave
beforeValidate
validation

afterValidate
persistence
afterSave
```

and:

```text
beforeDelete
storage delete / state transition
afterDelete
```

`beforeValidate` / `afterValidate` continue to be executed by `Validator`; M15 wires the save/delete phases into the repository.

`beforeSave` executes before validation, so lifecycle behaviour can populate or normalize values before the object is validated. `afterSave` executes only after persistence succeeds and therefore observes the committed object version in `clean` state.

An exception from a `before*` hook prevents the persistence action. An exception from an `after*` hook occurs after the storage action has already committed and must therefore be treated as a post-commit behaviour failure rather than a rollback request.

## Atomic object batches

`StorageAdapter` now requires:

```ts
saveBatch(writes: readonly StorageBatchWrite[]): Promise<readonly ObjectSnapshot[]>;
```

The contract is atomic:

```text
all optimistic checks succeed + all writes succeed
                    │
                    ▼
                COMMIT ALL

               otherwise
                    │
                    ▼
                COMMIT NONE
```

`MemoryStorageAdapter` stages the complete batch before replacing live state. SQL adapters should implement the same contract with a transaction.

`MetaObjectRepository.saveAll()` now uses this contract. No in-memory object is marked persisted until the whole storage batch has committed successfully.

This is materially stronger than the earlier logical-batch behaviour: a stale version late in a batch cannot leave earlier objects persisted.

## Runtime uniqueness

M15 enforces both forms of uniqueness already present in metadata:

### Unique attributes

```ts
code: { type: "string", unique: true }
```

### Composite unique indexes

```ts
indexes: [
  {
    name: "ux-system-external-id",
    unique: true,
    attributes: [
      { attribute: "system" },
      { attribute: "externalId" },
    ],
  },
]
```

Uniqueness is checked before persistence against:

- persisted objects
- other objects in the same save batch
- the **final** state of all objects being updated in that batch

Because stored versions of objects in the current batch are excluded before comparing final batch values, valid operations such as swapping two unique codes can commit atomically.

## Inheritance scope

A unique attribute or unique index declared on a base type applies to the declaring type and every registered subtype.

For example:

```text
Entity.code UNIQUE
     │
     ├── Employee
     └── Supplier
```

`Employee(code="ABC")` and `Supplier(code="ABC")` conflict even though they are different concrete types.

The repository discovers the metadata type that originally declared each inherited unique rule and queries that complete inheritance scope.

## Null semantics

If any member of a unique tuple is `null` or missing, that tuple does not participate in runtime uniqueness checks. This follows common SQL `UNIQUE` behaviour and keeps the runtime contract compatible with the intended relational adapters.

Applications that require "only one null" semantics should express that as an explicit custom rule rather than relying on `unique`.

## Computed attribute caching

The existing metadata option is now implemented:

```ts
total: {
  type: "decimal",
  computed: {
    resolver: "invoice.total",
    dependencies: ["quantity", "unitPrice"],
    cache: true,
  },
}
```

Each `MetaObject` exposes an in-memory `mutationRevision`. It increments whenever a stored attribute or relationship actually changes, and when hydrated values are replaced.

Computed cache keys use:

```text
object version
object state
mutation revision
```

Therefore repeated reads reuse a cached computed value until the object changes. No JSON serialization or deep hashing is needed, so arbitrary binary/JSON values do not undermine cache invalidation.

`ObjectBehaviorRuntime.invalidate(object, attribute?)` is available for explicit invalidation when application code knows a computation depends on external state not represented by the object itself.

## Adapter obligations

A production storage adapter must now provide four important guarantees:

1. optimistic version checking for updates;
2. atomic `saveBatch()`;
3. exact object snapshots through `get()` / `query()`;
4. database constraints/indexes that match runtime uniqueness wherever practical.

Runtime checks remain valuable for deterministic domain errors, while database constraints remain the final defence against cross-process race conditions. A MySQL adapter should therefore generate physical unique indexes for compatible metadata in addition to using the repository-level checks.
