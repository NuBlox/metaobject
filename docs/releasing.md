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
- generated `dist/**` JavaScript and declarations.

Source, tests, internal docs, CI configuration and release scripts are not part of the package payload.

## Publication and licence status

The package remains `UNLICENSED` for the first release-candidate preparation cycle. This is an intentional status: repository access does not grant redistribution or reuse rights.

No public npm publication should occur while `license` remains `UNLICENSED` unless NuBlox explicitly decides that distribution posture is acceptable. The RC may still be tagged and validated from GitHub. A later public-package decision must update `package.json`, repository licence material and release notes together.

## Release notes

`CHANGELOG.md` is the canonical human-readable release history. Each release records externally observable additions, changes, removals, fixes and security changes as applicable.

## RC procedure

1. ensure `main` is green on every supported Node version;
2. run `npm run release:check` from a clean checkout;
3. verify `package.json` version and publication/licence status;
4. update `CHANGELOG.md`;
5. create the release tag from the verified `main` commit;
6. build the package from that exact tag/commit;
7. do not publish publicly unless the licence/publication decision permits it.
