# Runtime deployment attestations

M22 adds post-deployment verification and immutable attestations on top of the M17-M21 deployment pipeline.

A completed deployment proves that every governed execution step reached `completed`. It does not, by itself, prove that the target runtime state is actually observable in the external system. M22 closes that gap with ordered runtime verifiers and create-only attestation records.

## Verifier registry

```ts
const verifiers = new RuntimeDeploymentVerifierRegistry()
  .register({
    id: "schema-version",
    async verify({ deployment }) {
      return {
        outcome: "pass",
        evidence: {
          recordedAt: new Date().toISOString(),
          externalReference: `profile:${deployment.toProfileVersion}`,
        },
      };
    },
  });
```

Verifier outcomes are `pass`, `warn`, or `fail`. Warnings and failures require a message. Verifiers execute in registration order. Exceptions fail closed as a `fail` check and do not suppress later verifiers.

## Attestation

```ts
const attestations = new MemoryRuntimeDeploymentAttestationStore();
const catalog = new RuntimeDeploymentAttestationCatalog(
  deploymentStore,
  attestations,
  verifiers,
);

const attestation = await catalog.verify(
  "deployment-2026-09-26",
  "attestation-001",
);
```

Each attestation binds to:

- deployment id and exact persisted revision;
- runtime profile id;
- source and target profile versions;
- the final journal sequence observed during verification;
- every verifier outcome, message, external reference and evidence;
- one aggregate `pass` / `warn` / `fail` result.

Aggregate precedence is `fail > warn > pass`.

## Immutability

`RuntimeDeploymentAttestationStore` is deliberately create-only. There is no update or delete method in the core contract. The in-memory reference implementation rejects duplicate attestation ids and returns detached copies.

Production database adapters should enforce the same semantics with an insert-only attestation table and a unique attestation id.

## Concurrency

Verification reads a completed deployment, executes all verifiers, then reads the deployment again before creating the attestation. If the persisted deployment revision changed during verification, attestation creation fails with a concurrency error rather than binding evidence to a moving target.

## Responsibility boundary

M22 remains database- and application-neutral. A verifier may inspect a database schema, service health, migration ledger, object counts, checksums, external APIs or any other application-specific signal. The core only governs ordering, validation, fail-closed behavior, evidence retention and immutable attestation persistence.

## Deployment sequence

```text
M16 exact upgrade plan
        ↓
M17 durable deployment
        ↓
M18 executor framework
        ↓
M19/M20 immutable journal
        ↓
M21 policy gate
        ↓
completed deployment
        ↓
M22 ordered post-deployment verification
        ↓
immutable runtime attestation
```
