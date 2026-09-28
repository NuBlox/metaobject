import assert from "node:assert/strict";
import test from "node:test";
import { createPool } from "@nublox/mysql/promise";
import {
  DETERMINISTIC_CODEPOINT_V1_COMPARISON_SEMANTICS,
  runQueryComparisonConformance,
} from "@nublox/metaobject";
import { MySqlStorageAdapter } from "../dist/index.js";

const configured = Boolean(process.env.MYSQL_HOST);

test("MySQL satisfies deterministic query comparison conformance", { skip: !configured }, async () => {
  const pool = createPool({
    host: process.env.MYSQL_HOST,
    port: Number(process.env.MYSQL_PORT ?? 3306),
    user: process.env.MYSQL_USER ?? "root",
    password: process.env.MYSQL_PASSWORD ?? "root",
    database: process.env.MYSQL_DATABASE ?? "metaobject_test",
    connectionLimit: 8,
    charset: "utf8mb4",
    timezone: "Z",
    supportBigNumbers: true,
    bigNumberStrings: true,
  });

  const tables = [];
  let sequence = 0;
  const createAdapter = async () => {
    const tableName = `metaobject_qcmp_${process.pid}_${sequence++}`;
    tables.push(tableName);
    const adapter = new MySqlStorageAdapter(pool, { tableName });
    await adapter.initialize();
    return adapter;
  };

  try {
    const report = await runQueryComparisonConformance({
      createAdapter,
      semanticsId: DETERMINISTIC_CODEPOINT_V1_COMPARISON_SEMANTICS,
    });

    assert.equal(report.contract, "QueryComparisonSemantics");
    assert.equal(report.semanticsId, DETERMINISTIC_CODEPOINT_V1_COMPARISON_SEMANTICS);
    assert.equal(report.checks.length, 6);
    assert.ok(report.checks.every((check) => check.passed));
  } finally {
    for (const tableName of tables) {
      await pool.query(`DROP TABLE IF EXISTS \`${tableName}\``);
    }
    await pool.end();
  }
});
