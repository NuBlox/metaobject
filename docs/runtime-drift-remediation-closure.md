# Runtime drift remediation closure

M25 closes the loop started by M23 and M24. A remediation executor reporting `completed` is not sufficient evidence that drift was actually removed. Closure requires a second independent verification chain bound to the exact repair deployment snapshot.

## Durable remediation case

`RuntimeDriftRemediationCaseCatalog` creates a versioned case around one immutable executable M24 remediation plan.

```ts
const cases = new RuntimeDriftRemediationCaseCatalog(
  caseStore,
  remediationPlanStore,
  deploymentStore,
  attestationStore,
  baselineStore,
  assessmentStore,
);

let record = await cases.create(
  "case-2026-09-27-001",
  "remediation-2026-09-27-001",
);
```

Only M24 plans with `disposition: "remediate"` and an exact execution plan may create a remediation case.

## Lifecycle

```text
planned
   ↓ link exact repair deployment
deploying
   ↓ completed deployment + passing M22 attestation
verifying
   ↓ replacement M23 baseline + immediate clean assessment
closed
```

A case can also move to `review` when post-remediation evidence is insufficient or requires intervention.

The reference `MemoryRuntimeDriftRemediationCaseStore` provides optimistic revision concurrency. The immutable source identity of a case cannot be changed after creation.

## Exact repair deployment

The repair deployment must:

- target the same profile id and version as the M24 baseline;
- use the same profile version as both source and target because remediation restores state rather than evolving the profile;
- contain the exact immutable M24 execution plan.

```ts
record = await cases.linkDeployment(
  record.caseId,
  repairDeployment.deploymentId,
  record.revision,
);
```

A deployment containing a different repair description, step, object target or other execution-plan content is rejected.

## Post-remediation attestation

The repair deployment must finish through M17/M18 before attestation can be linked.

```ts
record = await cases.linkAttestation(
  record.caseId,
  attestation.attestationId,
  record.revision,
);
```

The attestation must be bound to the exact repair deployment revision/creation identity and to the same runtime profile.

A `pass` advances the case to `verifying`.

A `warn` or `fail` does **not** prove restoration and moves the case to `review` rather than allowing closure.

## Replacement baseline and clean assessment

After a passing M22 attestation, establish a new M23 baseline and immediately assess it.

The case closes only when:

1. the replacement baseline was created from the linked post-remediation attestation;
2. it is bound to the same exact repair deployment snapshot;
3. the closure assessment references that exact replacement baseline;
4. the assessment outcome is `clean`;
5. every closure check is `unchanged`;
6. the repair deployment is re-read immediately before closure and is still the same completed snapshot.

```ts
record = await cases.close(
  record.caseId,
  replacementBaseline.baselineId,
  closureAssessment.assessmentId,
  record.revision,
);
```

This final re-read closes the race between evidence retrieval and durable case closure.

## Why the extra verification matters

Without M25 the sequence could stop here:

```text
M24 repair plan
      ↓
M18 executor reports completed
      ↓
"fixed"
```

That proves an operation ran, not that the target invariant was restored.

M25 requires:

```text
M23 drift assessment
      ↓
M24 classified remediation plan
      ↓
M17/M18 governed repair deployment
      ↓
M22 passing post-repair attestation
      ↓
new M23 baseline
      ↓
immediate M23 clean assessment
      ↓
M25 CLOSED
```

The source assessment, source baseline, source deployment, immutable remediation plan, repair deployment, attestation, replacement baseline and closure assessment therefore form one traceable evidence chain.

## Adapter responsibilities

The core remains database/application neutral. Production adapters should persist remediation cases transactionally with optimistic revision checks. M22 verifiers and M23 probes remain responsible for inspecting real external state such as database schemas, migration ledgers, application configuration and service versions.
