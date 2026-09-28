import mysqlPromise from "@nublox/mysql/promise";
import type {
  ObjectQuery,
  QueryFilter,
  QueryPushdownCapabilities,
} from "@nublox/metaobject";
import { MYSQL_QUERY_PUSHDOWN_CAPABILITIES } from "./query-capabilities.js";
import { quoteSqlIdentifier } from "./schema.js";

interface CompiledPredicate {
  readonly sql: string;
  readonly parameters: readonly unknown[];
}

export interface MySqlObjectQueryPlan {
  readonly sql: string;
  readonly parameters: readonly unknown[];
  readonly pushedFilters: readonly QueryFilter[];
  readonly residualFilters: readonly QueryFilter[];
  readonly paginationPushed: boolean;
}

const SELECT_COLUMNS =
  "object_type, object_id, schema_version, version, values_json, relationships_json";

function jsonPathMember(value: string): string {
  return JSON.stringify(value);
}

function attributePath(attribute: string, field: "kind" | "value"): string {
  return `$."value"."value".${jsonPathMember(attribute)}.${jsonPathMember(field)}`;
}

function kindExpression(): string {
  return "JSON_UNQUOTE(JSON_EXTRACT(values_json, ?))";
}

function valueExpression(): string {
  return "JSON_UNQUOTE(JSON_EXTRACT(values_json, ?))";
}

function constantPredicate(value: boolean): CompiledPredicate {
  return { sql: value ? "1 = 1" : "1 = 0", parameters: [] };
}

function scalarEquality(attribute: string, value: unknown): CompiledPredicate {
  const kindPath = attributePath(attribute, "kind");
  const valuePath = attributePath(attribute, "value");
  const kind = kindExpression();
  const encodedValue = valueExpression();

  if (value === undefined) {
    return {
      sql: `(${kind} IS NULL OR ${kind} <=> 'undefined')`,
      parameters: [kindPath, kindPath],
    };
  }
  if (value === null) {
    return { sql: `(${kind} <=> 'null')`, parameters: [kindPath] };
  }
  if (typeof value === "boolean") {
    return {
      sql: `((${kind} <=> 'boolean') AND (${encodedValue} <=> ?))`,
      parameters: [kindPath, valuePath, value ? "true" : "false"],
    };
  }
  if (typeof value === "string") {
    return {
      sql: `((${kind} <=> 'string') AND (HEX(${encodedValue}) <=> HEX(?)))`,
      parameters: [kindPath, valuePath, value],
    };
  }
  if (typeof value === "bigint") {
    return {
      sql: `((${kind} <=> 'bigint') AND (HEX(${encodedValue}) <=> HEX(?)))`,
      parameters: [kindPath, valuePath, value.toString()],
    };
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      return {
        sql: `((${kind} <=> 'special-number') AND (${encodedValue} <=> 'NaN'))`,
        parameters: [kindPath, valuePath],
      };
    }
    if (value === Infinity || value === -Infinity || Object.is(value, -0)) {
      const encoded = value === Infinity ? "Infinity" : value === -Infinity ? "-Infinity" : "-0";
      return {
        sql: `((${kind} <=> 'special-number') AND (${encodedValue} <=> ?))`,
        parameters: [kindPath, valuePath, encoded],
      };
    }
    return {
      sql: `((${kind} <=> 'number') AND (CAST(${encodedValue} AS DOUBLE) <=> ?))`,
      parameters: [kindPath, valuePath, value],
    };
  }

  // Persisted objects, arrays and Dates are always detached from a caller's
  // reference, so Object.is cannot match them at the StorageAdapter boundary.
  return constantPredicate(false);
}

function negate(predicate: CompiledPredicate): CompiledPredicate {
  return { sql: `NOT (${predicate.sql})`, parameters: predicate.parameters };
}

function compileIn(attribute: string, value: unknown, negateResult: boolean): CompiledPredicate {
  if (!Array.isArray(value)) return constantPredicate(false);
  if (value.length === 0) return constantPredicate(negateResult);
  const predicates = value.map((item) => scalarEquality(attribute, item));
  const joined: CompiledPredicate = {
    sql: `(${predicates.map((item) => `(${item.sql})`).join(" OR ")})`,
    parameters: predicates.flatMap((item) => item.parameters),
  };
  return negateResult ? negate(joined) : joined;
}

function compileMySqlFilter(filter: QueryFilter): CompiledPredicate | null {
  switch (filter.operator) {
    case "eq":
      return scalarEquality(filter.attribute, filter.value);
    case "neq":
      return negate(scalarEquality(filter.attribute, filter.value));
    case "in":
      return compileIn(filter.attribute, filter.value, false);
    case "notIn":
      return compileIn(filter.attribute, filter.value, true);
    case "isNull": {
      const path = attributePath(filter.attribute, "kind");
      const kind = kindExpression();
      return {
        sql: `(${kind} IS NULL OR ${kind} IN ('null', 'undefined'))`,
        parameters: [path, path],
      };
    }
    case "isNotNull": {
      const path = attributePath(filter.attribute, "kind");
      const kind = kindExpression();
      return {
        sql: `(${kind} IS NOT NULL AND ${kind} NOT IN ('null', 'undefined'))`,
        parameters: [path, path],
      };
    }
    case "gt":
    case "gte":
    case "lt":
    case "lte":
    case "contains":
    case "startsWith":
    case "endsWith":
      return null;
  }
}

function safePageValue(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value >= 0);
}

function uint64PageParameter(value: number) {
  return mysqlPromise.param.uint64(value);
}

function advertisesFilter(
  capabilities: QueryPushdownCapabilities,
  filter: QueryFilter,
): boolean {
  return capabilities.filterOperators.includes(filter.operator);
}

export function compileMySqlObjectQueryPlan(
  tableName: string,
  query: ObjectQuery,
  capabilities: QueryPushdownCapabilities = MYSQL_QUERY_PUSHDOWN_CAPABILITIES,
): MySqlObjectQueryPlan {
  const table = quoteSqlIdentifier(tableName);
  const pushedFilters: QueryFilter[] = [];
  const residualFilters: QueryFilter[] = [];
  const predicates: string[] = ["object_type = ?"];
  const parameters: unknown[] = [query.objectType];

  for (const filter of query.where ?? []) {
    if (!advertisesFilter(capabilities, filter)) {
      residualFilters.push(filter);
      continue;
    }

    // Capability declarations are advisory proof. The compiler still fails
    // closed if no SQL translation exists for an advertised operator.
    const compiled = compileMySqlFilter(filter);
    if (!compiled) {
      residualFilters.push(filter);
      continue;
    }
    pushedFilters.push(filter);
    predicates.push(compiled.sql);
    parameters.push(...compiled.parameters);
  }

  const hasAttributeSort = (query.orderBy?.length ?? 0) > 0;
  const pagination = capabilities.pagination;
  const paginationPushed =
    pagination.offsetLimit
    && (!pagination.requiresFullyPushedFilters || residualFilters.length === 0)
    && (!pagination.requiresNoAttributeOrdering || !hasAttributeSort)
    && safePageValue(query.offset)
    && safePageValue(query.limit);

  let sql = `SELECT ${SELECT_COLUMNS}\nFROM ${table}\nWHERE ${predicates.join(" AND ")}\nORDER BY object_id ASC`;

  if (paginationPushed && query.limit !== undefined) {
    sql += "\nLIMIT ? OFFSET ?";
    parameters.push(
      uint64PageParameter(query.limit),
      uint64PageParameter(query.offset ?? 0),
    );
  } else if (paginationPushed && query.offset !== undefined && query.offset > 0) {
    sql += "\nLIMIT 18446744073709551615 OFFSET ?";
    parameters.push(uint64PageParameter(query.offset));
  }

  return {
    sql,
    parameters,
    pushedFilters,
    residualFilters,
    paginationPushed,
  };
}
