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

The initial M78 qualification revision `3f288d71d3ae4d39c223b2e47c0fbecdfe03df74` passed CI run `36363913734` / run number `259` across all eight existing release lanes.

The final PR head `905776c3a3aa5dac805b5508c5c553269f4de4e3` then passed the same eight-lane gate in CI run `36364076380` / run number `261`, and the squash-merged `main` commit `e4852b17b037b0cc5954b84f98eec3cf17ef709b` passed the complete post-merge push gate in CI run `36364378662` / run number `262`.

The release lanes were:

- [x] core Node.js 20 check;
- [x] core Node.js 22 check;
- [x] core Node.js 24 check;
- [x] core package + clean consumer;
- [x] MySQL adapter packed clean consumer on Node.js 22;
- [x] MySQL adapter packed clean consumer on Node.js 24;
- [x] MySQL 8.0 persistence/conformance/M74 certification;
- [x] MySQL 8.4 persistence/conformance/M74 certification.

In addition, `packages/storage-mysql/scripts/verify-package.mjs` requires the exact stable core dependency and `verify-consumer.mjs` reads the installed `node_modules/@nublox/metaobject/package.json` to prove a clean consumer resolved exactly `1.0.0`.

## Trusted publication evidence

The immutable annotated tag `storage-mysql-v0.8.0` was created at exact commit:

```text
e4852b17b037b0cc5954b84f98eec3cf17ef709b
```

The tag-triggered `Publish MySQL storage adapter` workflow completed successfully in GitHub Actions run `36364723037` / run number `1`.

The workflow:

1. resolved `storage-mysql-v0.8.0` to the expected M78 `main` commit;
2. verified tag/version/main ancestry;
3. reran the complete `release:check` gate;
4. repacked and revalidated the clean external ESM/TypeScript consumer against exact stable `@nublox/metaobject@1.0.0`;
5. published `@nublox/metaobject-storage-mysql@0.8.0` with `npm publish --access public --tag next`;
6. emitted a signed GitHub Actions provenance statement and published it to the Sigstore transparency log at log index `2981039055`.

The publish output recorded:

```text
+nublox/metaobject-storage-mysql@0.8.0
```

with npm reporting successful publication of `@nublox/metaobject-storage-mysql@0.8.0` under `next`.

The workflow deliberately does not advance npm `latest`; `0.7.0` remains immutable.

## Completion

M78 is complete.

The adapter is aligned to stable `@nublox/metaobject@1.0.0`, qualified through the complete Node/MySQL matrix, merged to `main`, tagged immutably as `storage-mysql-v0.8.0`, and published successfully through npm trusted publishing with GitHub Actions provenance under the protected `next` dist-tag.
