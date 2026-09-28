import { ConcurrencyError, MetadataError } from "../errors/errors.js";
import { compareStorageQueryScalar } from "../query/query-comparison.js";
import type { QueryComparisonSemanticsId } from "../query/query-capabilities.js";
import type { ObjectQuery, QueryFilter } from "../query/query.js";
import type { ObjectIdentity, ObjectSnapshot } from "../runtime/model.js";
import type { StorageAdapter, StorageBatchWrite } from "./storage-adapter.js";

const keyOf = (identity: ObjectIdentity): string => `${identity.type}:${identity.id}`;
const clone = (snapshot: ObjectSnapshot): ObjectSnapshot => structuredClone(snapshot);

function matches(
  value: unknown,
  filter: QueryFilter,
  comparisonSemantics?: QueryComparisonSemanticsId,
): boolean {
  switch (filter.operator) {
    case "eq": return Object.is(value, filter.value);
    case "neq": return !Object.is(value, filter.value);
    case "gt": return compareStorageQueryScalar(value, filter.value, comparisonSemantics) > 0;
    case "gte": return compareStorageQueryScalar(value, filter.value, comparisonSemantics) >= 0;
    case "lt": return compareStorageQueryScalar(value, filter.value, comparisonSemantics) < 0;
    case "lte": return compareStorageQueryScalar(value, filter.value, comparisonSemantics) <= 0;
    case "in": return Array.isArray(filter.value) && filter.value.some((item) => Object.is(value, item));
    case "notIn": return Array.isArray(filter.value) && !filter.value.some((item) => Object.is(value, item));
    case "contains": return typeof value === "string" && typeof filter.value === "string" && value.includes(filter.value);
    case "startsWith": return typeof value === "string" && typeof filter.value === "string" && value.startsWith(filter.value);
    case "endsWith": return typeof value === "string" && typeof filter.value === "string" && value.endsWith(filter.value);
    case "isNull": return value === null || value === undefined;
    case "isNotNull": return value !== null && value !== undefined;
  }
}

function applyWrite(store: Map<string, ObjectSnapshot>, write: StorageBatchWrite): ObjectSnapshot {
  const key = keyOf(write.snapshot);
  const current = store.get(key);
  if (write.kind === "insert") {
    if (current) throw new ConcurrencyError(`Object '${key}' already exists.`);
    const stored = { ...clone(write.snapshot), version: 1 };
    store.set(key, stored);
    return clone(stored);
  }

  if (!current) throw new ConcurrencyError(`Object '${key}' no longer exists.`);
  if (current.version !== write.expectedVersion) {
    throw new ConcurrencyError(
      `Optimistic concurrency conflict for '${key}': expected version ${write.expectedVersion}, found ${current.version}.`,
    );
  }
  const stored = { ...clone(write.snapshot), version: write.expectedVersion + 1 };
  store.set(key, stored);
  return clone(stored);
}

export class MemoryStorageAdapter implements StorageAdapter {
  readonly #store = new Map<string, ObjectSnapshot>();

  async insert(snapshot: ObjectSnapshot): Promise<ObjectSnapshot> {
    return applyWrite(this.#store, { kind: "insert", snapshot });
  }

  async update(snapshot: ObjectSnapshot, expectedVersion: number): Promise<ObjectSnapshot> {
    return applyWrite(this.#store, { kind: "update", snapshot, expectedVersion });
  }

  async saveBatch(writes: readonly StorageBatchWrite[]): Promise<readonly ObjectSnapshot[]> {
    const staged = new Map<string, ObjectSnapshot>(
      [...this.#store.entries()].map(([key, snapshot]) => [key, clone(snapshot)]),
    );
    const seen = new Set<string>();
    const results: ObjectSnapshot[] = [];
    for (const write of writes) {
      const key = keyOf(write.snapshot);
      if (seen.has(key)) throw new MetadataError(`Duplicate object batch write '${key}'.`);
      seen.add(key);
      results.push(applyWrite(staged, write));
    }
    this.#store.clear();
    for (const [key, snapshot] of staged) this.#store.set(key, clone(snapshot));
    return results.map(clone);
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
      results = results.filter((item) => matches(
        item.values[filter.attribute],
        filter,
        query.comparisonSemantics,
      ));
    }
    for (const sort of [...(query.orderBy ?? [])].reverse()) {
      results.sort((left, right) => {
        const result = compareStorageQueryScalar(
          left.values[sort.attribute],
          right.values[sort.attribute],
          query.comparisonSemantics,
        );
        return sort.direction === "desc" ? -result : result;
      });
    }
    const offset = query.offset ?? 0;
    const end = query.limit === undefined ? undefined : offset + query.limit;
    return results.slice(offset, end).map(clone);
  }
}
