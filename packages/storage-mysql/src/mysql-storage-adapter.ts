import type mysql from "@nublox/mysql";
import {
  ConcurrencyError,
  MetadataError,
  type ObjectIdentity,
  type ObjectQuery,
  type ObjectSnapshot,
  type QueryFilter,
  type RelationshipValue,
  type StorageAdapter,
  type StorageBatchWrite,
} from "@nublox/metaobject";
import { decodeRecord, encodeRecord } from "./codec.js";
import {
  migrateMySqlStorageSchema,
  type MySqlSchemaMigrationOptions,
} from "./migrations.js";
import { compileMySqlObjectQueryPlan } from "./query-compiler.js";
import {
  DEFAULT_MYSQL_STORAGE_TABLE,
  quoteSqlIdentifier,
  validateSqlIdentifier,
} from "./schema.js";

interface SqlExecutor {
  query<T = mysql.QueryResult>(
    sql: string,
    values?: unknown[] | Record<string, unknown>,
  ): Promise<mysql.QueryTuple<T>>;
  execute<T = mysql.QueryResult>(
    sql: string,
    values?: unknown[] | Record<string, unknown>,
  ): Promise<mysql.QueryTuple<T>>;
}

interface SnapshotRow extends Record<string, unknown> {
  object_type: string;
  object_id: string;
  schema_version: number | string;
  version: number | string;
  values_json: unknown;
  relationships_json: unknown;
}

interface VersionRow extends Record<string, unknown> {
  version: number | string;
}

export interface MySqlStorageAdapterOptions {
  readonly tableName?: string;
  /** Schema migration ledger/locking configuration used by initialize(). */
  readonly migrations?: MySqlSchemaMigrationOptions;
  /**
   * Options forwarded to @nublox/mysql for atomic batch transactions.
   * Transient deadlock/lock-timeout retries default to 2 unless overridden.
   */
  readonly transaction?: mysql.TransactionOptions;
}

export const MYSQL_OBJECT_KEY_MAX_LENGTH = 255;
export const MYSQL_SCHEMA_VERSION_MAX = 0xffff_ffff;
export const DEFAULT_MYSQL_TRANSACTION_RETRIES = 2;

const objectKey = (identity: ObjectIdentity): string => `${identity.type}:${identity.id}`;

function mysqlErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function validateObjectKeyPart(value: unknown, field: "type" | "id"): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new MetadataError(`Object ${field} must be a non-empty string.`);
  }
  if (codePointLength(value) > MYSQL_OBJECT_KEY_MAX_LENGTH) {
    throw new MetadataError(
      `Object ${field} exceeds MySQL storage limit ${MYSQL_OBJECT_KEY_MAX_LENGTH} characters.`,
    );
  }
  return value;
}

function validateIdentity(identity: ObjectIdentity): void {
  validateObjectKeyPart(identity.type, "type");
  validateObjectKeyPart(identity.id, "id");
}

function validateSchemaVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MYSQL_SCHEMA_VERSION_MAX) {
    throw new MetadataError(
      `Object schemaVersion must be an integer between 0 and ${MYSQL_SCHEMA_VERSION_MAX}.`,
    );
  }
  return value as number;
}

function validateExpectedVersion(value: unknown, incrementing: boolean): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new MetadataError("Expected object version must be a non-negative safe integer.");
  }
  if (incrementing && (value as number) >= Number.MAX_SAFE_INTEGER) {
    throw new MetadataError("Expected object version cannot be incremented without exceeding JavaScript safe-integer range.");
  }
  return value as number;
}

function validateSnapshot(snapshot: ObjectSnapshot): void {
  validateIdentity(snapshot);
  validateSchemaVersion(snapshot.schemaVersion);
  if (typeof snapshot.values !== "object" || snapshot.values === null || Array.isArray(snapshot.values)) {
    throw new MetadataError("Object snapshot values must be an object record.");
  }
  if (
    typeof snapshot.relationships !== "object"
    || snapshot.relationships === null
    || Array.isArray(snapshot.relationships)
  ) {
    throw new MetadataError("Object snapshot relationships must be an object record.");
  }
}

function toSafeInteger(value: number | string, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new MetadataError(`MySQL returned invalid ${field} '${String(value)}'.`);
  }
  return parsed;
}

function rowToSnapshot(row: SnapshotRow): ObjectSnapshot {
  return {
    id: String(row.object_id),
    type: String(row.object_type),
    schemaVersion: toSafeInteger(row.schema_version, "schema version"),
    version: toSafeInteger(row.version, "object version"),
    values: decodeRecord(row.values_json),
    relationships: decodeRecord(row.relationships_json) as Readonly<Record<string, RelationshipValue>>,
  };
}

function compare(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === undefined || left === null) return -1;
  if (right === undefined || right === null) return 1;
  if (left instanceof Date && right instanceof Date) return left.getTime() - right.getTime();
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right));
}

function matches(value: unknown, filter: QueryFilter): boolean {
  switch (filter.operator) {
    case "eq": return Object.is(value, filter.value);
    case "neq": return !Object.is(value, filter.value);
    case "gt": return compare(value, filter.value) > 0;
    case "gte": return compare(value, filter.value) >= 0;
    case "lt": return compare(value, filter.value) < 0;
    case "lte": return compare(value, filter.value) <= 0;
    case "in": return Array.isArray(filter.value) && filter.value.some((item) => Object.is(value, item));
    case "notIn": return Array.isArray(filter.value) && !filter.value.some((item) => Object.is(value, item));
    case "contains": return typeof value === "string" && typeof filter.value === "string" && value.includes(filter.value);
    case "startsWith": return typeof value === "string" && typeof filter.value === "string" && value.startsWith(filter.value);
    case "endsWith": return typeof value === "string" && typeof filter.value === "string" && value.endsWith(filter.value);
    case "isNull": return value === null || value === undefined;
    case "isNotNull": return value !== null && value !== undefined;
  }
}

export class MySqlStorageAdapter implements StorageAdapter {
  readonly #pool: mysql.PromisePool;
  readonly #tableName: string;
  readonly #table: string;
  readonly #migrationOptions: MySqlSchemaMigrationOptions;
  readonly #transactionOptions: mysql.TransactionOptions;

  constructor(pool: mysql.PromisePool, options: MySqlStorageAdapterOptions = {}) {
    this.#pool = pool;
    this.#tableName = validateSqlIdentifier(options.tableName ?? DEFAULT_MYSQL_STORAGE_TABLE);
    this.#table = quoteSqlIdentifier(this.#tableName);
    this.#migrationOptions = options.migrations ?? {};
    const transaction = options.transaction ?? {};
    this.#transactionOptions = {
      ...transaction,
      maxRetries: transaction.maxRetries ?? DEFAULT_MYSQL_TRANSACTION_RETRIES,
    };
  }

  get tableName(): string { return this.#tableName; }

  async initialize(): Promise<void> {
    await migrateMySqlStorageSchema(this.#pool, this.#tableName, this.#migrationOptions);
  }

  async insert(snapshot: ObjectSnapshot): Promise<ObjectSnapshot> {
    validateSnapshot(snapshot);
    return this.#insert(this.#pool, snapshot);
  }

  async update(snapshot: ObjectSnapshot, expectedVersion: number): Promise<ObjectSnapshot> {
    validateSnapshot(snapshot);
    validateExpectedVersion(expectedVersion, true);
    return this.#update(this.#pool, snapshot, expectedVersion);
  }

  async saveBatch(writes: readonly StorageBatchWrite[]): Promise<readonly ObjectSnapshot[]> {
    const seen = new Set<string>();
    for (const write of writes) {
      validateSnapshot(write.snapshot);
      if (write.kind === "update") validateExpectedVersion(write.expectedVersion, true);
      const key = objectKey(write.snapshot);
      if (seen.has(key)) throw new MetadataError(`Duplicate object batch write '${key}'.`);
      seen.add(key);
    }
    if (writes.length === 0) return [];
    return this.#pool.withTransaction(async (connection) => {
      const results: ObjectSnapshot[] = [];
      for (const write of writes) {
        results.push(write.kind === "insert"
          ? await this.#insert(connection, write.snapshot)
          : await this.#update(connection, write.snapshot, write.expectedVersion));
      }
      return results;
    }, this.#transactionOptions);
  }

  async delete(identity: ObjectIdentity, expectedVersion: number): Promise<void> {
    validateIdentity(identity);
    validateExpectedVersion(expectedVersion, false);
    const [result] = await this.#pool.execute<mysql.OkPacket>(
      `DELETE FROM ${this.#table} WHERE object_type = ? AND object_id = ? AND version = ?`,
      [identity.type, identity.id, expectedVersion],
    );
    if ((result.affectedRows ?? 0) > 0) return;
    const actualVersion = await this.#getVersion(this.#pool, identity);
    if (actualVersion === null) return;
    throw new ConcurrencyError(
      `Optimistic concurrency conflict for '${objectKey(identity)}': expected version ${expectedVersion}, found ${actualVersion}.`,
    );
  }

  async get(identity: ObjectIdentity): Promise<ObjectSnapshot | null> {
    validateIdentity(identity);
    const [rows] = await this.#pool.query<SnapshotRow[]>(
      `SELECT object_type, object_id, schema_version, version, values_json, relationships_json
       FROM ${this.#table}
       WHERE object_type = ? AND object_id = ?`,
      [identity.type, identity.id],
    );
    const row = rows[0];
    return row ? rowToSnapshot(row) : null;
  }

  async query(query: ObjectQuery): Promise<readonly ObjectSnapshot[]> {
    validateObjectKeyPart(query.objectType, "type");
    const plan = compileMySqlObjectQueryPlan(this.#tableName, query);
    const [rows] = await this.#pool.execute<SnapshotRow[]>(plan.sql, [...plan.parameters]);
    let results = rows.map(rowToSnapshot);
    for (const filter of query.where ?? []) {
      results = results.filter((item) => matches(item.values[filter.attribute], filter));
    }
    for (const sort of [...(query.orderBy ?? [])].reverse()) {
      results.sort((left, right) => {
        const result = compare(left.values[sort.attribute], right.values[sort.attribute]);
        return sort.direction === "desc" ? -result : result;
      });
    }
    if (plan.paginationPushed) return results;
    const offset = query.offset ?? 0;
    const end = query.limit === undefined ? undefined : offset + query.limit;
    return results.slice(offset, end);
  }

  async #insert(executor: SqlExecutor, snapshot: ObjectSnapshot): Promise<ObjectSnapshot> {
    const stored: ObjectSnapshot = { ...snapshot, version: 1 };
    try {
      await executor.execute<mysql.OkPacket>(
        `INSERT INTO ${this.#table}
          (object_type, object_id, schema_version, version, values_json, relationships_json)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [stored.type, stored.id, stored.schemaVersion, stored.version, encodeRecord(stored.values), encodeRecord(stored.relationships as Readonly<Record<string, unknown>>)],
      );
    } catch (error) {
      if (mysqlErrorCode(error) === "ER_DUP_ENTRY") throw new ConcurrencyError(`Object '${objectKey(snapshot)}' already exists.`);
      throw error;
    }
    return structuredClone(stored);
  }

  async #update(executor: SqlExecutor, snapshot: ObjectSnapshot, expectedVersion: number): Promise<ObjectSnapshot> {
    const stored: ObjectSnapshot = { ...snapshot, version: expectedVersion + 1 };
    const [result] = await executor.execute<mysql.OkPacket>(
      `UPDATE ${this.#table}
       SET schema_version = ?, version = ?, values_json = ?, relationships_json = ?
       WHERE object_type = ? AND object_id = ? AND version = ?`,
      [stored.schemaVersion, stored.version, encodeRecord(stored.values), encodeRecord(stored.relationships as Readonly<Record<string, unknown>>), stored.type, stored.id, expectedVersion],
    );
    if ((result.affectedRows ?? 0) > 0) return structuredClone(stored);
    const actualVersion = await this.#getVersion(executor, snapshot);
    if (actualVersion === null) throw new ConcurrencyError(`Object '${objectKey(snapshot)}' no longer exists.`);
    throw new ConcurrencyError(
      `Optimistic concurrency conflict for '${objectKey(snapshot)}': expected version ${expectedVersion}, found ${actualVersion}.`,
    );
  }

  async #getVersion(executor: SqlExecutor, identity: ObjectIdentity): Promise<number | null> {
    const [rows] = await executor.query<VersionRow[]>(
      `SELECT version FROM ${this.#table} WHERE object_type = ? AND object_id = ?`,
      [identity.type, identity.id],
    );
    const row = rows[0];
    return row ? toSafeInteger(row.version, "object version") : null;
  }
}
