import { MetaObjectError } from "@nublox/metaobject";
import type { mysql as native } from "nubloxsql";

export type NativeMySqlPool = native.Pool;
export type NativeMySqlConnection = native.Connection;
export type MySqlField = native.Field;
type NativePreparedStatement = Awaited<ReturnType<NativeMySqlConnection["prepare"]>>;

export interface MetaObjectMySqlTransactionOptions extends native.TransactionOptions {
  /** Number of retries after the initial transaction attempt for transient MySQL locking failures. */
  readonly maxRetries?: number;
  /** Delay in milliseconds before each retry. */
  readonly retryDelayMs?: number;
}

export interface MySqlCommandResult {
  readonly affectedRows: number | bigint;
  readonly insertId: number | bigint;
  readonly serverStatus: number;
  readonly warningCount: number;
}

export type MySqlQueryTuple<T> = readonly [T, readonly MySqlField[]];

export interface MySqlExecutor {
  query<T = MySqlCommandResult>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<MySqlQueryTuple<T>>;
  execute<T = MySqlCommandResult>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<MySqlQueryTuple<T>>;
}

export interface MySqlConnectionExecutor extends MySqlExecutor {
  release(): void;
  destroy(error?: Error): void;
}

export interface MySqlPoolExecutor extends MySqlExecutor {
  getConnection(): Promise<MySqlConnectionExecutor>;
  withTransaction<T>(
    fn: (connection: MySqlConnectionExecutor) => T | Promise<T>,
    options?: MetaObjectMySqlTransactionOptions,
  ): Promise<T>;
}

const ROW_STATEMENTS = new Set(["SELECT", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "WITH"]);
const MYSQL_DUPLICATE_ENTRY = 1062;
const MYSQL_LOCK_WAIT_TIMEOUT = 1205;
const MYSQL_DEADLOCK = 1213;
const NUBLOX_MYSQL_OPERATION_STATE = "NUBLOX_MYSQL_OPERATION_STATE";

function statementKind(sql: string): string {
  const match = /^\s*([A-Za-z]+)/.exec(sql);
  return match?.[1]?.toUpperCase() ?? "";
}

function tuple<T>(sql: string, result: native.QueryResult<Record<string, unknown>>): MySqlQueryTuple<T> {
  const first = ROW_STATEMENTS.has(statementKind(sql))
    ? result.rows
    : {
        affectedRows: result.affectedRows,
        insertId: result.insertId,
        serverStatus: result.serverStatus,
        warningCount: result.warningCount,
      };
  return [first as T, result.fields] as const;
}

function valuesPresent(values: readonly unknown[] | undefined): values is readonly unknown[] {
  return values !== undefined && values.length > 0;
}

function unwrapMetaObjectTransactionError(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return error;
  if (!("code" in error) || (error as { readonly code?: unknown }).code !== NUBLOX_MYSQL_OPERATION_STATE) return error;
  if (!("cause" in error)) return error;
  const cause = (error as { readonly cause?: unknown }).cause;
  return cause instanceof MetaObjectError ? cause : error;
}

async function executePrepared(
  connection: native.Connection,
  sql: string,
  values: readonly unknown[],
): Promise<native.QueryResult<Record<string, unknown>>> {
  const statement = await connection.prepare(sql);
  try {
    return await statement.execute<Record<string, unknown>>(values);
  } finally {
    await statement.close();
  }
}

class ConnectionExecutor implements MySqlConnectionExecutor {
  readonly #connection: native.Connection;
  readonly #owner: native.Pool | undefined;
  readonly #preparedStatements: Map<string, NativePreparedStatement> | undefined;

  constructor(connection: native.Connection, owner?: native.Pool, cachePreparedStatements = false) {
    this.#connection = connection;
    this.#owner = owner;
    this.#preparedStatements = cachePreparedStatements ? new Map() : undefined;
  }

  async #executePreparedCached(
    sql: string,
    values: readonly unknown[],
  ): Promise<native.QueryResult<Record<string, unknown>>> {
    if (!this.#preparedStatements) return executePrepared(this.#connection, sql, values);
    let statement = this.#preparedStatements.get(sql);
    if (!statement) {
      statement = await this.#connection.prepare(sql);
      this.#preparedStatements.set(sql, statement);
    }
    return statement.execute<Record<string, unknown>>(values);
  }

  async closePreparedStatements(): Promise<void> {
    if (!this.#preparedStatements) return;
    const statements = [...this.#preparedStatements.values()];
    this.#preparedStatements.clear();
    let firstError: unknown;
    for (const statement of statements) {
      try {
        await statement.close();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }

  async query<T = MySqlCommandResult>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<MySqlQueryTuple<T>> {
    const result = valuesPresent(values)
      ? await this.#executePreparedCached(sql, values)
      : await this.#connection.query<Record<string, unknown>>(sql);
    return tuple<T>(sql, result);
  }

  async execute<T = MySqlCommandResult>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<MySqlQueryTuple<T>> {
    const result = await this.#executePreparedCached(sql, values);
    return tuple<T>(sql, result);
  }

  release(): void {
    if (!this.#owner) return;
    this.#owner.releaseConnection(this.#connection);
  }

  destroy(error?: Error): void {
    this.#connection.destroy(error);
  }
}

class PoolExecutor implements MySqlPoolExecutor {
  readonly #pool: native.Pool;

  constructor(pool: native.Pool) {
    this.#pool = pool;
  }

  async query<T = MySqlCommandResult>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<MySqlQueryTuple<T>> {
    const result = valuesPresent(values)
      ? await this.#pool.execute<Record<string, unknown>>(sql, values)
      : await this.#pool.query<Record<string, unknown>>(sql);
    return tuple<T>(sql, result);
  }

  async execute<T = MySqlCommandResult>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<MySqlQueryTuple<T>> {
    const result = await this.#pool.execute<Record<string, unknown>>(sql, values);
    return tuple<T>(sql, result);
  }

  async getConnection(): Promise<MySqlConnectionExecutor> {
    const connection = await this.#pool.getConnection();
    return new ConnectionExecutor(connection, this.#pool);
  }

  async withTransaction<T>(
    fn: (connection: MySqlConnectionExecutor) => T | Promise<T>,
    options: MetaObjectMySqlTransactionOptions = {},
  ): Promise<T> {
    const { maxRetries = 0, retryDelayMs = 0, ...nativeOptions } = options;
    if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) {
      throw new RangeError("MySQL transaction maxRetries must be a non-negative safe integer.");
    }
    if (!Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
      throw new RangeError("MySQL transaction retryDelayMs must be a non-negative finite number.");
    }

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.#pool.withTransaction(async (connection: native.Connection) => {
          const executor = new ConnectionExecutor(connection, undefined, true);
          let callbackError: unknown;
          try {
            return await fn(executor);
          } catch (error) {
            callbackError = error;
            throw error;
          } finally {
            try {
              await executor.closePreparedStatements();
            } catch (closeError) {
              if (callbackError === undefined) throw closeError;
            }
          }
        }, nativeOptions);
      } catch (error) {
        const normalizedError = unwrapMetaObjectTransactionError(error);
        if (attempt >= maxRetries || !isTransientMySqlTransactionError(normalizedError)) throw normalizedError;
        if (retryDelayMs > 0) {
          await new Promise<void>((resolve) => setTimeout(resolve, retryDelayMs));
        }
      }
    }
  }
}

export function adaptMySqlPool(pool: native.Pool): MySqlPoolExecutor {
  return new PoolExecutor(pool);
}

export function mysqlServerErrorCode(error: unknown): number | string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const value = (error as { readonly code?: unknown }).code;
  return typeof value === "number" || typeof value === "string" ? value : null;
}

export function isDuplicateEntryError(error: unknown): boolean {
  const code = mysqlServerErrorCode(error);
  return code === MYSQL_DUPLICATE_ENTRY || code === "ER_DUP_ENTRY";
}

export function isTransientMySqlTransactionError(error: unknown): boolean {
  const code = mysqlServerErrorCode(error);
  if (code === MYSQL_LOCK_WAIT_TIMEOUT || code === MYSQL_DEADLOCK) return true;
  if (code === "ER_LOCK_WAIT_TIMEOUT" || code === "ER_LOCK_DEADLOCK") return true;
  return typeof error === "object"
    && error !== null
    && "retryable" in error
    && (error as { readonly retryable?: unknown }).retryable === true;
}
