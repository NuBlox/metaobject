import assert from "node:assert/strict";
import test from "node:test";
import {
  compareLegacyMetaQueryScalar,
  compareLegacyStorageScalar,
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
