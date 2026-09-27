import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_MYSQL_STORAGE_TABLE,
  MYSQL_STORAGE_SCHEMA_VERSION,
  MySqlStorageAdapter,
  createStorageTableSql,
  quoteSqlIdentifier,
  validateSqlIdentifier,
} from "../dist/index.js";

test("schema constants and DDL are deterministic", () => {
  assert.equal(MYSQL_STORAGE_SCHEMA_VERSION, 1);
  assert.equal(DEFAULT_MYSQL_STORAGE_TABLE, "metaobject_objects");
  const sql = createStorageTableSql();
  assert.match(sql, /CREATE TABLE IF NOT EXISTS `metaobject_objects`/);
  assert.match(sql, /PRIMARY KEY \(object_type, object_id\)/);
  assert.match(sql, /ENGINE=InnoDB/);
});

test("table identifiers are strictly constrained", () => {
  assert.equal(validateSqlIdentifier("metaobject_tenant_01"), "metaobject_tenant_01");
  assert.equal(quoteSqlIdentifier("metaobject_tenant_01"), "`metaobject_tenant_01`");
  assert.throws(() => validateSqlIdentifier("metaobject;DROP TABLE x"), /Invalid MySQL identifier/);
  assert.throws(() => new MySqlStorageAdapter({}, { tableName: "bad-name" }), /Invalid MySQL identifier/);
});
