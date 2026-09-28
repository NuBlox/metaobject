import assert from "node:assert/strict";
import test from "node:test";
import {
  DETERMINISTIC_CODEPOINT_V1_COMPARISON_SEMANTICS,
  MemoryStorageAdapter,
  runQueryComparisonConformance,
} from "../dist/index.js";

test("deterministic reference adapter passes query comparison conformance", async () => {
  const report = await runQueryComparisonConformance({
    createAdapter: () => new MemoryStorageAdapter(),
  });

  assert.equal(report.contract, "QueryComparisonSemantics");
  assert.equal(report.semanticsId, DETERMINISTIC_CODEPOINT_V1_COMPARISON_SEMANTICS);
  assert.equal(report.checks.length, 6);
  assert.ok(report.checks.every((check) => check.passed));
  assert.deepEqual(report.checks.map((check) => check.name), [
    "Unicode code-point ascending order",
    "Unicode code-point range predicate",
    "numeric ordering including infinities and NaN",
    "numeric range predicate",
    "Date ordering across persisted values",
    "ordered pagination",
  ]);
});

test("comparison conformance accepts an explicit reference adapter factory", async () => {
  const report = await runQueryComparisonConformance({
    createAdapter: () => new MemoryStorageAdapter(),
    createReferenceAdapter: () => new MemoryStorageAdapter(),
    semanticsId: DETERMINISTIC_CODEPOINT_V1_COMPARISON_SEMANTICS,
  });

  assert.equal(report.checks.length, 6);
});
