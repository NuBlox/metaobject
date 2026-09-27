import assert from "node:assert/strict";
import test from "node:test";
import { createPool } from "@nublox/mysql/promise";
import { runStorageAdapterConformance } from "@nublox/metaobject";
import { MySqlStorageAdapter } from "../dist/index.js";

const configured = Boolean(process.env.MYSQL_HOST);

function snapshot(id, value = 1) {
  return {
    id,
    type: "conformance.race",
    schemaVersion: 1,
    version: 0,
    values: { value },
    relationships: {},
  };
}

test("MySqlStorageAdapter satisfies StorageAdapter conformance and M70 hardening", { skip: !configured }, async () => {
  const pool = createPool({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? "root",
    password: process.env.MYSQL_PASSWORD ?? "root",
    database: process.env.MYSQL_DATABASE ?? "metaobject_test",
    connectionLimit: 8,
    timezone: "Z",
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
  const tables = [];
  let sequence = 0;

  const createAdapter = async () => {
    const tableName = `metaobject_conformance_${process.pid}_${sequence++}`;
    tables.push(tableName);
    const adapter = new MySqlStorageAdapter(pool, { tableName });
    await adapter.initialize();
    return adapter;
  };

  try {
    const report = await runStorageAdapterConformance({ createAdapter });
    assert.equal(report.contract, "StorageAdapter");
    assert.equal(report.checks.length, 7);
    assert.ok(report.checks.every((check) => check.passed));

    const codecAdapter = await createAdapter();
    const persisted = await codecAdapter.insert({
      id: "lossless",
      type: "conformance.codec",
      schemaVersion: 1,
      version: 0,
      values: {
        date: new Date("2026-09-27T18:00:00.000Z"),
        bigint: 9007199254740993n,
        missing: undefined,
        nan: Number.NaN,
        positiveInfinity: Infinity,
        negativeInfinity: -Infinity,
        negativeZero: -0,
      },
      relationships: {},
    });
    const loaded = await codecAdapter.get(persisted);
    assert.ok(loaded);
    assert.ok(loaded.values.date instanceof Date);
    assert.equal(loaded.values.date.toISOString(), "2026-09-27T18:00:00.000Z");
    assert.equal(loaded.values.bigint, 9007199254740993n);
    assert.equal(Object.prototype.hasOwnProperty.call(loaded.values, "missing"), true);
    assert.equal(loaded.values.missing, undefined);
    assert.equal(Number.isNaN(loaded.values.nan), true);
    assert.equal(loaded.values.positiveInfinity, Infinity);
    assert.equal(loaded.values.negativeInfinity, -Infinity);
    assert.equal(Object.is(loaded.values.negativeZero, -0), true);

    const raceAdapter = await createAdapter();
    const raceBase = await raceAdapter.insert(snapshot("update-race"));
    const raceResults = await Promise.allSettled([
      raceAdapter.update({ ...raceBase, values: { value: "left" } }, raceBase.version),
      raceAdapter.update({ ...raceBase, values: { value: "right" } }, raceBase.version),
    ]);
    const raceFulfilled = raceResults.filter((result) => result.status === "fulfilled");
    const raceRejected = raceResults.filter((result) => result.status === "rejected");
    assert.equal(raceFulfilled.length, 1, "exactly one concurrent update must commit");
    assert.equal(raceRejected.length, 1, "exactly one concurrent update must lose optimistic concurrency");
    assert.equal(raceRejected[0].reason?.name, "ConcurrencyError");
    const raceCurrent = await raceAdapter.get(raceBase);
    assert.ok(raceCurrent);
    assert.equal(raceCurrent.version, 2);
    assert.ok(raceCurrent.values.value === "left" || raceCurrent.values.value === "right");

    const deleteBase = await raceAdapter.insert(snapshot("delete-update-race"));
    const [updateOutcome, deleteOutcome] = await Promise.allSettled([
      raceAdapter.update({ ...deleteBase, values: { value: "updated" } }, deleteBase.version),
      raceAdapter.delete(deleteBase, deleteBase.version),
    ]);
    assert.equal(
      [updateOutcome, deleteOutcome].filter((result) => result.status === "fulfilled").length,
      1,
      "update/delete race must have exactly one winner",
    );
    const rejectedOutcome = [updateOutcome, deleteOutcome].find((result) => result.status === "rejected");
    assert.ok(rejectedOutcome);
    assert.equal(rejectedOutcome.reason?.name, "ConcurrencyError");
    const afterDeleteRace = await raceAdapter.get(deleteBase);
    if (updateOutcome.status === "fulfilled") {
      assert.ok(afterDeleteRace);
      assert.equal(afterDeleteRace.version, 2);
      assert.equal(afterDeleteRace.values.value, "updated");
    } else {
      assert.equal(afterDeleteRace, null);
    }

    const tamperAdapter = await createAdapter();
    const validEmptyEnvelope = JSON.stringify({ format: 1, value: { kind: "object", value: {} } });
    const invalidDateEnvelope = JSON.stringify({
      format: 1,
      value: {
        kind: "object",
        value: { poisoned: { kind: "date", value: "not-a-date" } },
      },
    });
    await pool.execute(
      `INSERT INTO \`${tamperAdapter.tableName}\`
        (object_type, object_id, schema_version, version, values_json, relationships_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ["conformance.tamper", "bad-date", 1, 1, invalidDateEnvelope, validEmptyEnvelope],
    );
    await assert.rejects(
      () => tamperAdapter.get({ type: "conformance.tamper", id: "bad-date" }),
      /Invalid MySQL snapshot encoding/,
    );
  } finally {
    for (const tableName of tables) {
      await pool.query(`DROP TABLE IF EXISTS \`${tableName}\``);
    }
    await pool.end();
  }
});
