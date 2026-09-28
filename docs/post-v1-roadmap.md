# Post-v1 direction of travel

NuBlox MetaObject reached a stable core `1.0.0` and stable MySQL adapter `1.0.0`. The next phase should preserve those semantics while expanding database portability, query performance and production operability.

## Strategic sequence

### M81 — deterministic query semantics and adapter capability contract

Goal: define a public, backward-compatible contract that makes query comparison semantics explicit enough for adapters to declare what they can execute natively without observable drift.

Deliverables:

- public query comparison-policy types;
- a named legacy policy matching the stable-v1 JavaScript behaviour;
- an opt-in deterministic policy for backend-portable ordering/range semantics;
- adapter query-capability declarations;
- planner/compiler decisions based on semantic compatibility rather than backend-specific assumptions;
- conformance tests proving equivalent results between reference and adapter execution.

Existing stable-v1 behaviour remains the default. M81 must not silently change `localeCompare()`-based results for existing consumers.

### M82 — MySQL deterministic range/order pushdown

Goal: use the M81 contract to move eligible `gt`, `gte`, `lt`, `lte` and attribute ordering into MySQL only when the active comparison policy and database collation are proven equivalent.

Deliverables:

- typed numeric/date/string SQL projections;
- deterministic null ordering;
- attribute `ORDER BY` pushdown;
- pagination pushdown after compatible ordering;
- differential tests against the core reference engine on MySQL 8.0 and 8.4.

### M83 — PostgreSQL storage adapter foundation

Goal: prove that the core contracts are genuinely database-neutral by implementing a second production SQL adapter.

Deliverables mirror the successful MySQL path: runtime objects, MetadataStore, migrations, query compiler, conformance, clean consumer and CI qualification.

### M84 — SQLite storage adapter

Goal: provide an embedded/local adapter for desktop tools, tests, offline workflows and lightweight applications while preserving the same core contracts.

### M85 — observability and diagnostics contract

Goal: expose implementation-neutral diagnostics for query plans, residual work, migration state, retries, concurrency conflicts and adapter health without coupling applications to a specific database driver.

### M86 — performance and scale certification

Goal: establish reproducible benchmark/certification profiles for object counts, query shapes, metadata catalogue size, concurrent writers and migration workloads across supported adapters.

## Architectural rules for the post-v1 line

1. Stable-v1 observable semantics remain the compatibility baseline unless a consumer explicitly selects a new policy.
2. Database pushdown is an optimization, never a reason to return different results.
3. Capabilities are declared and testable; adapters must not infer unsupported semantics optimistically.
4. Core remains database-driver-free.
5. Every production adapter must pass shared conformance plus backend-specific live certification.
6. New databases should reuse the contracts proven by M81/M82 rather than duplicate query semantics independently.
7. Performance work follows semantic proof: correctness first, then pushdown, then scale.

## Immediate execution path

The next implementation milestone is M81. Its first increment introduces the comparison-policy and capability vocabulary without changing existing query results. Once that API is covered by core tests, the MySQL adapter can advertise only the subset it currently proves (`eq`, `neq`, membership, null predicates and eligible pagination). Later M82 work broadens that declaration as deterministic comparisons are implemented and certified.
