import { MetadataError } from "@nublox/metaobject";

export const MYSQL_STORAGE_SCHEMA_VERSION = 1;
export const DEFAULT_MYSQL_STORAGE_TABLE = "metaobject_objects";

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

export function validateSqlIdentifier(identifier: string): string {
  if (!IDENTIFIER.test(identifier)) {
    throw new MetadataError(
      `Invalid MySQL identifier '${identifier}'. Use only letters, digits and underscore, beginning with a letter.`,
    );
  }
  return identifier;
}

export function quoteSqlIdentifier(identifier: string): string {
  return `\`${validateSqlIdentifier(identifier)}\``;
}

export function createStorageTableSql(tableName = DEFAULT_MYSQL_STORAGE_TABLE): string {
  const table = quoteSqlIdentifier(tableName);
  return `CREATE TABLE IF NOT EXISTS ${table} (
    object_type VARCHAR(255) NOT NULL,
    object_id VARCHAR(255) NOT NULL,
    schema_version INT UNSIGNED NOT NULL,
    version BIGINT UNSIGNED NOT NULL,
    values_json JSON NOT NULL,
    relationships_json JSON NOT NULL,
    created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    PRIMARY KEY (object_type, object_id),
    KEY idx_metaobject_type (object_type)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;
}
