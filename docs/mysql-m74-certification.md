# M74 MySQL adapter certification and production-stress gate

M74 turns the MySQL adapter's accumulated M69-M73 behaviour into an explicit repeatable certification gate. The goal is not to claim that one GitHub Actions runner represents a production workload. The goal is to prove contract equivalence, transactional safety, contention behaviour, migration serialization and connection-pool hygiene under materially higher load than the focused conformance tests.

## Scope

M74 applies to `@nublox/metaobject-storage-mysql` version `0.6.0`, targeting:

- `@nublox/metaobject@1.0.0-rc.1`;
- `@nublox/mysql@3.1.0-rc.1`;
- Node.js 22 or newer;
- MySQL 8.x, with CI certification on MySQL 8.4.

The core `@nublox/metaobject` package remains database-neutral and unchanged at `1.0.0-rc.1`.

## Certification philosophy

The executable certification suite is `packages/storage-mysql/test/mysql-certification.test.mjs` and is run with:

```bash
npm run test:certification
```

It is additive to the existing unit, conformance, query, concurrency/tamper and migration suites. Passing M74 therefore means both the focused contract tests and the broader stress gate pass on the same adapter revision.

Timing limits in M74 are deliberately broad **regression guardrails**. They detect catastrophic performance degradation, runaway queueing, deadlocks that fail to resolve and accidentally quadratic behaviour. They are not production service-level objectives and must not be interpreted as capacity planning numbers.

## Gate 1 — large-dataset semantic equivalence

The suite creates a deterministic object corpus and writes the same snapshots to:

- the core `MemoryStorageAdapter`, which is the reference implementation of the public `StorageAdapter` query semantics;
- `MySqlStorageAdapter` backed by MySQL 8.4.

The default CI corpus is 1,200 objects. The query matrix covers:

- unfiltered pagination;
- offset + limit and offset-only pagination;
- `eq` and `neq`;
- `in` and `notIn`;
- `isNull` and `isNotNull`;
- explicit encoded `undefined`;
- `NaN` equality;
- range fallback with ordered pagination;
- `contains`, `startsWith` and `endsWith` fallback semantics;
- multiple simultaneous predicates.

For every query, the ordered object IDs returned by MySQL must exactly equal the reference adapter result. This simultaneously exercises SQL pushdown and residual JavaScript evaluation.

## Gate 2 — connection-pool pressure and leak detection

The default CI gate launches 400 concurrent object reads against a pool limited to four connections.

After the workload:

- every read must resolve to the expected object;
- `pool.healthCheck().ok` must remain `true`;
- the queue must drain to zero;
- active connections must return to zero;
- the pool must never report more total connections than its configured limit.

This is a bounded pressure test for acquisition/return behaviour. It is not a maximum-throughput benchmark.

## Gate 3 — high-contention optimistic concurrency

M74 launches 32 concurrent writers against the same persisted object version and separately against the same metadata revision.

The required invariant for each race is:

- exactly one writer commits;
- every loser fails with `ConcurrencyError`;
- object version / metadata revision advances exactly once;
- the stored winning value is the value returned by the sole successful writer;
- the pool remains healthy and drained after contention.

This expands the earlier pairwise race tests into a materially higher-contention certification scenario.

## Gate 4 — atomic rollback after partial batch progress

The suite seeds object and metadata collections and then deliberately submits transactional batches where many valid updates execute before a final stale optimistic-concurrency write.

The required result is total rollback:

- the batch rejects with `ConcurrencyError`;
- every valid object update executed before the stale write remains at its original version and value;
- every valid metadata update executed before the stale write remains at its original revision and status.

This proves the public atomic-batch contract survives failures after meaningful transactional work has already occurred.

## Gate 5 — migration stampede serialization

M74 launches 16 `MySqlStorageAdapter.initialize()` calls concurrently against the same previously absent target table while using a pool limited to six connections.

The migration stream must converge to:

```text
schema version 1 -> exactly one ledger row
schema version 2 -> exactly one ledger row
```

All initializers must complete successfully, the migration ledger must remain immutable/non-duplicated, and the connection pool must return to a healthy drained state.

This is the high-contention extension of the M73 two-initializer serialization test.

## Default CI guardrails

The current CI thresholds are:

| Workload | Default | Maximum elapsed time |
| --- | ---: | ---: |
| object dataset seed | 1,200 objects | 30 s |
| semantic query matrix | 16 queries | 15 s |
| pooled parallel reads | 400 reads / 4 connections | 15 s |
| object + metadata contention | 32 writers each | 20 s |
| migration stampede | 16 initializers / 6 connections | 20 s |

The thresholds can be overridden through `M74_*` environment variables for local investigation. CI pins the defaults explicitly so changes to test defaults cannot silently weaken the gate.

## First recorded CI evidence

The first complete M74 certification run executed on GitHub Actions Ubuntu 24.04 with Node.js 22.23.2 and MySQL 8.4.11. It passed every M69-M73 live gate plus all four M74 certification tests.

Observed M74 timings were:

| Evidence point | Observed |
| --- | ---: |
| 1,200-object MySQL seed | 554.5 ms |
| 16-query semantic matrix | 166.9 ms |
| 400 pooled reads / 4 connections | 96.2 ms |
| 32-way object + metadata contention | 38.8 ms |
| 16-initializer migration stampede | 99.5 ms |

The object race produced 31 `ConcurrencyError` losers and one winner; the metadata race did the same. The transactional rollback probes and migration-ledger uniqueness checks also passed. These measurements are retained as evidence of the tested revision, not as future latency promises.

## Machine-readable evidence

Each certification phase emits one line beginning with:

```text
M74_CERTIFICATION
```

followed by a JSON object containing workload size and observed elapsed time. This makes CI logs usable as lightweight historical evidence without coupling correctness to exact benchmark values.

## Commands

From `packages/storage-mysql` with a reachable MySQL database:

```bash
npm install
npm run check
npm run test:integration
npm run test:certification
```

To run all live MySQL gates in order:

```bash
npm run test:live
```

Required environment variables are the same as the M69-M73 integration suite:

```bash
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=...
MYSQL_DATABASE=metaobject_test
```

## Acceptance boundary

M74 certification demonstrates that this adapter revision preserves the MetaObject public persistence semantics and the documented concurrency/migration invariants under the defined stress workloads. It does not establish application-specific production capacity, latency SLOs, durability configuration, replication/failover behaviour or disaster-recovery objectives. Those must be validated in the environment in which the consuming application is deployed.
