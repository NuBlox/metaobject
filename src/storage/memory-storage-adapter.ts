import { ConcurrencyError } from "../errors/errors.js";
import type { ObjectQuery, QueryFilter } from "../query/query.js";
import type { ObjectIdentity, ObjectSnapshot } from "../runtime/model.js";
import type { StorageAdapter } from "./storage-adapter.js";

const keyOf = (identity: ObjectIdentity): string => `${identity.type}:${identity.id}`;
const clone = (snapshot: ObjectSnapshot): ObjectSnapshot => structuredClone(snapshot);

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

export class MemoryStorageAdapter implements StorageAdapter {
  readonly #store = new Map<string, ObjectSnapshot>();

  async insert(snapshot: ObjectSnapshot): Promise<ObjectSnapshot> {
    const key = keyOf(snapshot);
    if (this.#store.has(key)) throw new ConcurrencyError(`Object '${key}' already exists.`);
    const stored = { ...clone(snapshot), version: 1 };
    this.#store.set(key, stored);
    return clone(stored);
  }

  async update(snapshot: ObjectSnapshot, expectedVersion: number): Promise<ObjectSnapshot> {
    const key = keyOf(snapshot);
    const current = this.#store.get(key);
    if (!current) throw new ConcurrencyError(`Object '${key}' no longer exists.`);
    if (current.version !== expectedVersion) {
      throw new ConcurrencyError(`Optimistic concurrency conflict for '${key}': expected version ${expectedVersion}, found ${current.version}.`);
    }
    const stored = { ...clone(snapshot), version: expectedVersion + 1 };
    this.#store.set(key, stored);
    return clone(stored);
  }

  async delete(identity: ObjectIdentity, expectedVersion: number): Promise<void> {
    const key = keyOf(identity);
    const current = this.#store.get(key);
    if (!current) return;
    if (current.version !== expectedVersion) {
      throw new ConcurrencyError(`Optimistic concurrency conflict for '${key}': expected version ${expectedVersion}, found ${current.version}.`);
    }
    this.#store.delete(key);
  }

  async get(identity: ObjectIdentity): Promise<ObjectSnapshot | null> {
    const snapshot = this.#store.get(keyOf(identity));
    return snapshot ? clone(snapshot) : null;
  }

  async query(query: ObjectQuery): Promise<readonly ObjectSnapshot[]> {
    let results = [...this.#store.values()].filter((item) => item.type === query.objectType);
    for (const filter of query.where ?? []) {
      results = results.filter((item) => matches(item.values[filter.attribute], filter));
    }
    for (const sort of [...(query.orderBy ?? [])].reverse()) {
      results.sort((left, right) => {
        const result = compare(left.values[sort.attribute], right.values[sort.attribute]);
        return sort.direction === "desc" ? -result : result;
      });
    }
    const offset = query.offset ?? 0;
    const end = query.limit === undefined ? undefined : offset + query.limit;
    return results.slice(offset, end).map(clone);
  }
}
