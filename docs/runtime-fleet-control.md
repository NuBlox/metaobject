# M32 — Fleet control runs

M32 adds an explicit, caller-triggered batch orchestration layer over the M29 governed runtime control cycle and the M31 runtime registry.

## Purpose

A fleet control run executes one requested M29 cycle for each selected registered runtime and persists one immutable fleet-level result.

```text
Fleet control run
├── runtime A → M29 cycle → M31 registry observation
├── runtime B → M29 cycle → M31 registry observation
└── runtime C → isolated failure
```

One runtime failure never suppresses the remaining requested runtimes.

## Exact registry revisions

Each target request carries `expectedTargetRevision`. M32 checks that revision before starting M29. A stale writer is recorded as `registry-failed` and that runtime is not executed.

This keeps fleet orchestration compatible with M31 optimistic concurrency.

## Per-runtime outcomes

Target outcomes are:

- `completed` — M29 completed and M31 accepted the cycle observation;
- `cycle-failed` — M29 returned/raised a failed cycle outcome;
- `registry-failed` — target eligibility, revision, or post-cycle registry projection failed.

Fleet status is:

- `completed` when every target completed;
- `partial` when at least one completed and at least one failed;
- `failed` when no target completed.

## Failure isolation

Unknown, retired, or stale runtime targets are rejected individually. Other targets continue in deterministic request order.

A failed M29 cycle is still passed through the M31 registry so `lastControlCycle` can advance while the last trusted posture remains intact.

## Immutable history

`RuntimeFleetControlRunStore` is create-only. `MemoryRuntimeFleetControlRunStore` is the reference implementation and returns detached copies.

A fleet run records:

- fleet run id;
- started/completed timestamps;
- overall status;
- exact runtime/cycle ids;
- requested M31 revision;
- M29 cycle status when available;
- resulting M31 revision when successful;
- failure text when unsuccessful.

## Boundaries

M32 does not schedule recurring work, create runtime targets, choose baselines, generate ids, or execute deployment/remediation directly. Callers remain responsible for selecting runtimes and supplying the exact M29 cycle requests to run.
