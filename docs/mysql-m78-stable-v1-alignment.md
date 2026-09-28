# M78 stable-v1 MySQL adapter alignment

M78 aligns `@nublox/metaobject-storage-mysql` with the published stable `@nublox/metaobject@1.0.0` contract after the core v1 release completed.

## Objective

The `0.7.0` adapter was intentionally qualified against `@nublox/metaobject@1.0.0-rc.1` while the stable core release was still pending. Stable `@nublox/metaobject@1.0.0` was subsequently published from the same v1 public-contract generation without a core runtime or declaration correction.

M78 therefore advances the adapter to `0.8.0` and replaces the exact RC dependency with exact stable `1.0.0` while retaining the existing adapter runtime and database semantics.

## Change boundary

M78 changes release/qualification material only:

- `@nublox/metaobject-storage-mysql` version `0.7.0` → `0.8.0`;
- `@nublox/metaobject` dependency `1.0.0-rc.1` → `1.0.0`;
- package verification now fails closed unless the stable dependency remains exact;
- the packed external-consumer gate verifies that npm actually resolved `@nublox/metaobject@1.0.0` before running runtime and TypeScript probes;
- documentation and release evidence are updated for the stable dependency.

M78 does **not** change:

- adapter `src/**` runtime code;
- public adapter exports or TypeScript declarations;
- object-storage schema version `2`;
- metadata-storage schema version `2`;
- lossless codec format;
- query-pushdown/fallback semantics;
- migration history or ledger format;
- optimistic-concurrency behaviour;
- the `@nublox/mysql@3.1.0-rc.1` dependency.

## Qualification gate

The initial M78 qualification revision `3f288d71d3ae4d39c223b2e47c0fbecdfe03df74` passed CI run `36363913734` / run number `259` across all eight existing release lanes:

- [x] core Node.js 20 check;
- [x] core Node.js 22 check;
- [x] core Node.js 24 check;
- [x] core package + clean consumer;
- [x] MySQL adapter packed clean consumer on Node.js 22;
- [x] MySQL adapter packed clean consumer on Node.js 24;
- [x] MySQL 8.0 persistence/conformance/M74 certification;
- [x] MySQL 8.4 persistence/conformance/M74 certification.

In addition, `packages/storage-mysql/scripts/verify-package.mjs` requires the exact stable core dependency and `verify-consumer.mjs` reads the installed `node_modules/@nublox/metaobject/package.json` to prove a clean consumer resolved exactly `1.0.0`.

## Publication boundary

M78 publication remains separate from merge qualification.

After the exact M78 `main` commit passes the full matrix:

1. create immutable tag `storage-mysql-v0.8.0` at that exact commit;
2. allow `.github/workflows/publish-storage-mysql.yml` to verify tag/version/main ancestry;
3. rerun the package `release:check` in the trusted-publishing job;
4. publish `@nublox/metaobject-storage-mysql@0.8.0` explicitly under npm `next`;
5. verify the registry reports version `0.8.0` and `next: 0.8.0`.

The workflow does not advance npm `latest`. Existing `0.7.0` remains immutable.

## Completion

The engineering/qualification portion of M78 is complete. Full milestone closure additionally requires merge to `main`, green post-merge qualification, successful trusted publication of `storage-mysql-v0.8.0`, and npm registry verification of the `next` release.
