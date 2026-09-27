# M36 — Runtime Fleet Convergence Dispatch

M36 provides an explicit, bounded dispatcher over M34 convergence work and the M35 executor framework.

It is intentionally **not** a scheduler or background service. Callers decide when a dispatch occurs.

## Responsibilities

M36 provides:

- deterministic queue selection;
- explicit `workIds` selection when required;
- optional action filtering;
- a `maxItems` bound per invocation;
- sequential calls into the M35 runner;
- per-work failure isolation;
- immutable fleet-level dispatch evidence;
- create-only dispatch IDs;
- detached reference-store reads.

## Dispatch outcomes

Each item is recorded as:

- `completed` — M35 returned completed work;
- `blocked` — M35 returned a governed blocked reason such as a missing executor, stale target or recovery requirement;
- `failed` — the individual runner invocation threw an unexpected error.

Fleet outcomes are:

- `completed` — every selected item completed, or the selected queue was empty;
- `partial` — at least one item blocked or failed while another item was not an unhandled failure;
- `failed` — every selected item failed unexpectedly.

One blocked or failed item does not suppress later items in the same dispatch.

## Selection

When `workIds` are omitted, M36 selects pending M34 work and orders it by:

1. `createdAt`;
2. `workId`.

An optional action filter can restrict the selected queue. `maxItems` defaults to 100 so one dispatch cannot process an unbounded fleet.

When explicit `workIds` are supplied, duplicate or unknown work IDs are rejected before any dispatch execution begins.

## Boundaries

M36 never:

- schedules itself;
- creates M33 reconciliation runs;
- creates M34 work items;
- changes M31 desired state;
- retries or recovers blocked M35 executions automatically;
- bypasses M16/M24/M29 governance.

Its responsibility is orchestration and immutable evidence only.

## Architecture

```text
M33 reconciliation
      ↓
M34 durable work queue
      ↓
M36 bounded dispatch
      ↓
M35 per-work runner
      ↓
M16 / M24 / M29 governed capability
      ↓
M36 immutable dispatch result
```
