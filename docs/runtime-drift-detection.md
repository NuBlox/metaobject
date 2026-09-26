# Runtime drift detection

M23 turns an M22 deployment attestation into a durable runtime baseline that can be checked later for unauthorized or out-of-band change.

## Baselines

A baseline may only be created from a non-failing deployment attestation. Registered probes inspect the completed deployment target and return deterministic fingerprints.

```ts
const probes = new RuntimeDeploymentDriftProbeRegistry()
  .register({
    id: "schema",
    async inspect() {
      return { fingerprint: "schema:v42" };
    },
  });

const baseline = await drift.createBaseline(
  "attestation-001",
  "baseline-001",
);
```

Baseline records are create-only and retain the exact deployment revision, target profile version and ordered probe fingerprints that were observed after a verified rollout.

## Assessments

```ts
const assessment = await drift.assess(
  "baseline-001",
  "assessment-2026-09-27",
);
```

Each baseline probe is run again and compared against its original fingerprint.

Check states are:

- `unchanged` — current fingerprint matches the baseline;
- `changed` — current fingerprint differs from the baseline;
- `unverifiable` — the probe is unavailable, missing or failed.

Overall outcomes are:

- `clean` — every baseline probe is unchanged;
- `warning` — nothing is known to have changed, but one or more probes are unverifiable;
- `drift` — at least one fingerprint changed, or the persisted deployment revision changed after baseline capture.

This prevents an unavailable probe from being reported as a clean system.

## Probe design

A probe should fingerprint a meaningful externally observable invariant, for example:

- physical database schema version or normalized schema hash;
- applied migration ledger;
- configured module/object-type versions;
- deployment artefact digest;
- critical configuration snapshot;
- external service version;
- policy/configuration checksum.

The core deliberately does not prescribe how a fingerprint is calculated. Database and application adapter packages own that logic.

## Immutability

Both baseline and assessment store contracts are create-only. Historical state observations are evidence and must not be edited in place. Production adapters should back these contracts with insert-only records and unique ids.

## Sequence

```text
M21 preflight policy gate
        ↓
M17/M18 governed execution
        ↓
M22 verified deployment attestation
        ↓
M23 immutable runtime baseline
        ↓
subsequent fingerprint assessments
        ↓
clean / warning / drift
```
