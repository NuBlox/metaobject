import assert from "node:assert/strict";
import test from "node:test";
import {
  DETERMINISTIC_CODEPOINT_V1_COMPARISON_SEMANTICS,
  compareDeterministicCodepointScalar,
  compareLegacyMetaQueryScalar,
  compareLegacyStorageScalar,
  compareMetaQueryScalar,
  compareStorageQueryScalar,
} from "../dist/index.js";

test("storage comparison preserves strict-equality NaN behaviour", () => {
  assert.equal(Number.isNaN(compareLegacyStorageScalar(Number.NaN, Number.NaN)), true);
  assert.equal(Object.is(compareLegacyStorageScalar(-0, 0), 0), true);
});

test("MetaQuery comparison preserves Object.is NaN behaviour", () => {
  assert.equal(compareLegacyMetaQueryScalar(Number.NaN, Number.NaN), 0);
  assert.equal(Object.is(compareLegacyMetaQueryScalar(-0, 0), -0), true);
});

test("legacy comparison preserves explicit null ordering", () => {
  assert.ok(compareLegacyMetaQueryScalar(null, "a", "first") < 0);
  assert.ok(compareLegacyMetaQueryScalar(null, "a", "last") > 0);
  assert.ok(compareLegacyStorageScalar(undefined, 1, "first") < 0);
  assert.ok(compareLegacyStorageScalar(undefined, 1, "last") > 0);
});

test("legacy comparison preserves numeric, boolean, Date and string ordering", () => {
  assert.ok(compareLegacyStorageScalar(2, 10) < 0);
  assert.ok(compareLegacyMetaQueryScalar(false, true) < 0);
  assert.ok(compareLegacyStorageScalar(new Date("2026-01-01T00:00:00Z"), new Date("2026-01-02T00:00:00Z")) < 0);
  assert.equal(
    Math.sign(compareLegacyStorageScalar("alpha", "beta")),
    Math.sign("alpha".localeCompare("beta")),
  );
});

test("deterministic comparison orders strings by Unicode code point", () => {
  assert.ok(compareDeterministicCodepointScalar("Z", "a") < 0);
  assert.ok(compareDeterministicCodepointScalar("a", "á") < 0);
  assert.ok(compareDeterministicCodepointScalar("á", "😀") < 0);
  assert.ok(compareDeterministicCodepointScalar("ab", "aba") < 0);
  assert.equal(compareDeterministicCodepointScalar("same", "same"), 0);
});

test("deterministic comparison has explicit numeric and Date special-value ordering", () => {
  assert.equal(compareDeterministicCodepointScalar(-0, 0), 0);
  assert.ok(compareDeterministicCodepointScalar(-Infinity, -10) < 0);
  assert.ok(compareDeterministicCodepointScalar(10, Infinity) < 0);
  assert.ok(compareDeterministicCodepointScalar(Infinity, Number.NaN) < 0);
  assert.equal(compareDeterministicCodepointScalar(Number.NaN, Number.NaN), 0);
  assert.ok(compareDeterministicCodepointScalar(
    new Date("2026-01-01T00:00:00Z"),
    new Date("invalid"),
  ) < 0);
});

test("deterministic comparison defines cross-type and null ordering", () => {
  assert.ok(compareDeterministicCodepointScalar(false, 0) < 0);
  assert.ok(compareDeterministicCodepointScalar(0, 0n) < 0);
  assert.ok(compareDeterministicCodepointScalar(0n, new Date(0)) < 0);
  assert.ok(compareDeterministicCodepointScalar(new Date(0), "0") < 0);
  assert.ok(compareDeterministicCodepointScalar(null, false, "first") < 0);
  assert.ok(compareDeterministicCodepointScalar(undefined, false, "last") > 0);
  assert.equal(compareDeterministicCodepointScalar(null, undefined), 0);
});

test("query comparison dispatch defaults to legacy and accepts deterministic opt-in", () => {
  assert.equal(
    compareStorageQueryScalar("Z", "a", DETERMINISTIC_CODEPOINT_V1_COMPARISON_SEMANTICS),
    -1,
  );
  assert.equal(
    compareMetaQueryScalar("Z", "a", DETERMINISTIC_CODEPOINT_V1_COMPARISON_SEMANTICS),
    -1,
  );
  assert.throws(
    () => compareMetaQueryScalar("a", "b", "unknown-semantics"),
    /Unsupported query comparison semantics/,
  );
});
