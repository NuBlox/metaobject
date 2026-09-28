# @nublox/metaobject

A standalone, application-agnostic metadata-driven object model and runtime for TypeScript.

`@nublox/metaobject` turns metadata into runtime object semantics and provides database-neutral contracts for persistence, querying, schema evolution, governed releases, exact runtime reconstruction, deployment control, drift/remediation, fleet convergence and evidence/trust verification.

It deliberately contains no NuBlox product UI, tenant/business-domain model or database driver.

## Current status

**`v1.0.0` is the stable v1 release and is published on npm under the `latest` dist-tag.** The annotated `v1.0.0` tag resolves to commit `41a5f78c670ef9845fd19c12c8d9610d3da344c5`; the tag-triggered trusted-publishing workflow reran the full release gate and published `@nublox/metaobject@1.0.0` with GitHub Actions provenance.

Public API generation: `METAOBJECT_PUBLIC_API_VERSION === "1"`.

Supported Node.js versions: **20, 22 and 24**.

The package is licensed under the **Apache License, Version 2.0**. Copyright © 2026 Stephen J T Spittal.

## Quick start

```ts
import {
  MemoryStorageAdapter,
  MetaObjectRepository,
  ObjectFactory,
  ObjectTypeRegistry,
  Validator,
  createDefaultTypeRegistry,
  defineObjectType,
} from "@nublox/metaobject";

const types = createDefaultTypeRegistry();
const objects = new ObjectTypeRegistry(types);

const Person = defineObjectType({
  id: "example.person",
  name: "Person",
  version: 1,
  attributes: {
    firstName: { type: "string", required: true },
    age: { type: "integer" },
  },
} as const);

objects.register(Person);

const factory = new ObjectFactory(objects, types);
const repository = new MetaObjectRepository(
  new MemoryStorageAdapter(),
  factory,
  new Validator(),
);

const person = factory.create(Person, { firstName: "Stephen", age: 41 });
await repository.save(person);
```

## Architecture at a glance

```text
metadata + types
      |
      v
runtime objects / relationships / validation
      |
      v
repository + query engine
      |
      +--> StorageAdapter
      |
      v
metadata persistence / evolution / release
      |
      v
modules / lockfiles / runtime profiles
      |
      v
governed deployment / attestations / drift / posture
      |
      v
fleet reconciliation / convergence / recovery
      |
      v
integrity / signatures / trust policy / external trust roots
```

See [`docs/architecture.md`](docs/architecture.md) and [`docs/index.md`](docs/index.md).

## Implemented capability groups

### Metadata and runtime

- metadata definitions and compile-time inference;
- extensible attribute type registry;
- runtime type enforcement and validation;
- first-class relationships;
- inheritance, abstract/sealed types and composition;
- behaviour/constraint registries, computed attributes, operations, events and lifecycle hooks;
- dirty/change tracking, deterministic snapshots and optimistic concurrency.

### Query and persistence

- database-neutral `ObjectQuery` storage contract;
- richer `MetaQuery`, planning, traversal, projection, aggregation and cursor pagination;
- `StorageAdapter` and `MetadataStore` abstractions;
- normalized metadata persistence;
- atomic batch writes and optimistic revisions;
- reusable adapter-conformance suites.

### Code generation, evolution and release

- TypeScript interfaces/create-inputs/model wrappers;
- generated validators and JSON Schema;
- semantic schema diff and portable migration plans;
- governed metadata release pipeline with breaking/manual-review gates;
- adapter/application migration extension points.

### Modules and reproducible runtime configuration

- versioned metadata modules and dependency ranges;
- persistent module catalogue with locked historical manifests;
- transactional/recoverable module release;
- exact runtime module-set lockfiles;
- persistent runtime profiles and profile-upgrade planning.

### Deployment, verification and runtime posture

- persistent deployment runs and durable step leases;
- keyed/reconciled external executor contracts;
- append-only deployment journal;
- preflight policy gates;
- immutable post-deployment attestations;
- drift baselines/assessments;
- remediation planning and closure verification;
- continuous runtime posture and governed control cycles.

### Fleet convergence and recovery

- runtime registry and desired/observed separation;
- fleet control/reconciliation evidence;
- durable convergence work;
- executor, dispatch, queue-policy and fairness layers;
- reservation leases, non-expiring handoff locks and cancellation fences;
- explicit handoff recovery policy, manual resolution and execution receipts;
- recovery-chain attestation.

### Integrity and trust

- deterministic canonical recovery-evidence digests;
- externally supplied signature providers;
- signer/quorum trust policies;
- immutable policy snapshots and lifecycle integrity/signatures;
- portable historical lifecycle trust bundles;
- external bundle anchors;
- immutable external trust-root snapshots;
- root governance, recoverable rotation/supersession and authoritative chain resolution;
- adversarial replay/tamper coverage for the stable v1 trust boundary.

## Storage adapters

Core contains the `StorageAdapter`/`MetadataStore` contracts plus in-memory reference implementations. Database-specific adapters remain separate packages in the same repository unless there is a concrete reason to split them.

The MySQL adapter package lives at [`packages/storage-mysql`](packages/storage-mysql):

```text
@nublox/metaobject-storage-mysql
```

M69 established runtime-object persistence, M70 hardened the production persistence/concurrency boundary, M71 added transactional MySQL metadata persistence, M72 added contract-preserving MySQL query translation, M73 added versioned physical-schema migrations, M74 added executable MySQL certification and stress hardening, and M75 added clean external-consumer plus MySQL-version release qualification. SQL-safe equality, membership and null predicates plus eligible pagination are pushed through NuBloxSQL server-side prepared statements; range/string predicates and attribute ordering remain deterministic JavaScript fallbacks where the current core comparison contract cannot yet be proven equivalent to MySQL collation semantics. Physical object/metadata schemas use an append-only checksummed migration ledger, serialized initialization, legacy-v1 adoption, crash-recoverable reconciliation and structural drift detection. M74 certifies those behaviours with large-dataset reference equivalence, pool pressure, high-contention optimistic concurrency, transactional rollback and migration-stampede workloads. M75 packs the adapter and consumes it from a separate temporary project on Node.js 22/24 while the live certification suite runs against both MySQL 8.0 and 8.4. The published adapter version `0.7.0` remains pinned to the published `@nublox/metaobject@1.0.0-rc.1` contract; a later adapter release can deliberately move that dependency to stable v1. The core package remains MySQL-free.

Planned siblings remain:

```text
@nublox/metaobject-storage-postgresql
@nublox/metaobject-storage-sqlite
```

External implementations should run:

```ts
runStorageAdapterConformance(...)
runMetadataStoreConformance(...)
```

See [`docs/storage-adapter-conformance.md`](docs/storage-adapter-conformance.md), [`docs/mysql-storage-m70-hardening.md`](docs/mysql-storage-m70-hardening.md), [`docs/mysql-metadata-store.md`](docs/mysql-metadata-store.md), [`docs/mysql-query-m72-pushdown.md`](docs/mysql-query-m72-pushdown.md), [`docs/mysql-schema-migrations.md`](docs/mysql-schema-migrations.md), [`docs/mysql-m74-certification.md`](docs/mysql-m74-certification.md), [`docs/mysql-m75-release-qualification.md`](docs/mysql-m75-release-qualification.md), [`docs/mysql-m76-publication-promotion.md`](docs/mysql-m76-publication-promotion.md) and [`docs/m77-stable-v1-promotion.md`](docs/m77-stable-v1-promotion.md).

## Public API compatibility

The supported v1 compatibility boundary is the package root:

```ts
import { defineObjectType } from "@nublox/metaobject";
```

Deep imports from generated `dist/**` paths are not public contracts. Compatibility expectations and error semantics are documented in [`docs/public-api.md`](docs/public-api.md).

Stable v1 follows Semantic Versioning. Compatible additions are expected in minor releases, compatible fixes in patch releases, and intentional breaking public-contract changes require a new major version.

## End-to-end workflows

Representative workflows for metadata definition/persistence, module release/runtime reconstruction, runtime control, trust verification and adapter conformance are in [`docs/end-to-end-examples.md`](docs/end-to-end-examples.md).

## Development

```bash
npm install --package-lock=false
npm run check
```

Release verification:

```bash
npm run release:check
```

`release:check` runs the full test gate, validates npm package metadata and contents, builds a real tarball, installs it into a clean consumer and verifies both ESM runtime imports and TypeScript declarations. `prepublishOnly` reruns that gate before any `npm publish` operation.

CI executes the complete core typecheck/build/test gate on Node.js 20, 22 and 24. The MySQL adapter adds clean packed-consumer verification on Node.js 22 and 24, plus independent MySQL 8.0 and 8.4 live lanes covering public persistence conformance, M70/M71 race/tamper hardening, M72 query-pushdown/fallback equivalence, M73 migration install/upgrade/race/drift/ledger-integrity handling and the M74 large-dataset/contention/rollback/pool-pressure/migration-stampede certification gate.

## Release roadmap

- **M62 — Trust-root chain verification** ✅
- **M63 — Public API stabilization** ✅
- **M64 — Storage/adapter conformance** ✅
- **M65 — Release engineering** ✅
- **M66 — Documentation convergence** ✅
- **M67 — Adversarial hardening** ✅
- **M68 — `v1.0.0-rc.1`** ✅ published under `next`
- **M69 — MySQL storage-adapter foundation** ✅
- **M70 — Production persistence/concurrency hardening** ✅
- **M71 — MySQL MetadataStore persistence and transactional metadata revisions** ✅
- **M72 — MySQL query translation and safe SQL pushdown** ✅
- **M73 — Versioned MySQL physical-schema migrations and drift detection** ✅
- **M74 — MySQL adapter certification and production-stress hardening** ✅
- **M75 — MySQL adapter external-consumer and release qualification** ✅
- **M76 — Publication hardening and trusted-publishing preparation** ✅
- **M77 — `v1.0.0` stable promotion and publication** ✅

Stable v1 is tagged as `v1.0.0` and published to npm as `@nublox/metaobject@1.0.0` under `latest` through the trusted GitHub Actions release workflow. Release evidence is maintained in [`docs/release-candidate-readiness.md`](docs/release-candidate-readiness.md) and [`docs/m77-stable-v1-promotion.md`](docs/m77-stable-v1-promotion.md).

## Documentation

Use [`docs/index.md`](docs/index.md) as the documentation map.

## Licensing

`@nublox/metaobject` is licensed under the **Apache License, Version 2.0** (`Apache-2.0`). Copyright © 2026 Stephen J T Spittal.

The complete licence text is in [`LICENSE`](LICENSE), and package attribution is in [`NOTICE`](NOTICE). The Apache-2.0 licence grants broad rights to use, modify and redistribute the software subject to its terms, while Section 6 does not grant trademark rights beyond reasonable and customary use in describing the origin of the work.
