# Runtime drift remediation

M24 turns an M23 drift assessment into a governed decision: accept an explicitly authorised divergence, remediate an unauthorised divergence through the existing M17/M18 deployment machinery, or stop for manual review when the evidence is incomplete or a safe repair cannot be derived.

## Classification

A `RuntimeDriftClassifierRegistry` associates a classifier with a drift probe id.

```ts
const classifiers = new RuntimeDriftClassifierRegistry()
  .register({
    probeId: "schema",
    classify: async ({ check }) => ({
      classification: check.currentFingerprint?.includes("approved")
        ? "authorized"
        : "unauthorized",
    }),
  });
```

Classifications are:

- `authorized` — the divergence is explicitly accepted; no repair is scheduled, but a new verified baseline is required;
- `unauthorized` — the divergence should be restored to the governed baseline;
- `unknown` — the system cannot determine whether the change is authorised and fails safe to manual review.

An unregistered or failing classifier is treated as `unknown`.

## Remediation handlers

Unauthorised drift is only executable when a registered handler can translate the probe-specific divergence into existing M16 deployment steps.

```ts
const handlers = new RuntimeDriftRemediationHandlerRegistry()
  .register({
    probeId: "schema",
    plan: async () => [{
      kind: "migrate-object-type",
      moduleId: "core",
      objectTypeId: "core.settings",
      fromVersion: 2,
      toVersion: 2,
      blocking: false,
      requiresManualReview: false,
      description: "Restore the governed schema fingerprint.",
    }],
  });
```

The core does not guess how to repair a fingerprint. Database and application adapters own that mapping.

## Plan outcomes

`RuntimeDriftRemediationCatalog.plan()` persists an immutable plan with one of four dispositions:

- `no-action` — assessment is clean;
- `accepted` — all observed divergence is authorised and should be re-attested/re-baselined;
- `remediate` — all unauthorised divergence has executable repair steps;
- `review` — one or more checks are unverifiable, unclassified or cannot be safely planned.

If any part of the assessment requires review, the catalog does not emit a partial execution plan. This prevents the runtime from repairing only the easy subset while leaving unresolved drift hidden behind a successful deployment.

## Reusing M17/M18 execution

Executable M24 plans contain a synthetic M16-compatible execution plan for the same runtime profile version. The source and target profile versions are identical because the goal is restoration, not schema evolution.

```ts
const plan = await remediation.plan(
  "assessment-2026-09-27",
  "remediation-2026-09-27",
);

const provider = new RuntimeDriftRemediationPlanProvider(
  remediationPlanStore,
  plan.remediationPlanId,
);

const deployments = new RuntimeDeploymentCatalog(
  deploymentStore,
  provider,
);

const repair = await deployments.create(
  "repair-deployment-001",
  plan.profileId,
  plan.profileVersion,
  plan.profileVersion,
);

await runner.run(repair.deploymentId);
```

This deliberately reuses the existing controls instead of creating a second repair engine:

```text
M23 drift assessment
        ↓
M24 classification
        ↓
M24 remediation planning
        ↓
M17 durable deployment state
        ↓
M21 policy gates
        ↓
M18 idempotent/reconciled executors
        ↓
M19/M20 immutable audit journal
        ↓
M22 attestation
        ↓
new M23 baseline
```

## Safety properties

- assessment and deployment revision must still match when the remediation plan is created;
- unverifiable drift is never auto-repaired;
- missing classifiers fail safe to review;
- missing/failing remediation handlers fail safe to review;
- malformed handler steps are rejected;
- plan records are create-only immutable evidence;
- authorised drift is not silently treated as clean; it requires a fresh attestation/baseline;
- M17/M18 retains approval, policy, idempotency, reconciliation and crash-recovery guarantees for repair execution.

## Evidence hardening included with M24

M24 also closes post-merge review findings in M21–M23:

- malformed/null policy evidence fails closed;
- unsupported policy outcomes cannot enter the append-only journal;
- verifier results cannot spoof registry verifier ids;
- attestation rechecks deployment snapshot identity after asynchronous verification;
- M23 rechecks deployment identity after baseline and assessment probes;
- empty drift assessments cannot be stored as `clean` evidence.
