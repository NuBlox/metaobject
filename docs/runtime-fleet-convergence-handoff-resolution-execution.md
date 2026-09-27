# M46 — Handoff Resolution Execution Receipts

M46 makes execution of an M45 manual recovery resolution durable and crash-aware.

M45 already freezes the exact M42/M40 fencing snapshot used by an operator to choose `resume` or `cancel`. M46 adds a separate execution receipt **before** invoking that choice, so a process restart can determine whether nothing happened, the expected terminal state was reached, or the fencing state changed ambiguously.

## Lifecycle

```text
running
  ├── completed
  ├── failed
  └── uncertain
```

- `running` is persisted before M45 execution begins.
- `completed` records the observed terminal reservation state and outcome.
- `failed` means execution threw and the original fencing snapshot is still unchanged.
- `uncertain` means execution did not return successfully and distributed fencing evidence changed in a way that cannot be safely replayed automatically.

Terminal receipts are immutable.

## Receipt evidence

`RuntimeFleetHandoffResolutionExecutionRecord` records:

- execution ID
- M45 resolution ID
- source M44 recovery ID
- reservation ID
- chosen action and actor ID
- exact starting reservation revision
- exact starting M40 admission status/revision when present
- started timestamp
- final reservation status/revision
- final M40 status/revision when present
- terminal outcome or error
- finished timestamp

The reference store is `MemoryRuntimeFleetHandoffResolutionExecutionStore`.

## Run

```ts
const receipt = await executions.run({
  executionId: "execution-42",
  resolutionId: "resolution-42",
});
```

M46 first validates the M45 resolution against the current M42 reservation and M40 admission. It then persists a `running` receipt before invoking `RuntimeFleetHandoffRecoveryResolutionCatalog.execute()`.

## Crash recovery

`resume(executionId)` re-reads the M42/M40 state and applies fail-closed recovery rules:

### Expected terminal state exists

If a `resume` resolution has reached `consumed`, or a `cancel` resolution has reached `released`, M46 reconciles the lost response as `completed` without replaying M45.

### Starting snapshot is unchanged

If reservation and admission evidence are exactly unchanged from the persisted M46 start snapshot, retrying the same immutable M45 resolution is safe.

### Fencing evidence changed ambiguously

If state changed but did not reach the expected terminal reservation status, the receipt becomes `uncertain`.

```text
uncertain
   -> do not guess
   -> create a fresh M44 audit
   -> create a new M45 resolution if review is required
```

This covers cases such as an M40 admission appearing while a response was lost but the M41/M42 reservation was not yet finalized.

## Failure semantics

If M45 execution throws and the complete start snapshot remains unchanged, M46 records `failed`. A caller may make a new explicit execution attempt because there is no evidence that the distributed fencing state advanced.

If the expected terminal state is visible despite the thrown/lost response, M46 records `completed` instead of reporting a false failure.

## Boundary

M46 is database-neutral and caller-triggered. It does not add automatic polling, retries, worker processes, authentication, tenant concepts, or a database driver. Durable adapters can implement `RuntimeFleetHandoffResolutionExecutionStore` outside the core package.
