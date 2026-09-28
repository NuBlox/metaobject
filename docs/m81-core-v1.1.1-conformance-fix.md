# M81 core v1.1.1 — persistence-portable query conformance

## Purpose

`@nublox/metaobject@1.1.0` introduced `runQueryComparisonConformance()` as the reusable differential proof gate for storage adapters that want to qualify deterministic comparison semantics.

The first production-adapter execution of that suite against the MySQL adapter exposed a portability defect in the conformance fixture itself: the shared dataset contained `new Date("invalid")`. The MySQL adapter intentionally rejects invalid `Date` values at the persistence boundary, so the suite failed during seeding before any query comparison could run.

## Correction

Core `1.1.1` keeps the deterministic comparison contract unchanged and makes only the conformance fixture persistence-portable:

- the invalid Date fixture is replaced with a valid persisted Date;
- the Date vector still proves deterministic Date ordering across persisted values;
- invalid-Date comparison behavior remains covered by the core comparison-policy unit tests;
- no `StorageAdapter` is required to persist invalid Dates in order to qualify query semantics.

## Compatibility

This is a patch-level conformance-harness correction. It does not change:

- `METAOBJECT_PUBLIC_API_VERSION`, which remains `"1"`;
- `legacy-js-v1` default behavior;
- `deterministic-codepoint-v1` comparison semantics;
- query or storage public types;
- the runtime acceptance rules of any storage adapter.

## Release gate

Before publication of `v1.1.1`:

1. core Node 20/22/24 CI must pass;
2. package and clean-consumer verification must pass;
3. existing MySQL 8.0/8.4 persistence/certification lanes must remain green;
4. the exact release commit must be tagged `v1.1.1` from `main`;
5. the tag-triggered trusted-publishing workflow must rerun `release:check` and publish under `latest`.

After publication, the MySQL 1.1 alignment branch can target core `1.1.1` and rerun the deterministic query-comparison suite against MySQL 8.0 and 8.4.
