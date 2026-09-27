import test from "node:test";
import assert from "node:assert/strict";

import {
  MemoryMetadataStore,
  MemoryStorageAdapter,
  runMetadataStoreConformance,
  runStorageAdapterConformance,
} from "../dist/index.js";

test("MemoryStorageAdapter satisfies StorageAdapter conformance", async () => {
  const report = await runStorageAdapterConformance({
    createAdapter: () => new MemoryStorageAdapter(),
  });

  assert.equal(report.contract, "StorageAdapter");
  assert.equal(report.checks.length, 7);
  assert.ok(report.checks.every((check) => check.passed));
});

test("MemoryMetadataStore satisfies MetadataStore conformance", async () => {
  const report = await runMetadataStoreConformance({
    createStore: () => new MemoryMetadataStore(),
  });

  assert.equal(report.contract, "MetadataStore");
  assert.equal(report.checks.length, 6);
  assert.ok(report.checks.every((check) => check.passed));
});
