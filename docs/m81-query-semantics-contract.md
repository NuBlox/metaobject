# M81 — Query semantics and adapter capability contract

## Objective

M81 establishes the public vocabulary needed to broaden database-native query execution without changing stable-v1 results.

The problem is semantic rather than syntactic: the stable-v1 reference query behaviour uses JavaScript comparison semantics, including `String#localeCompare()` for string and mixed-type ordering. A SQL backend can only push range predicates or attribute ordering when it can prove that its database comparison behaviour is equivalent.

## First increment — capability vocabulary

The first M81 increment is intentionally backward compatible:

- add a public `QueryPushdownCapabilities` contract;
- add the stable identifier `legacy-js-v1` for the existing ordered-comparison behaviour;
- allow `StorageAdapter` implementations to expose optional `queryPushdownCapabilities`;
- treat an absent declaration as no proven pushdown capability;
- provide fail-closed helper functions for filter, ordered-filter and attribute-ordering capability checks;
- leave all existing query execution and comparison results unchanged.

No adapter gains new SQL pushdown merely by declaring capabilities. Capability declarations describe proven behaviour; they do not bypass compiler/conformance checks.

## Second increment — comparison centralisation and capability-driven planning

The second M81 increment removes two sources of hidden semantic drift without changing the v1 observable contract.

Core now exposes shared stable-v1 comparison helpers:

- `compareLegacyStorageScalar()` for `StorageAdapter.query` semantics;
- `compareLegacyMetaQueryScalar()` for `MetaQuery`/`QueryEngine` semantics.

The distinction is deliberate. The v1 implementations historically used different equality short circuits: storage comparison uses strict equality while `QueryEngine` uses `Object.is`. This is observable for `NaN`. M81 preserves and tests that difference instead of silently normalising it in a minor release.

`MemoryStorageAdapter` and `QueryEngine` now consume the shared helpers, so future changes have one explicit semantic boundary rather than duplicated comparison functions.

The MySQL adapter now:

- exposes `queryPushdownCapabilities` on `MySqlStorageAdapter`;
- exports a typed structural capability declaration while it remains independently qualified against published core `1.0.0`;
- passes that declaration into `compileMySqlObjectQueryPlan()`;
- makes filter and pagination planning consume the declaration;
- still fails closed when a capability claims an operator for which no SQL compiler implementation exists.

The capability declaration therefore constrains execution rather than merely documenting it.

## Capability model

`QueryPushdownCapabilities` separates four concerns:

1. operators that are safe independently of ordered comparison semantics;
2. named comparison semantics under which range predicates are equivalent;
3. named comparison semantics under which attribute ordering is equivalent;
4. pagination preconditions.

This is deliberately stricter than a single `supportsQueryPushdown=true` switch. An adapter may safely push equality/membership/null predicates while still refusing ordered comparisons.

## Stable-v1 comparison semantics

The stable identifier is:

```text
legacy-js-v1
```

It names the current observable behaviour; it does not claim that JavaScript locale-sensitive ordering is portable to a SQL collation.

The default query behaviour remains exactly as it was before M81. Existing applications do not need to opt in or change code.

## MySQL implication

The current MySQL compiler proves this native subset:

- `eq`;
- `neq`;
- `in`;
- `notIn`;
- `isNull`;
- `isNotNull`;
- eligible offset/limit pagination when every filter is pushed and there is no attribute ordering.

It deliberately does not prove `gt`, `gte`, `lt`, `lte` or attribute ordering against `legacy-js-v1`.

The planner now reads the declared subset. Removing a capability forces that work back to the JavaScript residual path, and falsely advertising an untranslated operator still leaves it residual. This is the fail-closed behaviour required before adapters can negotiate richer semantics.

## Remaining M81 work

M81 is not yet complete. The next increments are:

1. introduce a deterministic comparison policy as an explicit opt-in rather than replacing `legacy-js-v1`;
2. define the exact scalar ordering for strings, numbers, booleans, dates, nullish and mixed values under that policy;
3. add differential vectors that execute identical pathological values through the reference adapter and production adapters;
4. allow an adapter to advertise ordered-filter or attribute-ordering support only after those vectors prove equivalence;
5. advance core to a compatible minor release before the MySQL package imports the canonical core capability/comparison types directly.

## Exit criteria

M81 is complete when:

- the public capability contract is stable and tested;
- existing adapters remain source-compatible;
- MySQL exposes its proven current capability set;
- planner/compiler diagnostics consume capability declarations;
- stable-v1 comparison semantics are centralised and regression-tested;
- a deterministic comparison policy is introduced as an explicit opt-in rather than silently replacing `legacy-js-v1`;
- differential tests prove reference/adapter equivalence for every capability advertised by a production adapter.

M82 can then use the deterministic policy to broaden MySQL range/order pushdown safely.
