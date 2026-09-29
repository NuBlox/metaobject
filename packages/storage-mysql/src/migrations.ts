import { createHash } from "node:crypto";
import { MetadataError } from "@nublox/metaobject";
import {
  DEFAULT_MYSQL_METADATA_TABLE,
  MYSQL_METADATA_SCHEMA_VERSION,
  MYSQL_METADATA_V2_INDEX,
  createMetadataTableV1Sql,
  createMetadataV2MigrationSql,
  createMetadataV3MigrationSql,
  validateMetadataTableName,
} from "./metadata-schema.js";
import {
  adaptMySqlPool,
  type MySqlConnectionExecutor,
  type MySqlPoolExecutor,
  type NativeMySqlPool,
} from "./nublox-mysql-runtime.js";
import {
  DEFAULT_MYSQL_STORAGE_TABLE,
  MYSQL_IDENTITY_COLLATION,
  MYSQL_STORAGE_SCHEMA_VERSION,
  MYSQL_STORAGE_V2_INDEX,
  createStorageTableV1Sql,
  createStorageV2MigrationSql,
  createStorageV3MigrationSql,
  quoteSqlIdentifier,
  validateSqlIdentifier,
} from "./schema.js";

export const DEFAULT_MYSQL_MIGRATION_TABLE = "metaobject_schema_migrations";
export const DEFAULT_MYSQL_MIGRATION_LOCK_TIMEOUT_SECONDS = 30;

export type MySqlSchemaComponent = "storage" | "metadata";

export interface MySqlSchemaMigrationOptions {
  readonly migrationTableName?: string;
  readonly lockTimeoutSeconds?: number;
}

export interface MySqlSchemaMigrationReport {
  readonly component: MySqlSchemaComponent;
  readonly targetTable: string;
  readonly migrationTable: string;
  readonly schemaVersion: number;
  readonly appliedVersions: readonly number[];
  readonly adoptedVersions: readonly number[];
}

interface ColumnSpec {
  readonly name: string;
  readonly type: string;
  readonly nullable: "YES" | "NO";
  readonly collation?: string;
}

interface IndexSpec {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
}

interface ColumnRow extends Record<string, unknown> {
  COLUMN_NAME: string;
  COLUMN_TYPE: string;
  IS_NULLABLE: "YES" | "NO";
  COLLATION_NAME: string | null;
}

interface IndexRow extends Record<string, unknown> {
  INDEX_NAME: string;
  NON_UNIQUE: number | string;
  SEQ_IN_INDEX: number | string;
  COLUMN_NAME: string;
}

interface TableRow extends Record<string, unknown> {
  ENGINE: string;
  TABLE_COLLATION: string;
}

interface MigrationRow extends Record<string, unknown> {
  schema_version: number | string;
  migration_id: string;
  checksum: string;
}

interface LockRow extends Record<string, unknown> {
  acquired?: number | string | null;
  released?: number | string | null;
}

interface DatabaseRow extends Record<string, unknown> {
  database_name: string | null;
}

interface MigrationDefinition {
  readonly version: number;
  readonly id: string;
  readonly checksumSource: string;
  isSatisfied(connection: MySqlConnectionExecutor, tableName: string): Promise<boolean>;
  apply(connection: MySqlConnectionExecutor, tableName: string): Promise<void>;
  diagnose(connection: MySqlConnectionExecutor, tableName: string): Promise<readonly string[]>;
}

interface MigrationPlan {
  readonly component: MySqlSchemaComponent;
  readonly currentVersion: number;
  readonly migrations: readonly MigrationDefinition[];
  diagnoseFinal(connection: MySqlConnectionExecutor, tableName: string): Promise<readonly string[]>;
}

const STORAGE_V1_COLUMNS: readonly ColumnSpec[] = [
  { name: "object_type", type: "varchar(255)", nullable: "NO" },
  { name: "object_id", type: "varchar(255)", nullable: "NO" },
  { name: "schema_version", type: "int unsigned", nullable: "NO" },
  { name: "version", type: "bigint unsigned", nullable: "NO" },
  { name: "values_json", type: "longtext", nullable: "NO" },
  { name: "relationships_json", type: "longtext", nullable: "NO" },
  { name: "created_at", type: "timestamp(6)", nullable: "NO" },
  { name: "updated_at", type: "timestamp(6)", nullable: "NO" },
];

const STORAGE_V3_COLUMNS: readonly ColumnSpec[] = STORAGE_V1_COLUMNS.map((column) =>
  column.name === "object_type" || column.name === "object_id"
    ? { ...column, collation: MYSQL_IDENTITY_COLLATION }
    : column,
);

const STORAGE_V1_INDEXES: readonly IndexSpec[] = [
  { name: "PRIMARY", columns: ["object_type", "object_id"], unique: true },
  { name: "idx_metaobject_type", columns: ["object_type"], unique: false },
];

const STORAGE_V2_INDEXES: readonly IndexSpec[] = [
  ...STORAGE_V1_INDEXES,
  {
    name: MYSQL_STORAGE_V2_INDEX,
    columns: ["object_type", "schema_version", "object_id"],
    unique: false,
  },
];

const METADATA_V1_COLUMNS: readonly ColumnSpec[] = [
  { name: "object_type_id", type: "varchar(255)", nullable: "NO" },
  { name: "object_type_version", type: "int unsigned", nullable: "NO" },
  { name: "status", type: "varchar(16)", nullable: "NO" },
  { name: "revision", type: "bigint unsigned", nullable: "NO" },
  { name: "snapshot_json", type: "longtext", nullable: "NO" },
  { name: "created_at", type: "varchar(64)", nullable: "NO" },
  { name: "updated_at", type: "varchar(64)", nullable: "NO" },
];

const METADATA_V3_COLUMNS: readonly ColumnSpec[] = METADATA_V1_COLUMNS.map((column) =>
  column.name === "object_type_id"
    ? { ...column, collation: MYSQL_IDENTITY_COLLATION }
    : column,
);

const METADATA_V1_INDEXES: readonly IndexSpec[] = [
  { name: "PRIMARY", columns: ["object_type_id", "object_type_version"], unique: true },
  {
    name: "idx_metaobject_metadata_status",
    columns: ["status", "object_type_id", "object_type_version"],
    unique: false,
  },
];

const METADATA_V2_INDEXES: readonly IndexSpec[] = [
  ...METADATA_V1_INDEXES,
  {
    name: MYSQL_METADATA_V2_INDEX,
    columns: ["object_type_id", "status", "object_type_version"],
    unique: false,
  },
];

const LEDGER_COLUMNS: readonly ColumnSpec[] = [
  { name: "component", type: "varchar(32)", nullable: "NO" },
  { name: "target_table", type: "varchar(64)", nullable: "NO" },
  { name: "schema_version", type: "int unsigned", nullable: "NO" },
  { name: "migration_id", type: "varchar(128)", nullable: "NO" },
  { name: "checksum", type: "char(64)", nullable: "NO" },
  { name: "applied_at", type: "timestamp(6)", nullable: "NO" },
];

const LEDGER_INDEXES: readonly IndexSpec[] = [
  { name: "PRIMARY", columns: ["component", "target_table", "schema_version"], unique: true },
];

function migrationChecksum(plan: MySqlSchemaComponent, migration: MigrationDefinition): string {
  return createHash("sha256")
    .update(`${plan}\n${migration.version}\n${migration.id}\n${migration.checksumSource}`, "utf8")
    .digest("hex");
}

function createMigrationTableSql(tableName = DEFAULT_MYSQL_MIGRATION_TABLE): string {
  const table = quoteSqlIdentifier(tableName);
  return `CREATE TABLE IF NOT EXISTS ${table} (
    component VARCHAR(32) NOT NULL,
    target_table VARCHAR(64) NOT NULL,
    schema_version INT UNSIGNED NOT NULL,
    migration_id VARCHAR(128) NOT NULL,
    checksum CHAR(64) NOT NULL,
    applied_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    PRIMARY KEY (component, target_table, schema_version),
    CHECK (schema_version > 0)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
}

function asNonNegativeInteger(value: number | string, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new MetadataError(`MySQL returned invalid ${field} '${String(value)}'.`);
  }
  return parsed;
}

function sameColumns(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

async function tableExists(connection: MySqlConnectionExecutor, tableName: string): Promise<boolean> {
  const [rows] = await connection.execute<Array<Record<string, unknown>>>(
    `SELECT TABLE_NAME
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [tableName],
  );
  return rows.length === 1;
}

async function requiredTableIssues(
  connection: MySqlConnectionExecutor,
  tableName: string,
  columns: readonly ColumnSpec[],
  indexes: readonly IndexSpec[],
): Promise<readonly string[]> {
  if (!(await tableExists(connection, tableName))) return ["table is missing"];

  const issues: string[] = [];
  const [tableRows] = await connection.execute<TableRow[]>(
    `SELECT ENGINE, TABLE_COLLATION
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [tableName],
  );
  const tableRow = tableRows[0];
  if (!tableRow || String(tableRow.ENGINE).toLowerCase() !== "innodb") {
    issues.push(`expected InnoDB engine, found '${String(tableRow?.ENGINE)}'`);
  }
  if (!tableRow || String(tableRow.TABLE_COLLATION).toLowerCase() !== "utf8mb4_unicode_ci") {
    issues.push(`expected utf8mb4_unicode_ci collation, found '${String(tableRow?.TABLE_COLLATION)}'`);
  }

  const [columnRows] = await connection.execute<ColumnRow[]>(
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLLATION_NAME
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      ORDER BY ORDINAL_POSITION`,
    [tableName],
  );
  const actualColumns = new Map(columnRows.map((row) => [String(row.COLUMN_NAME), row] as const));
  for (const expected of columns) {
    const actual = actualColumns.get(expected.name);
    if (!actual) {
      issues.push(`missing column '${expected.name}'`);
      continue;
    }
    if (String(actual.COLUMN_TYPE).toLowerCase() !== expected.type) {
      issues.push(`column '${expected.name}' type is '${String(actual.COLUMN_TYPE)}', expected '${expected.type}'`);
    }
    if (String(actual.IS_NULLABLE).toUpperCase() !== expected.nullable) {
      issues.push(`column '${expected.name}' nullable is '${String(actual.IS_NULLABLE)}', expected '${expected.nullable}'`);
    }
    if (expected.collation !== undefined && String(actual.COLLATION_NAME).toLowerCase() !== expected.collation.toLowerCase()) {
      issues.push(`column '${expected.name}' collation is '${String(actual.COLLATION_NAME)}', expected '${expected.collation}'`);
    }
  }

  const [indexRows] = await connection.execute<IndexRow[]>(
    `SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?
      ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    [tableName],
  );
  const actualIndexes = new Map<string, { columns: string[]; unique: boolean }>();
  for (const row of indexRows) {
    const name = String(row.INDEX_NAME);
    const state = actualIndexes.get(name) ?? {
      columns: [],
      unique: asNonNegativeInteger(row.NON_UNIQUE, `index '${name}' NON_UNIQUE`) === 0,
    };
    state.columns.push(String(row.COLUMN_NAME));
    actualIndexes.set(name, state);
  }
  for (const expected of indexes) {
    const actual = actualIndexes.get(expected.name);
    if (!actual) {
      issues.push(`missing index '${expected.name}'`);
      continue;
    }
    if (actual.unique !== expected.unique || !sameColumns(actual.columns, expected.columns)) {
      issues.push(`index '${expected.name}' is (${actual.columns.join(", ")}) unique=${String(actual.unique)}, expected (${expected.columns.join(", ")}) unique=${String(expected.unique)}`);
    }
  }
  return issues;
}

async function indexExists(connection: MySqlConnectionExecutor, tableName: string, indexName: string): Promise<boolean> {
  const [rows] = await connection.execute<Array<Record<string, unknown>>>(
    `SELECT INDEX_NAME
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?
      LIMIT 1`,
    [tableName, indexName],
  );
  return rows.length > 0;
}

const storageV1Issues = (connection: MySqlConnectionExecutor, tableName: string): Promise<readonly string[]> =>
  requiredTableIssues(connection, tableName, STORAGE_V1_COLUMNS, STORAGE_V1_INDEXES);
const storageV2Issues = (connection: MySqlConnectionExecutor, tableName: string): Promise<readonly string[]> =>
  requiredTableIssues(connection, tableName, STORAGE_V1_COLUMNS, STORAGE_V2_INDEXES);
const storageV3Issues = (connection: MySqlConnectionExecutor, tableName: string): Promise<readonly string[]> =>
  requiredTableIssues(connection, tableName, STORAGE_V3_COLUMNS, STORAGE_V2_INDEXES);
const metadataV1Issues = (connection: MySqlConnectionExecutor, tableName: string): Promise<readonly string[]> =>
  requiredTableIssues(connection, tableName, METADATA_V1_COLUMNS, METADATA_V1_INDEXES);
const metadataV2Issues = (connection: MySqlConnectionExecutor, tableName: string): Promise<readonly string[]> =>
  requiredTableIssues(connection, tableName, METADATA_V1_COLUMNS, METADATA_V2_INDEXES);
const metadataV3Issues = (connection: MySqlConnectionExecutor, tableName: string): Promise<readonly string[]> =>
  requiredTableIssues(connection, tableName, METADATA_V3_COLUMNS, METADATA_V2_INDEXES);

const STORAGE_MIGRATIONS: readonly MigrationDefinition[] = [
  {
    version: 1,
    id: "storage-0001-baseline",
    checksumSource: createStorageTableV1Sql("metaobject_migration_target"),
    isSatisfied: async (connection, tableName) => (await storageV1Issues(connection, tableName)).length === 0,
    apply: async (connection, tableName) => {
      if (!(await tableExists(connection, tableName))) await connection.query(createStorageTableV1Sql(tableName));
    },
    diagnose: storageV1Issues,
  },
  {
    version: 2,
    id: "storage-0002-type-schema-index",
    checksumSource: createStorageV2MigrationSql("metaobject_migration_target"),
    isSatisfied: async (connection, tableName) => (await storageV2Issues(connection, tableName)).length === 0,
    apply: async (connection, tableName) => {
      if (!(await indexExists(connection, tableName, MYSQL_STORAGE_V2_INDEX))) await connection.query(createStorageV2MigrationSql(tableName));
    },
    diagnose: storageV2Issues,
  },
  {
    version: 3,
    id: "storage-0003-exact-identity-collation",
    checksumSource: createStorageV3MigrationSql("metaobject_migration_target"),
    isSatisfied: async (connection, tableName) => (await storageV3Issues(connection, tableName)).length === 0,
    apply: async (connection, tableName) => { await connection.query(createStorageV3MigrationSql(tableName)); },
    diagnose: storageV3Issues,
  },
];

const METADATA_MIGRATIONS: readonly MigrationDefinition[] = [
  {
    version: 1,
    id: "metadata-0001-baseline",
    checksumSource: createMetadataTableV1Sql("metaobject_migration_target"),
    isSatisfied: async (connection, tableName) => (await metadataV1Issues(connection, tableName)).length === 0,
    apply: async (connection, tableName) => {
      if (!(await tableExists(connection, tableName))) await connection.query(createMetadataTableV1Sql(tableName));
    },
    diagnose: metadataV1Issues,
  },
  {
    version: 2,
    id: "metadata-0002-type-status-index",
    checksumSource: createMetadataV2MigrationSql("metaobject_migration_target"),
    isSatisfied: async (connection, tableName) => (await metadataV2Issues(connection, tableName)).length === 0,
    apply: async (connection, tableName) => {
      if (!(await indexExists(connection, tableName, MYSQL_METADATA_V2_INDEX))) await connection.query(createMetadataV2MigrationSql(tableName));
    },
    diagnose: metadataV2Issues,
  },
  {
    version: 3,
    id: "metadata-0003-exact-identity-collation",
    checksumSource: createMetadataV3MigrationSql("metaobject_migration_target"),
    isSatisfied: async (connection, tableName) => (await metadataV3Issues(connection, tableName)).length === 0,
    apply: async (connection, tableName) => { await connection.query(createMetadataV3MigrationSql(tableName)); },
    diagnose: metadataV3Issues,
  },
];

const STORAGE_PLAN: MigrationPlan = {
  component: "storage",
  currentVersion: MYSQL_STORAGE_SCHEMA_VERSION,
  migrations: STORAGE_MIGRATIONS,
  diagnoseFinal: storageV3Issues,
};
const METADATA_PLAN: MigrationPlan = {
  component: "metadata",
  currentVersion: MYSQL_METADATA_SCHEMA_VERSION,
  migrations: METADATA_MIGRATIONS,
  diagnoseFinal: metadataV3Issues,
};

function validatePlan(plan: MigrationPlan): void {
  if (plan.migrations.length !== plan.currentVersion) {
    throw new MetadataError(`Invalid ${plan.component} migration plan: expected ${plan.currentVersion} migrations, found ${plan.migrations.length}.`);
  }
  plan.migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new MetadataError(`Invalid ${plan.component} migration plan: version ${migration.version} is not contiguous at position ${index + 1}.`);
    }
  });
}

function validateOptions(options: MySqlSchemaMigrationOptions): { migrationTableName: string; lockTimeoutSeconds: number } {
  const migrationTableName = validateSqlIdentifier(options.migrationTableName ?? DEFAULT_MYSQL_MIGRATION_TABLE);
  const lockTimeoutSeconds = options.lockTimeoutSeconds ?? DEFAULT_MYSQL_MIGRATION_LOCK_TIMEOUT_SECONDS;
  if (!Number.isFinite(lockTimeoutSeconds) || lockTimeoutSeconds < 0 || lockTimeoutSeconds > 3600) {
    throw new MetadataError("MySQL migration lockTimeoutSeconds must be between 0 and 3600.");
  }
  return { migrationTableName, lockTimeoutSeconds };
}

async function verifyLedgerTable(connection: MySqlConnectionExecutor, migrationTableName: string): Promise<void> {
  const issues = await requiredTableIssues(connection, migrationTableName, LEDGER_COLUMNS, LEDGER_INDEXES);
  if (issues.length > 0) {
    throw new MetadataError(`MySQL migration-ledger drift detected for '${migrationTableName}': ${issues.join("; ")}.`);
  }
}

async function databaseName(connection: MySqlConnectionExecutor): Promise<string> {
  const [rows] = await connection.query<DatabaseRow[]>("SELECT DATABASE() AS database_name");
  const value = rows[0]?.database_name;
  if (typeof value !== "string" || value.length === 0) throw new MetadataError("MySQL schema migration requires a selected database.");
  return value;
}

function migrationLockName(database: string, component: MySqlSchemaComponent, tableName: string): string {
  const digest = createHash("sha256").update(`${database}\n${component}\n${tableName}`, "utf8").digest("hex");
  return `metaobject:${digest.slice(0, 52)}`;
}

function lockValue(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function acquireMigrationLock(connection: MySqlConnectionExecutor, lockName: string, timeoutSeconds: number): Promise<void> {
  const [rows] = await connection.execute<LockRow[]>("SELECT GET_LOCK(?, ?) AS acquired", [lockName, timeoutSeconds]);
  if (lockValue(rows[0]?.acquired) !== 1) {
    throw new MetadataError(`Timed out acquiring MySQL MetaObject schema migration lock '${lockName}'.`);
  }
}

async function releaseMigrationLock(connection: MySqlConnectionExecutor, lockName: string): Promise<boolean> {
  try {
    const [rows] = await connection.execute<LockRow[]>("SELECT RELEASE_LOCK(?) AS released", [lockName]);
    return lockValue(rows[0]?.released) === 1;
  } catch {
    return false;
  }
}

async function readLedger(
  connection: MySqlConnectionExecutor,
  migrationTableName: string,
  component: MySqlSchemaComponent,
  targetTable: string,
): Promise<readonly MigrationRow[]> {
  const table = quoteSqlIdentifier(migrationTableName);
  const [rows] = await connection.execute<MigrationRow[]>(
    `SELECT schema_version, migration_id, checksum
       FROM ${table}
      WHERE component = ? AND target_table = ?
      ORDER BY schema_version ASC`,
    [component, targetTable],
  );
  return rows;
}

function validateLedger(plan: MigrationPlan, rows: readonly MigrationRow[]): Set<number> {
  const recorded = new Set<number>();
  let previous = 0;
  for (const row of rows) {
    const version = asNonNegativeInteger(row.schema_version, "migration schema version");
    if (version !== previous + 1) throw new MetadataError(`MySQL ${plan.component} migration ledger has a non-contiguous version sequence at ${version}.`);
    if (version > plan.currentVersion) throw new MetadataError(`MySQL ${plan.component} schema version ${version} is newer than supported version ${plan.currentVersion}.`);
    const expected = plan.migrations[version - 1];
    if (!expected) throw new MetadataError(`MySQL ${plan.component} schema version ${version} has no migration definition.`);
    const checksum = migrationChecksum(plan.component, expected);
    if (row.migration_id !== expected.id || row.checksum !== checksum) {
      throw new MetadataError(`MySQL ${plan.component} migration ledger integrity mismatch at version ${version}.`);
    }
    recorded.add(version);
    previous = version;
  }
  return recorded;
}

async function recordMigration(
  connection: MySqlConnectionExecutor,
  migrationTableName: string,
  plan: MigrationPlan,
  targetTable: string,
  migration: MigrationDefinition,
): Promise<void> {
  const table = quoteSqlIdentifier(migrationTableName);
  await connection.execute(
    `INSERT INTO ${table}
      (component, target_table, schema_version, migration_id, checksum)
     VALUES (?, ?, ?, ?, ?)`,
    [plan.component, targetTable, migration.version, migration.id, migrationChecksum(plan.component, migration)],
  );
}

async function migratePlan(
  pool: MySqlPoolExecutor,
  plan: MigrationPlan,
  targetTable: string,
  options: MySqlSchemaMigrationOptions,
): Promise<MySqlSchemaMigrationReport> {
  validatePlan(plan);
  const validated = validateOptions(options);
  const connection = await pool.getConnection();
  let reusable = true;
  let lockName: string | null = null;
  let lockAcquired = false;

  try {
    await connection.query(createMigrationTableSql(validated.migrationTableName));
    await verifyLedgerTable(connection, validated.migrationTableName);
    lockName = migrationLockName(await databaseName(connection), plan.component, targetTable);
    await acquireMigrationLock(connection, lockName, validated.lockTimeoutSeconds);
    lockAcquired = true;
    await verifyLedgerTable(connection, validated.migrationTableName);
    const ledgerRows = await readLedger(connection, validated.migrationTableName, plan.component, targetTable);
    const recorded = validateLedger(plan, ledgerRows);
    const appliedVersions: number[] = [];
    const adoptedVersions: number[] = [];

    for (const migration of plan.migrations) {
      if (recorded.has(migration.version)) continue;
      const alreadySatisfied = await migration.isSatisfied(connection, targetTable);
      if (!alreadySatisfied) await migration.apply(connection, targetTable);
      const issues = await migration.diagnose(connection, targetTable);
      if (issues.length > 0) {
        throw new MetadataError(`MySQL ${plan.component} schema drift detected for '${targetTable}' while applying version ${migration.version}: ${issues.join("; ")}.`);
      }
      await recordMigration(connection, validated.migrationTableName, plan, targetTable, migration);
      (alreadySatisfied ? adoptedVersions : appliedVersions).push(migration.version);
    }

    const finalIssues = await plan.diagnoseFinal(connection, targetTable);
    if (finalIssues.length > 0) {
      throw new MetadataError(`MySQL ${plan.component} schema drift detected for '${targetTable}': ${finalIssues.join("; ")}.`);
    }

    return {
      component: plan.component,
      targetTable,
      migrationTable: validated.migrationTableName,
      schemaVersion: plan.currentVersion,
      appliedVersions,
      adoptedVersions,
    };
  } finally {
    if (lockAcquired && lockName) reusable = await releaseMigrationLock(connection, lockName);
    if (reusable) connection.release();
    else connection.destroy();
  }
}

export function migrateMySqlStorageSchema(
  pool: NativeMySqlPool,
  tableName = DEFAULT_MYSQL_STORAGE_TABLE,
  options: MySqlSchemaMigrationOptions = {},
): Promise<MySqlSchemaMigrationReport> {
  return migratePlan(adaptMySqlPool(pool), STORAGE_PLAN, validateSqlIdentifier(tableName), options);
}

export function migrateMySqlMetadataSchema(
  pool: NativeMySqlPool,
  tableName = DEFAULT_MYSQL_METADATA_TABLE,
  options: MySqlSchemaMigrationOptions = {},
): Promise<MySqlSchemaMigrationReport> {
  return migratePlan(adaptMySqlPool(pool), METADATA_PLAN, validateMetadataTableName(tableName), options);
}
