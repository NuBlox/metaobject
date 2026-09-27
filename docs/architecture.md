# Architecture

## Purpose

`@nublox/metaobject` is a standalone metadata-driven object kernel for TypeScript. It deliberately contains no ERP, tenant, construction, finance, HCM, UI or other application-domain concepts.

The package turns metadata into runtime object semantics and exposes database-neutral contracts for persistence, schema evolution, releases, runtime control, convergence, evidence and trust verification.

## Architectural layers

```text
Metadata definitions + type system
        |
        v
ObjectTypeRegistry + TypeRegistry
        |
        v
ObjectFactory + MetaObject + ObjectGraph
        |
        +--> validation / constraints / behaviours
        +--> relationships / inheritance / composition
        +--> change tracking / snapshots / lifecycle hooks
        |
        v
MetaObjectRepository + QueryEngine
        |
        +--> StorageAdapter
        |       +--> MemoryStorageAdapter
        |       +--> external MySQL/PostgreSQL/SQLite adapters
        |
        v
Metadata persistence + schema evolution
        |
        +--> MetadataStore / MetadataCatalog
        +--> semantic diff / migration planning
        +--> code generation
        |
        v
Modules + runtime profiles
        |
        +--> module catalogue / locked release manifests
        +--> module-set lockfiles
        +--> persistent runtime profiles
        |
        v
Governed deployment + verification
        |
        +--> deployment plans / execution / journal / policy
        +--> attestations / drift / remediation / posture
        |
        v
Fleet convergence + recovery
        |
        +--> reconciliation / work / execution / dispatch
        +--> fairness / reservation / handoff / recovery
        |
        v
Evidence integrity + trust
        |
        +--> canonical digests / signatures / trust policy
        +--> policy lifecycle / portable bundles / external anchors
        +--> trust-root snapshots / governance / rotation / chain resolution
```

## Core metadata and runtime

`ObjectTypeDefinition` is the source of truth for attributes, relationships, indexes, constraints, rules, operations, events and hooks. Literal TypeScript metadata can infer compile-time value/relationship types while metadata loaded at runtime is validated through the same registries.

`TypeRegistry` provides scalar type semantics. `ObjectTypeRegistry` resolves inheritance, validates object graphs and supplies concrete runtime definitions. `ObjectFactory`, `MetaObject` and `ObjectGraph` implement object creation, mutation, inheritance-aware relationships, composition, dirty tracking and object state.

## Persistence

Object persistence is abstracted by `StorageAdapter`. Metadata persistence is abstracted by `MetadataStore`. Both use optimistic concurrency and atomic batch contracts.

M64 makes those behaviours executable through reusable conformance suites:

- `runStorageAdapterConformance()`
- `runMetadataStoreConformance()`

External database adapters must satisfy those contracts in their own CI. Database drivers remain outside core.

## Querying

`ObjectQuery` is the compact storage-level query contract. `MetaQuery`, `QueryPlanner` and `QueryEngine` provide richer logical expressions, relationship traversal, projections, aggregation, ordering and cursor pagination without forcing SQL syntax into core.

## Metadata persistence and release

Metadata definitions normalize into database-ready rows and are persisted through versioned catalogue records. Schema changes are compared semantically and translated into database-neutral migration plans. Release coordination validates drafts, requires explicit approval for breaking work, invokes caller-provided migration executors and publishes exact metadata versions.

## Modules and exact runtime reconstruction

Metadata modules group exact object-type versions and version-ranged dependencies. Published module releases persist exact dependency locks. Runtime module-set lockfiles therefore reconstruct historical runtime graphs without silently drifting to newer compatible dependencies.

Runtime profiles persist exact module-set lockfiles for deployment and rollback reproducibility.

## Deployment, drift and posture

The runtime deployment subsystem turns profile upgrades into persistent, recoverable execution runs. External executors own physical side effects, while core governs:

- approvals and policy gates;
- idempotency/reconciliation contracts;
- append-only deployment journals;
- immutable post-deployment attestations;
- drift baselines and assessments;
- remediation plans/cases and closure verification;
- continuous runtime posture.

## Fleet convergence

Fleet capabilities keep desired state separate from observed trusted state. Reconciliation produces explicit recommendations, which become durable convergence work. Execution, bounded dispatch, queue policy, fairness, reservation, handoff locking, cancellation and manual recovery are separate layers so that no scheduler or worker can bypass the governed state machines beneath it.

## Evidence and trust

Recovery evidence progresses through deterministic integrity roots, external signatures, signer/quorum trust policy, immutable policy snapshots and lifecycle governance. Portable lifecycle bundles preserve exact historical verification material.

External bundle anchors deliberately stop recursive trust inside the package: root authorities are supplied out of band. M59–M62 then govern immutable trust-root snapshots, retirement/revocation, recoverable rotation and deterministic current-root chain resolution.

## Public API boundary

M63 defines the package root export (`@nublox/metaobject`) as the supported v1 compatibility boundary. Deep imports from `dist/**` are not public contracts. `METAOBJECT_PUBLIC_API_VERSION` identifies the compatibility generation.

## Release boundary

M65 validates the installable package itself, not only the repository build. CI covers Node.js 20, 22 and 24, verifies npm package contents and installs the generated tarball into a clean runtime/TypeScript consumer.

The package is licensed under Apache-2.0. Every distributable tarball must contain `LICENSE` and `NOTICE`, with copyright attribution to Stephen J T Spittal. Licensing permits redistribution subject to the Apache-2.0 terms; publication remains a separate deliberate release operation.

## Package boundaries

Core remains database- and application-agnostic. Intended external packages can include:

```text
@nublox/metaobject-storage-mysql
@nublox/metaobject-storage-postgresql
@nublox/metaobject-storage-sqlite
```

Dependency arrows point toward `@nublox/metaobject`. Core must not depend on database drivers, application frameworks, tenant models or product-specific domains.
