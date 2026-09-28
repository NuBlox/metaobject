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

Core exposes shared stable-v1 comparison helpers:

- `compareLegacyStorageScalar()` for `StorageAdapter.query` semantics;
- `compareLegacyMetaQueryScalar()` for `MetaQuery`/`QueryEngine` semantics.

The distinction is deliberate. The v1 implementations historically used different equality short circuits: storage comparison uses strict equality while `QueryEngine` uses `Object.is`. This is observable for `NaN` and signed zero. M81 preserves and tests that difference instead of silently normalising it in a minor release.

`MemoryStorageAdapter` and `QueryEngine` consume the shared helpers, so future changes have one explicit semantic boundary rather than duplicated comparison functions.

The MySQL adapter now:

- exposes `queryPushdownCapabilities` on `MySqlStorageAdapter`;
- exports a typed structural capability declaration while it remains independently qualified against published core `1.0.0`;
- passes that declaration into `compileMySqlObjectQueryPlan()`;
- makes filter and pagination planning consume the declaration;
- still fails closed when a capability claims an operator for which no SQL compiler implementation exists.

The capability declaration therefore constrains execution rather than merely documenting it.

## Third increment — deterministic code-point policy

M81 introduces a second named policy:

```text
deterministic-codepoint-v1
```

It is an explicit opt-in through `ObjectQuery.comparisonSemantics` or `MetaQuery.comparisonSemantics`. Omitting that property continues to select `legacy-js-v1`; therefore existing v1 callers retain their current ordering and filtering behaviour.

The deterministic policy defines a total scalar ordering suitable for cross-runtime conformance work:

1. `null` and `undefined` share the configured null bucket (`first` or `last`);
2. non-null scalar kinds have a stable cross-type rank: boolean, number, bigint, Date, string, other;
3. booleans order `false < true`;
4. numbers order numerically, `-0` equals `+0`, infinities retain numeric order, and `NaN` sorts after every non-NaN number;
5. bigints order numerically;
6. Dates order by epoch milliseconds, with invalid Dates following valid Dates;
7. strings order lexicographically by Unicode code point, independent of process locale and ICU data;
8. fallback values use the same code-point ordering over their JavaScript string representation.

Core exposes `compareDeterministicCodepointScalar()` plus dispatch helpers that fail closed for unknown semantics identifiers.

`MemoryStorageAdapter` applies the selected policy to range filters and attribute ordering. `QueryEngine` applies the same selected policy to range predicates, ordering, cursor continuation and min/max aggregates. Dedicated regression vectors cover Unicode ordering, special numeric values, signed zero, invalid Dates, null placement and cross-type ordering, plus end-to-end reference execution.

No production database adapter advertises ordered pushdown for `deterministic-codepoint-v1` yet. That proof remains a separate qualification step.

## Capability model

`QueryPushdownCapabilities` separates four concerns:

1. operators that are safe independently of ordered comparison semantics;
2. named comparison semantics under which range predicates are equivalent;
3. named comparison semantics under which attribute ordering is equivalent;
4. pagination preconditions.

This is deliberately stricter than a single `supportsQueryPushdown=true` switch. An adapter may safely push equality/membership/null predicates while still refusing ordered comparisons.

## Stable-v1 comparison semantics

The stable default identifier is:

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

It deliberately does not prove `gt`, `gte`, `lt`, `lte` or attribute ordering against either named comparison policy yet.

The planner reads the declared subset. Removing a capability forces that work back to the JavaScript residual path, and falsely advertising an untranslated operator still leaves it residual. This is the fail-closed behaviour required before adapters can negotiate richer semantics.

## Remaining M81 work

M81 is not yet complete. The remaining qualification path is:

1. build reusable differential conformance vectors that production adapters can run against the deterministic reference policy;
2. prove or reject MySQL equivalence separately for numeric/date ranges and Unicode code-point string ordering;
3. advertise ordered-filter or attribute-ordering support only for cases that pass those vectors;
4. advance core to a compatible minor release before the MySQL package imports the canonical core capability/comparison types directly;
5. close M81 release evidence and then move broader native pushdown into M82.

## Exit criteria

M81 is complete when:

- the public capability contract is stable and tested;
- existing adapters remain source-compatible;
- MySQL exposes its proven current capability set;
- planner/compiler diagnostics consume capability declarations;
- stable-v1 comparison semantics are centralised and regression-tested;
- `deterministic-codepoint-v1` is available as an explicit opt-in while `legacy-js-v1` remains the default;
- differential tests prove reference/adapter equivalence for every ordered capability advertised by a production adapter.

M82 can then use the deterministic policy to broaden MySQL range/order pushdown safely.
