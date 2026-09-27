# Documentation index

This index groups the `@nublox/metaobject` documentation by architectural concern rather than milestone number.

## Start here

- `../README.md` — package overview, quick start, supported runtime and current release position.
- `architecture.md` — current architecture through M65.
- `end-to-end-examples.md` — representative workflows from metadata definition through trust verification.
- `public-api.md` — v1 public API compatibility boundary and stability rules.
- `storage-adapter-conformance.md` — executable persistence compatibility contract.
- `mysql-storage-m70-hardening.md` — MySQL persistence-boundary, codec and optimistic-concurrency hardening.
- `mysql-metadata-store.md` — M71 MySQL `MetadataStore`, transactional revisions and race/tamper handling.
- `mysql-query-m72-pushdown.md` — M72 prepared SQL translation, safe predicate pushdown and fallback boundaries.
- `mysql-schema-migrations.md` — M73 versioned physical-schema migrations, ledger integrity, locking and drift detection.
- `mysql-m74-certification.md` — M74 large-dataset equivalence, contention, rollback, pool-pressure and migration-stampede certification.
- `mysql-m75-release-qualification.md` — M75 clean external-consumer, Node matrix and MySQL 8.0/8.4 release qualification.
- `mysql-m76-publication-promotion.md` — M76 publication hardening, trusted-publishing preparation and stable-core promotion gate.
- `releasing.md` — supported Node versions, package verification and release procedure.
- `release-candidate-readiness.md` — finite RC gate and stable-promotion position.

## Metadata model and runtime

- `relationships.md`
- `inheritance-composition.md`
- `constraints-behaviors.md`
- `query-engine.md`
- `metadata-persistence.md`
- `mysql-metadata-store.md`
- `mysql-query-m72-pushdown.md`
- `mysql-schema-migrations.md`
- `mysql-m74-certification.md`
- `mysql-m75-release-qualification.md`
- `code-generation.md`
- `schema-evolution.md`
- `metadata-release-pipeline.md`

## Modules and runtime configuration

- `metadata-modules.md`
- `module-catalog.md`
- `transactional-module-release.md`
- `runtime-module-sets.md`
- runtime profile and runtime-profile-upgrade documentation

## Deployment, verification and drift

The runtime-control documentation covers persistent deployment execution, policy, journal integrity, post-deployment attestations, drift detection/remediation, closure integrity, posture and control cycles.

Key documents include:

- `runtime-deployment-execution.md`
- `runtime-deployment-attestations.md`
- `runtime-control-cycles.md`
- runtime drift/remediation/posture documents in this directory

## Fleet convergence

Fleet documentation covers runtime registry, reconciliation, durable convergence work, execution, dispatch, queue policy, fairness, reservations, handoff locking, cancellation and recovery resolution.

The individual `runtime-fleet-*` documents in this directory are authoritative for their corresponding public APIs and evidence formats.

## Recovery evidence and trust

The trust documentation progresses from recovery-chain attestation and deterministic evidence integrity through signatures, signer/quorum policy, policy snapshots/lifecycle, portable bundles, external anchors and M59–M62 external trust-root governance/rotation/chain resolution.

The individual `runtime-fleet-convergence-handoff-recovery-trust-*` documents are authoritative for those formats and verification rules.

## Release engineering

- `public-api.md` — compatibility generation and root-export policy.
- `storage-adapter-conformance.md` — adapter compatibility suite.
- `mysql-storage-m70-hardening.md` — production MySQL object-storage hardening evidence.
- `mysql-metadata-store.md` — production MySQL metadata persistence evidence.
- `mysql-query-m72-pushdown.md` — contract-preserving MySQL query translation evidence.
- `mysql-schema-migrations.md` — physical-schema migration/recovery/drift evidence.
- `mysql-m74-certification.md` — repeatable MySQL adapter certification, stress evidence and performance regression guardrails.
- `mysql-m75-release-qualification.md` — packed-package clean-consumer verification and supported MySQL-version qualification.
- `mysql-m76-publication-promotion.md` — protected npm publication, OIDC workflow preparation and v1 promotion criteria.
- `releasing.md` — package verification and clean-consumer checks.
- `../CHANGELOG.md` — release history and release-note convention.

## Scope boundary

Database-specific drivers/adapters, application-framework integration, NuBlox product UI and application-specific domain metadata remain outside the core `@nublox/metaobject` package. Database adapters may live as sibling npm packages in this repository while consuming only the core public contracts.
