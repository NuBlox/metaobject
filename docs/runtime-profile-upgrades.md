# Runtime profile upgrade planning

M16 turns two exact M14 runtime-profile states into a deterministic deployment plan.

The planner does not re-resolve module ranges. It compares the frozen module-set lockfiles stored on the source and target profile versions, so planning is always based on the exact runtime schemas that were activated.

## Planning

```ts
const planner = new RuntimeProfileUpgradePlanner(
  runtimeProfiles,
  metadataCatalog,
);

const plan = await planner.plan("production", 3, 4);
```

Both profile versions must already be `active` or `deprecated`, must contain their exact lockfiles, and the target profile version must be greater than the source version.

Before producing the plan, both lockfiles are reconstructed through the runtime-profile catalogue. This validates the complete locked module/member graph and exact metadata versions.

## Output

`RuntimeProfileUpgradePlan` contains:

- exact source and target profile versions;
- module additions, removals, upgrades and downgrades;
- object-type additions, removals, upgrades, downgrades and ownership moves;
- semantic `SchemaDiff` values for forward object-type version changes;
- M8 `MigrationPlan` values for every forward schema change;
- deterministic deployment steps;
- overall compatibility impact;
- manual-review and blocking-step gates.

The portable plan format is:

```text
nublox-metaobject-runtime-profile-upgrade / v1
```

## Ordering

Target work follows the target lockfile's dependency-first module order.

```text
foundation module
  -> foundation object migrations
  -> dependent module
      -> dependent object migrations
```

Capability removals use the reverse source dependency order, so dependent capabilities and object types are removed before the modules they depend on.

This ordering is deterministic because M13 lockfiles already persist exact dependency-first module closures.

## Schema changes

When an object type exists in both profiles and the target version is newer, M16 loads the exact source and target metadata definitions and delegates to:

```text
diffObjectTypes()
      ↓
MigrationPlanner.plan()
```

This keeps profile deployment semantics aligned with the same schema-evolution rules used by the governed metadata release pipeline.

Examples:

- adding an optional attribute is normally compatible and produces a non-blocking metadata step;
- adding a required attribute with a default produces a blocking backfill step;
- removing an attribute produces a breaking diff and blocking manual review.

## Risk gates

M16 does not guess how to reverse data migrations.

Module or object-type downgrades therefore produce explicit blocking manual-review steps. Object-type and module removals are also breaking because data retention, archival and consumer compatibility must be decided by the deployment controller.

The overall plan exposes:

```ts
plan.impact
plan.requiresManualReview
plan.blockingStepCount
```

A higher-level deployment service can use those fields to require approvals and migration executors before changing the active runtime profile.

## Separation of responsibilities

M16 plans deployment; it does not execute it.

The core package remains database-neutral. A product or adapter layer should execute the nested migration plans, coordinate transactions/DDL, persist deployment state, and switch the application to the target profile only after every blocking step succeeds.

This produces the sequence:

```text
active runtime profile N
        ↓
M16 upgrade plan
        ↓
module/object migration execution
        ↓
validation + approvals
        ↓
activate deployment against profile N+1
```

A future deployment-orchestration layer can persist plan execution, retries, compensation and environment-specific rollout without adding tenant or environment concepts to `@nublox/metaobject`.
