import assert from "node:assert/strict";
import test from "node:test";
import { createPool } from "@nublox/mysql/promise";
import { runStorageAdapterConformance } from "@nublox/metaobject";
import { MySqlStorageAdapter } from "../dist/index.js";

const configured = Boolean(process.env.MYSQL_HOST);

test("MySqlStorageAdapter satisfies StorageAdapter conformance", { skip: !configured }, async () => {
  const pool = createPool({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? "root",
    password: process.env.MYSQL_PASSWORD ?? "root",
    database: process.env.MYSQL_DATABASE ?? "metaobject_test",
    connectionLimit: 4,
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
    assert.equal(report.checks.length, 6);
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
  } finally {
    for (const tableName of tables) {
      await pool.query(`DROP TABLE IF EXISTS \`${tableName}\``);
    }
    await pool.end();
  }
});
