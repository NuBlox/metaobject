import { ConcurrencyError } from "../errors/errors.js";
import type {
  RuntimeDeploymentRecord,
  RuntimeDeploymentRecordFilter,
  RuntimeDeploymentStore,
} from "./runtime-deployment-store.js";

function clone(record: RuntimeDeploymentRecord): RuntimeDeploymentRecord {
  return structuredClone(record);
}

export class MemoryRuntimeDeploymentStore implements RuntimeDeploymentStore {
  readonly #records = new Map<string, RuntimeDeploymentRecord>();

  async get(deploymentId: string): Promise<RuntimeDeploymentRecord | null> {
    const record = this.#records.get(deploymentId);
    return record ? clone(record) : null;
  }

  async list(filter: RuntimeDeploymentRecordFilter = {}): Promise<readonly RuntimeDeploymentRecord[]> {
    return [...this.#records.values()]
      .filter((record) => filter.status === undefined || record.status === filter.status)
      .filter((record) => filter.profileId === undefined || record.profileId === filter.profileId)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.deploymentId.localeCompare(right.deploymentId))
      .map(clone);
  }

  async save(record: RuntimeDeploymentRecord, expectedRevision?: number): Promise<RuntimeDeploymentRecord> {
    const current = this.#records.get(record.deploymentId);
    if (current) {
      if (expectedRevision === undefined) {
        throw new ConcurrencyError(`Runtime deployment '${record.deploymentId}' already exists; expectedRevision is required.`);
      }
      if (current.revision !== expectedRevision) {
        throw new ConcurrencyError(
          `Runtime deployment concurrency conflict for '${record.deploymentId}': expected revision ${expectedRevision}, found ${current.revision}.`,
        );
      }
    } else if (expectedRevision !== undefined && expectedRevision !== 0) {
      throw new ConcurrencyError(
        `Runtime deployment '${record.deploymentId}' does not exist; expected revision ${expectedRevision} cannot be satisfied.`,
      );
    }

    const stored = clone({
      ...record,
      revision: (current?.revision ?? 0) + 1,
      createdAt: current?.createdAt ?? record.createdAt,
    });
    this.#records.set(record.deploymentId, stored);
    return clone(stored);
  }

  async delete(deploymentId: string, expectedRevision: number): Promise<void> {
    const current = this.#records.get(deploymentId);
    if (!current) return;
    if (current.revision !== expectedRevision) {
      throw new ConcurrencyError(
        `Runtime deployment concurrency conflict for '${deploymentId}': expected revision ${expectedRevision}, found ${current.revision}.`,
      );
    }
    this.#records.delete(deploymentId);
  }
}
