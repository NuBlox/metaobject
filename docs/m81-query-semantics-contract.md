# M81 — Query semantics and adapter capability contract

## Objective

M81 establishes the public vocabulary needed to broaden database-native query execution without changing stable-v1 results.

The problem is semantic rather than syntactic: the stable-v1 reference query behaviour uses JavaScript comparison semantics, including `String#localeCompare()` for string and mixed-type ordering. A SQL backend can only push range predicates or attribute ordering when it can prove that its database comparison behaviour is equivalent.

## First increment

The first M81 increment is intentionally backward compatible:

- add a public `QueryPushdownCapabilities` contract;
- add the stable identifier `legacy-js-v1` for the existing ordered-comparison behaviour;
- allow `StorageAdapter` implementations to expose optional `queryPushdownCapabilities`;
- treat an absent declaration as no proven pushdown capability;
- provide fail-closed helper functions for filter, ordered-filter and attribute-ordering capability checks;
- leave all existing query execution and comparison results unchanged.

No adapter gains new SQL pushdown merely by declaring capabilities. Capability declarations describe proven behaviour; they do not bypass compiler/conformance checks.

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

The default query engine behaviour remains exactly as it was before M81. Existing applications do not need to opt in or change code.

## MySQL implication

The current MySQL compiler already proves a useful subset:

- `eq`;
- `neq`;
- `in`;
- `notIn`;
- `isNull`;
- `isNotNull`;
- eligible offset/limit pagination when every filter is pushed and there is no attribute ordering.

It deliberately does not prove `gt`, `gte`, `lt`, `lte` or attribute ordering against `legacy-js-v1`.

A following M81 increment should attach this declaration directly to `MySqlStorageAdapter` and make diagnostics/planning consume the declaration instead of duplicating backend knowledge.

## Exit criteria

M81 is complete when:

- the public capability contract is stable and tested;
- existing adapters remain source-compatible;
- MySQL exposes its proven current capability set;
- planner/compiler diagnostics consume capability declarations;
- a deterministic comparison policy is introduced as an explicit opt-in rather than silently replacing `legacy-js-v1`;
- differential tests prove reference/adapter equivalence for every capability advertised by a production adapter.

M82 can then use the deterministic policy to broaden MySQL range/order pushdown safely.
