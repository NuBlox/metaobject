import { MetadataError } from "@nublox/metaobject";

export const MYSQL_STORAGE_SCHEMA_VERSION = 2;
export const DEFAULT_MYSQL_STORAGE_TABLE = "metaobject_objects";
export const MYSQL_IDENTIFIER_MAX_LENGTH = 64;
export const MYSQL_STORAGE_V2_INDEX = "idx_metaobject_type_schema";

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

export function validateSqlIdentifier(identifier: string): string {
  if (!IDENTIFIER.test(identifier) || Array.from(identifier).length > MYSQL_IDENTIFIER_MAX_LENGTH) {
    throw new MetadataError(
      `Invalid MySQL identifier '${identifier}'. Use at most ${MYSQL_IDENTIFIER_MAX_LENGTH} letters, digits or underscores, beginning with a letter.`,
    );
  }
  return identifier;
}

export function quoteSqlIdentifier(identifier: string): string {
  return `\`${validateSqlIdentifier(identifier)}\``;
}

/** Immutable M69-M72 storage-table baseline used by migration version 1. */
export function createStorageTableV1Sql(tableName = DEFAULT_MYSQL_STORAGE_TABLE): string {
  const table = quoteSqlIdentifier(tableName);
  return `CREATE TABLE IF NOT EXISTS ${table} (
    object_type VARCHAR(255) NOT NULL,
    object_id VARCHAR(255) NOT NULL,
    schema_version INT UNSIGNED NOT NULL,
    version BIGINT UNSIGNED NOT NULL,
    values_json LONGTEXT NOT NULL,
    relationships_json LONGTEXT NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (object_type, object_id),
    KEY idx_metaobject_type (object_type),
    CHECK (JSON_VALID(values_json)),
    CHECK (JSON_VALID(relationships_json))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
}

/** Immutable v1 -> v2 storage migration. */
export function createStorageV2MigrationSql(tableName = DEFAULT_MYSQL_STORAGE_TABLE): string {
  const table = quoteSqlIdentifier(tableName);
  return `ALTER TABLE ${table}
    ADD KEY ${quoteSqlIdentifier(MYSQL_STORAGE_V2_INDEX)} (object_type, schema_version, object_id)`;
}

/** Latest storage-table DDL for diagnostics and provisioning outside the migrator. */
export function createStorageTableSql(tableName = DEFAULT_MYSQL_STORAGE_TABLE): string {
  const table = quoteSqlIdentifier(tableName);
  return `CREATE TABLE IF NOT EXISTS ${table} (
    object_type VARCHAR(255) NOT NULL,
    object_id VARCHAR(255) NOT NULL,
    schema_version INT UNSIGNED NOT NULL,
    version BIGINT UNSIGNED NOT NULL,
    values_json LONGTEXT NOT NULL,
    relationships_json LONGTEXT NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (object_type, object_id),
    KEY idx_metaobject_type (object_type),
    KEY ${quoteSqlIdentifier(MYSQL_STORAGE_V2_INDEX)} (object_type, schema_version, object_id),
    CHECK (JSON_VALID(values_json)),
    CHECK (JSON_VALID(relationships_json))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
}
