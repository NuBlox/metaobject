# M72 — MySQL query translation and safe pushdown

M72 extends `@nublox/metaobject-storage-mysql` from persistence-only execution into contract-preserving query translation.

## Objective

Reduce the number of object snapshots transferred from MySQL to JavaScript without changing the observable `StorageAdapter.query()` semantics defined by the MetaObject RC.

The execution path is:

```text
ObjectQuery
    |
    v
compileMySqlObjectQueryPlan()
    |
    +--> SQL-safe predicates -> prepared SQL
    |
    +--> residual predicates -> JavaScript fallback
    |
    v
@nublox/mysql PromisePool.execute()
    |
    v
MySQL 8.x
    |
    v
decode + semantic recheck + residual sort/page
```

## NuBloxSQL boundary

The adapter does not implement a database protocol, prepared-statement cache, pooling or transaction machinery. It compiles MetaObject semantics into SQL and delegates execution to `@nublox/mysql`.

M72 uses NuBloxSQL server-side prepared statements through `PromisePool.execute()`. SQL text contains only adapter-owned syntax and validated table identifiers. Object types, JSON paths, filter values, limits and offsets are bound parameters.

## Persisted value layout

M70 introduced a lossless JSON envelope stored as validated `LONGTEXT`. A runtime attribute named `score` is represented conceptually as:

```json
{
  "format": 1,
  "value": {
    "kind": "object",
    "value": {
      "score": {
        "kind": "number",
        "value": 20
      }
    }
  }
}
```

M72 queries the envelope with `JSON_EXTRACT()` without converting storage to native MySQL `JSON`, so exact round-trip/member ordering guarantees remain unchanged.

## Safe predicate set

M72 pushes predicates only when SQL can preserve the current reference-adapter result exactly.

Supported pushdown operators:

- `eq`;
- `neq`;
- `in`;
- `notIn`;
- `isNull`;
- `isNotNull`.

Primitive equality covers:

- absent attributes and encoded `undefined`;
- `null`;
- booleans;
- strings using byte-exact comparison rather than the table's case-insensitive collation;
- finite JavaScript numbers using MySQL `DOUBLE` comparison;
- `NaN`, positive/negative infinity and negative zero through their canonical codec representation;
- `BigInt` through canonical decimal-string comparison.

Persisted objects, arrays and dates are detached at the storage boundary. `Object.is()` reference equality therefore cannot match a caller-owned reference; the compiler emits the corresponding constant predicate where appropriate.

## Partial pushdown

Filters are ANDed by the legacy `ObjectQuery` contract. M72 can push the safe subset even when other filters must remain residual.

Example:

```text
status eq "open"     -> MySQL
score gte 10         -> JavaScript residual
```

The SQL stage returns only rows satisfying the safe predicate. The decoded candidate set is then evaluated with the original full filter list, so SQL pushdown is candidate reduction rather than a replacement semantic engine.

## Pagination

`LIMIT`/`OFFSET` are pushed only when:

1. all filters are SQL-safe;
2. no attribute `orderBy` is requested;
3. supplied limit/offset values are non-negative safe integers.

Otherwise pagination remains after JavaScript filtering/sorting, preserving existing behavior.

## Why comparison/order pushdown is deferred

The current reference adapter implements comparison as:

- null/undefined ordering first;
- numeric arithmetic for number/number;
- `Date#getTime()` for Date/Date;
- `String(left).localeCompare(String(right))` otherwise.

JavaScript `localeCompare()` is locale/runtime-sensitive, while MySQL ordering is collation-sensitive. There is no general proof that the two produce the same ordering or range predicate result.

Therefore M72 deliberately leaves these operators residual:

- `gt`;
- `gte`;
- `lt`;
- `lte`;
- `contains`;
- `startsWith`;
- `endsWith`;
- attribute `orderBy`.

Broader SQL pushdown should follow a deterministic core comparison contract rather than embedding MySQL-specific semantics into MetaObject.

## Injection resistance

Table names continue through the strict identifier validator.

Attribute names are converted to JSON path strings and bound as prepared-statement parameters. They never appear directly in generated SQL text. This applies even to hostile attribute names containing quotes or SQL metacharacters.

## Diagnostics

`compileMySqlObjectQueryPlan(tableName, query)` is public from the MySQL adapter package and reports:

- prepared SQL;
- bound parameters;
- pushed filters;
- residual filters;
- whether pagination was pushed.

This is intended for tests, diagnostics and future query-plan observability.

## Verification

M72 CI retains all previous gates and adds:

- planner unit tests;
- hostile attribute-path parameterization checks;
- live equality/pagination pushdown;
- `IN` pushdown;
- null/undefined/missing equivalence;
- special-number equality;
- live residual range and string predicate fallback;
- the existing StorageAdapter and MetadataStore conformance suites against MySQL 8.4.
