# M81 — Core v1.1.0 release

## Objective

Publish `@nublox/metaobject@1.1.0` as the first compatible stable-v1 minor release, carrying the M81 query-semantics and adapter-capability contracts into the public npm package without changing the v1 public API generation.

## Release contents

The `1.1.0` release adds:

- public query-pushdown capability declarations;
- named `legacy-js-v1` and `deterministic-codepoint-v1` comparison semantics;
- opt-in comparison semantics on `ObjectQuery` and `MetaQuery`;
- centralized legacy comparison helpers preserving existing edge behaviour;
- deterministic Unicode code-point scalar ordering;
- fail-closed comparison-semantics dispatch;
- reusable `runQueryComparisonConformance()` adapter qualification.

The release does **not** broaden MySQL native ordered pushdown. The MySQL package remains on published core `1.0.0` until this core release is publicly available and can be consumed by its independent clean-consumer qualification.

## Compatibility boundary

`METAOBJECT_PUBLIC_API_VERSION` remains:

```text
1
```

This is intentional. `1.1.0` adds compatible public capabilities under the existing stable-v1 package-root contract.

Existing callers that do not set `comparisonSemantics` continue to use `legacy-js-v1`. Existing third-party `StorageAdapter` implementations remain source-compatible because `queryPushdownCapabilities` is optional.

## Release identity

Package:

```text
@nublox/metaobject@1.1.0
```

Immutable release tag:

```text
v1.1.0
```

Stable npm dist-tag:

```text
latest
```

The tag-triggered `Publish MetaObject` workflow verifies that the Git tag exactly matches `package.json`, verifies the tagged commit is contained in `main`, installs dependencies, runs `npm run release:check`, and publishes with the semantic npm dist-tag through trusted publishing.

## Qualification gate

Before tagging, the exact release commit must pass:

```bash
npm install --package-lock=false
npm run release:check
```

Repository CI must additionally pass:

- core check on Node.js 20;
- core check on Node.js 22;
- core check on Node.js 24;
- packed package and clean external consumer;
- MySQL adapter clean consumer on Node.js 22;
- MySQL adapter clean consumer on Node.js 24;
- live MySQL 8.0 persistence/conformance/M74 certification;
- live MySQL 8.4 persistence/conformance/M74 certification.

The MySQL lanes remain important even though the adapter is still pinned to core `1.0.0`: they ensure the monorepo release preparation does not regress the already-published stable adapter while core advances independently.

## Publication boundary

The release is not complete merely because the release-preparation PR is merged.

Completion requires:

1. a green release-preparation commit merged to `main`;
2. annotated tag `v1.1.0` created from that exact green `main` commit;
3. tag pushed to GitHub;
4. trusted-publishing workflow succeeds;
5. npm reports `@nublox/metaobject@1.1.0` under `latest`;
6. provenance/publication evidence is recorded.

Only after public core `1.1.0` exists should the MySQL adapter advance its core dependency and consume the canonical M81 comparison/capability types and conformance suite.

## Completion evidence

- [x] M81 capability vocabulary merged and qualified;
- [x] stable-v1 comparison semantics centralized and regression-tested;
- [x] `deterministic-codepoint-v1` implemented as explicit opt-in;
- [x] reusable query-comparison conformance suite merged and qualified;
- [x] package version advanced to `1.1.0` on the release-preparation branch;
- [x] `1.1.0` changelog entry prepared;
- [ ] release-preparation PR CI passes;
- [ ] release-preparation PR is merged to `main`;
- [ ] `v1.1.0` is created from the exact green `main` commit;
- [ ] trusted npm publication succeeds;
- [ ] npm `latest` resolves to `@nublox/metaobject@1.1.0`;
- [ ] provenance and final publication evidence are recorded.
