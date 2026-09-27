# Release engineering

## Supported Node.js versions

The v1 release-candidate line supports Node.js 20, 22 and 24. CI runs the complete typecheck/build/test gate on all three versions.

## Required release gate

Run:

```bash
npm install
npm run release:check
```

`release:check` executes the full package checks, validates the npm package manifest, installs the generated tarball into a clean consumer fixture, verifies ESM runtime imports and compiles TypeScript imports from the public package root.

## Package contents

The published/installable package is intentionally limited to:

- `package.json`;
- `README.md`;
- `LICENSE`;
- `NOTICE`;
- generated `dist/**` JavaScript and declarations.

Source, tests, internal docs, CI configuration and release scripts are not part of the package payload.

## Publication and licence status

`@nublox/metaobject` is licensed under the Apache License, Version 2.0 (`Apache-2.0`). Copyright © 2026 Stephen J T Spittal.

The licence text and attribution notice are distributed with every package tarball as `LICENSE` and `NOTICE`. The package verifier fails if either file is absent.

Applying the licence removes the previous licensing blocker for redistribution, but publication remains an explicit release action. Creating a Git tag, GitHub release or npm publication must still be performed deliberately from a verified release commit.

## Release notes

`CHANGELOG.md` is the canonical human-readable release history. Each release records externally observable additions, changes, removals, fixes and security changes as applicable.

## RC procedure

1. ensure `main` is green on every supported Node version;
2. run `npm run release:check` from a clean checkout;
3. verify `package.json` version and `Apache-2.0` licence metadata;
4. verify `LICENSE` and `NOTICE` are present in the generated package;
5. update `CHANGELOG.md`;
6. create the release tag from the verified `main` commit;
7. build the package from that exact tag/commit;
8. publish only as a deliberate release action.
