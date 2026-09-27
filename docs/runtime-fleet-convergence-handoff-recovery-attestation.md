# M48 — Recovery Chain Attestation

M48 adds a create-only proof record for a completed handoff recovery chain.

It is deliberately read-only over the governed recovery pipeline. It does not resume, cancel, repair, retry or mutate any M40–M47 state. Its purpose is to prove that all immutable evidence still forms one coherent chain.

## Verified chain

M48 verifies:

```text
M44 recovery audit
      ↓
M45 manual review resolution
      ↓
M46 completed execution receipt
      ↓
M47 full immutable handoff identity
      ↓
terminal M42 reservation
      ↓
terminal M40 admission evidence
```

An attestation is persisted only if every link agrees.

## Requirements

The source M46 receipt must:

- be `completed`;
- contain a terminal `outcome`;
- contain the M47 `handoffIdentity` field;
- reference the exact M45 resolution and M44 recovery audit;
- record final M42/M40 evidence that still matches the immutable terminal records.

Legacy v0.46 receipts without M47 identity remain valid historical records but cannot receive a full M48 attestation.

## Chain checks

### M44 → M45

The M45 resolution must originate from the exact M44 `review` decision and match its frozen:

- reservation ID and revision;
- admission ID;
- dispatch ID;
- worker ID;
- handoff timestamp;
- observed M40 status/revision, when present.

### M45 → M46/M47

The completed execution must match the M45 resolution's:

- recovery and resolution IDs;
- reservation and admission IDs;
- action;
- actor;
- dispatch ID;
- worker ID;
- handoff timestamp.

### M46/M47 → terminal M42

The current immutable reservation must have:

- the expected terminal status (`consumed` for resume, `released` for cancel);
- the exact final revision recorded by M46;
- the same reservation/admission IDs;
- the exact M47 handoff identity, including ordered work identity.

### M46 → terminal M40

If M46 recorded final admission evidence, the current immutable M40 record must match its exact status and revision. If M46 recorded no final admission evidence, a later admission causes attestation to fail.

## Attestation record

`RuntimeFleetHandoffRecoveryChainAttestationRecord` stores:

- attestation ID;
- M44 recovery/policy identity;
- M45 resolution identity;
- M46 execution identity;
- reservation/admission IDs;
- action and actor;
- outcome;
- complete M47 handoff identity;
- final M42 status/revision;
- final M40 status/revision when present;
- verification timestamp.

Attestations are create-only. The reference store is `MemoryRuntimeFleetHandoffRecoveryChainAttestationStore`.

## Example

```ts
const attestations = new RuntimeFleetHandoffRecoveryChainAttestationCatalog(
  recoveryCatalog,
  resolutionCatalog,
  executionCatalog,
  reservationCatalog,
  fairDispatcher,
  new MemoryRuntimeFleetHandoffRecoveryChainAttestationStore(),
);

const proof = await attestations.attest({
  attestationId: "attestation-42",
  executionId: "execution-42",
});
```

If any chain element is missing, stale, mismatched, legacy-only or not terminal, no attestation is created.

## Boundary

M48 is database-neutral and does not provide cryptographic signing. A later adapter or package may sign/export the immutable attestation record without changing the core recovery semantics.
