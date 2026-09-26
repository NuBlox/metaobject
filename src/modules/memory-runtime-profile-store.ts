import { ConcurrencyError } from "../errors/errors.js";
import type {
  RuntimeProfileRecord,
  RuntimeProfileRecordFilter,
  RuntimeProfileStore,
} from "./runtime-profile-store.js";

function keyOf(profileId: string, version: number): string {
  return `${profileId}@${version}`;
}

function clone(record: RuntimeProfileRecord): RuntimeProfileRecord {
  return structuredClone(record);
}

export class MemoryRuntimeProfileStore implements RuntimeProfileStore {
  readonly #records = new Map<string, RuntimeProfileRecord>();

  async get(profileId: string, version: number): Promise<RuntimeProfileRecord | null> {
    const record = this.#records.get(keyOf(profileId, version));
    return record ? clone(record) : null;
  }

  async list(filter: RuntimeProfileRecordFilter = {}): Promise<readonly RuntimeProfileRecord[]> {
    return [...this.#records.values()]
      .filter((record) => filter.profileId === undefined || record.profileId === filter.profileId)
      .filter((record) => filter.status === undefined || record.status === filter.status)
      .sort((left, right) => left.profileId.localeCompare(right.profileId) || left.profileVersion - right.profileVersion)
      .map(clone);
  }

  async save(record: RuntimeProfileRecord, expectedRevision?: number): Promise<RuntimeProfileRecord> {
    const key = keyOf(record.profileId, record.profileVersion);
    const current = this.#records.get(key);
    if (current) {
      if (expectedRevision === undefined) {
        throw new ConcurrencyError(`Runtime profile '${key}' already exists; expectedRevision is required.`);
      }
      if (current.revision !== expectedRevision) {
        throw new ConcurrencyError(
          `Runtime profile concurrency conflict for '${key}': expected revision ${expectedRevision}, found ${current.revision}.`,
        );
      }
    } else if (expectedRevision !== undefined && expectedRevision !== 0) {
      throw new ConcurrencyError(
        `Runtime profile '${key}' does not exist; expected revision ${expectedRevision} cannot be satisfied.`,
      );
    }

    const stored = clone({
      ...record,
      revision: (current?.revision ?? 0) + 1,
      createdAt: current?.createdAt ?? record.createdAt,
    });
    this.#records.set(key, stored);
    return clone(stored);
  }

  async delete(profileId: string, version: number, expectedRevision: number): Promise<void> {
    const key = keyOf(profileId, version);
    const current = this.#records.get(key);
    if (!current) return;
    if (current.revision !== expectedRevision) {
      throw new ConcurrencyError(
        `Runtime profile concurrency conflict for '${key}': expected revision ${expectedRevision}, found ${current.revision}.`,
      );
    }
    this.#records.delete(key);
  }
}
