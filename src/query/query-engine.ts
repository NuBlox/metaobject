import { MetadataError } from "../errors/errors.js";
import type { ObjectReference, ObjectSnapshot } from "../runtime/model.js";
import type { StorageAdapter } from "../storage/storage-adapter.js";
import type {
  MetaQuery,
  MetaQueryResult,
  QueryAggregate,
  QueryExpression,
  QueryOperator,
  QueryOrder,
  QueryPageInfo,
  QueryPlan,
  QueryRow,
} from "./query.js";
import type { QueryPlanner } from "./query-planner.js";

interface PreparedRow {
  readonly snapshot: ObjectSnapshot;
  readonly orderValues: readonly unknown[];
}

function compareScalar(left: unknown, right: unknown, nulls: "first" | "last" = "first"): number {
  if (Object.is(left, right)) return 0;
  const leftNull = left === null || left === undefined;
  const rightNull = right === null || right === undefined;
  if (leftNull || rightNull) {
    if (leftNull && rightNull) return 0;
    const nullResult = leftNull ? -1 : 1;
    return nulls === "first" ? nullResult : -nullResult;
  }
  if (typeof left === "number" && typeof right === "number") return left - right;
  if (typeof left === "boolean" && typeof right === "boolean") return Number(left) - Number(right);
  if (left instanceof Date && right instanceof Date) return left.getTime() - right.getTime();
  return String(left).localeCompare(String(right));
}

function scalarValues(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value.flat(Infinity) : [value];
}

function matchesScalar(value: unknown, operator: QueryOperator, expected: unknown): boolean {
  switch (operator) {
    case "eq": return Object.is(value, expected);
    case "neq": return !Object.is(value, expected);
    case "gt": return compareScalar(value, expected) > 0;
    case "gte": return compareScalar(value, expected) >= 0;
    case "lt": return compareScalar(value, expected) < 0;
    case "lte": return compareScalar(value, expected) <= 0;
    case "in": return Array.isArray(expected) && expected.some((item) => Object.is(value, item));
    case "notIn": return Array.isArray(expected) && !expected.some((item) => Object.is(value, item));
    case "contains":
      return (typeof value === "string" && typeof expected === "string" && value.includes(expected))
        || (Array.isArray(value) && value.some((item) => Object.is(item, expected)));
    case "startsWith": return typeof value === "string" && typeof expected === "string" && value.startsWith(expected);
    case "endsWith": return typeof value === "string" && typeof expected === "string" && value.endsWith(expected);
    case "isNull": return value === null || value === undefined;
    case "isNotNull": return value !== null && value !== undefined;
  }
}

function matchesResolved(value: unknown, operator: QueryOperator, expected: unknown): boolean {
  const values = scalarValues(value);
  if (operator === "isNull") return values.length === 0 || values.every((item) => item === null || item === undefined);
  if (operator === "isNotNull") return values.some((item) => item !== null && item !== undefined);
  if (operator === "neq" || operator === "notIn") {
    return values.every((item) => matchesScalar(item, operator, expected));
  }
  return values.some((item) => matchesScalar(item, operator, expected));
}

function encodeCursor(values: readonly unknown[]): string {
  const json = JSON.stringify(values);
  return [...new TextEncoder().encode(json)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function decodeCursor(cursor: string): readonly unknown[] {
  if (!cursor || cursor.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(cursor)) {
    throw new MetadataError("Invalid query cursor.");
  }
  const bytes = new Uint8Array(cursor.length / 2);
  for (let index = 0; index < cursor.length; index += 2) {
    bytes[index / 2] = Number.parseInt(cursor.slice(index, index + 2), 16);
  }
  try {
    const decoded = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(decoded)) throw new Error("cursor payload must be an array");
    return decoded;
  } catch {
    throw new MetadataError("Invalid query cursor.");
  }
}

function identityKey(reference: ObjectReference): string {
  return `${reference.type}:${reference.id}`;
}

export class QueryEngine {
  readonly #cache = new Map<string, ObjectSnapshot | null>();

  constructor(
    private readonly storage: StorageAdapter,
    private readonly planner: QueryPlanner,
  ) {}

  async execute(query: MetaQuery): Promise<MetaQueryResult> {
    const plan = this.planner.plan(query);
    this.#cache.clear();

    const candidates = (
      await Promise.all(plan.rootTypes.map((objectType) => this.storage.query({ objectType })))
    ).flat();

    const matched: ObjectSnapshot[] = [];
    for (const snapshot of candidates) {
      if (!query.where || await this.matchesExpression(snapshot, query.where)) matched.push(snapshot);
    }

    const prepared = await Promise.all(
      matched.map(async (snapshot): Promise<PreparedRow> => ({
        snapshot,
        orderValues: await Promise.all(plan.stableOrder.map((order) => this.resolvePath(snapshot, order.path))),
      })),
    );
    prepared.sort((left, right) => this.comparePrepared(left, right, plan.stableOrder));

    const totalMatched = prepared.length;
    const aggregates = await this.calculateAggregates(matched, query.aggregates ?? []);
    const afterValues = query.page?.after ? decodeCursor(query.page.after) : undefined;
    const afterFiltered = afterValues
      ? prepared.filter((row) => this.compareOrderValues(row.orderValues, afterValues, plan.stableOrder) > 0)
      : prepared;

    const requested = query.page?.first;
    const window = requested === undefined ? afterFiltered : afterFiltered.slice(0, requested + 1);
    const hasNextPage = requested !== undefined && window.length > requested;
    const selected = hasNextPage ? window.slice(0, requested) : window;

    const rows = await Promise.all(selected.map((entry) => this.project(entry.snapshot, query)));
    const pageInfo: QueryPageInfo = selected.length === 0
      ? { hasNextPage }
      : { hasNextPage, endCursor: encodeCursor(selected[selected.length - 1]!.orderValues) };

    return {
      rows,
      aggregates,
      pageInfo,
      totalMatched,
    };
  }

  private async matchesExpression(snapshot: ObjectSnapshot, expression: QueryExpression): Promise<boolean> {
    if ("path" in expression) {
      const value = await this.resolvePath(snapshot, expression.path);
      return matchesResolved(value, expression.operator, expression.value);
    }
    if ("and" in expression) {
      for (const child of expression.and) if (!await this.matchesExpression(snapshot, child)) return false;
      return true;
    }
    if ("or" in expression) {
      for (const child of expression.or) if (await this.matchesExpression(snapshot, child)) return true;
      return false;
    }
    return !await this.matchesExpression(snapshot, expression.not);
  }

  private async project(snapshot: ObjectSnapshot, query: MetaQuery): Promise<QueryRow> {
    const values: Record<string, unknown> = {};
    if (query.select && query.select.length > 0) {
      for (const projection of query.select) {
        values[projection.as ?? projection.path] = await this.resolvePath(snapshot, projection.path);
      }
    } else {
      Object.assign(values, structuredClone(snapshot.values));
    }
    return { $id: snapshot.id, $type: snapshot.type, values };
  }

  private async calculateAggregates(
    snapshots: readonly ObjectSnapshot[],
    definitions: readonly QueryAggregate[],
  ): Promise<Readonly<Record<string, number | string | null>>> {
    const output: Record<string, number | string | null> = {};
    for (const aggregate of definitions) {
      if (aggregate.function === "count" && !aggregate.path) {
        output[aggregate.as] = snapshots.length;
        continue;
      }
      const resolved = await Promise.all(snapshots.map((snapshot) => this.resolvePath(snapshot, aggregate.path!)));
      let values = resolved.flatMap((value) => scalarValues(value)).filter((value) => value !== null && value !== undefined);
      if (aggregate.distinct) {
        const seen = new Set<string>();
        values = values.filter((value) => {
          const key = JSON.stringify(value);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }
      switch (aggregate.function) {
        case "count": output[aggregate.as] = values.length; break;
        case "sum": output[aggregate.as] = this.numeric(values, aggregate).reduce((sum, value) => sum + value, 0); break;
        case "avg": {
          const numbers = this.numeric(values, aggregate);
          output[aggregate.as] = numbers.length === 0 ? null : numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
          break;
        }
        case "min": output[aggregate.as] = this.extreme(values, false); break;
        case "max": output[aggregate.as] = this.extreme(values, true); break;
      }
    }
    return output;
  }

  private numeric(values: readonly unknown[], aggregate: QueryAggregate): number[] {
    if (!values.every((value) => typeof value === "number")) {
      throw new MetadataError(`Aggregate '${aggregate.as}' requires numeric values.`);
    }
    return values as number[];
  }

  private extreme(values: readonly unknown[], maximum: boolean): number | string | null {
    if (values.length === 0) return null;
    let selected: unknown = values[0];
    for (const value of values.slice(1)) {
      const compared = compareScalar(value, selected);
      if ((maximum && compared > 0) || (!maximum && compared < 0)) selected = value;
    }
    if (typeof selected === "number" || typeof selected === "string") return selected;
    return String(selected);
  }

  private comparePrepared(left: PreparedRow, right: PreparedRow, order: readonly QueryOrder[]): number {
    return this.compareOrderValues(left.orderValues, right.orderValues, order);
  }

  private compareOrderValues(left: readonly unknown[], right: readonly unknown[], order: readonly QueryOrder[]): number {
    for (let index = 0; index < order.length; index += 1) {
      const definition = order[index]!;
      const leftValue = this.sortScalar(left[index]);
      const rightValue = this.sortScalar(right[index]);
      const result = compareScalar(leftValue, rightValue, definition.nulls ?? "first");
      if (result !== 0) return definition.direction === "desc" ? -result : result;
    }
    return 0;
  }

  private sortScalar(value: unknown): unknown {
    return Array.isArray(value) ? value[0] : value;
  }

  private async resolvePath(snapshot: ObjectSnapshot, path: string): Promise<unknown> {
    switch (path) {
      case "$id": return snapshot.id;
      case "$type": return snapshot.type;
      case "$version": return snapshot.version;
      case "$schemaVersion": return snapshot.schemaVersion;
    }
    return this.resolveSegments([snapshot], path.split("."));
  }

  private async resolveSegments(snapshots: readonly ObjectSnapshot[], segments: readonly string[]): Promise<unknown> {
    const [segment, ...rest] = segments;
    if (!segment) return undefined;
    const terminal = rest.length === 0;
    const results: unknown[] = [];

    for (const snapshot of snapshots) {
      if (segment in snapshot.values) {
        if (!terminal) continue;
        results.push(snapshot.values[segment]);
        continue;
      }
      const relationship = snapshot.relationships[segment];
      if (relationship === undefined) continue;
      const references = Array.isArray(relationship) ? relationship : [relationship];
      if (terminal) {
        results.push(...references.map((reference) => structuredClone(reference)));
        continue;
      }
      const targets: ObjectSnapshot[] = [];
      for (const reference of references) {
        const target = await this.getReference(reference);
        if (target) targets.push(target);
      }
      const nested = await this.resolveSegments(targets, rest);
      if (Array.isArray(nested)) results.push(...nested);
      else if (nested !== undefined) results.push(nested);
    }

    if (results.length === 0) return undefined;
    return results.length === 1 ? results[0] : results;
  }

  private async getReference(reference: ObjectReference): Promise<ObjectSnapshot | null> {
    const key = identityKey(reference);
    if (this.#cache.has(key)) return this.#cache.get(key) ?? null;
    const snapshot = await this.storage.get(reference);
    this.#cache.set(key, snapshot);
    return snapshot;
  }
}
