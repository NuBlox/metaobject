import { MetadataError } from "../errors/errors.js";
import type { RuntimeProfileUpgradePlan } from "./runtime-profile-upgrade.js";

export type RuntimeDeploymentStatus = "planned" | "running" | "failed" | "completed" | "cancelled";
export type RuntimeDeploymentStepStatus = "pending" | "running" | "failed" | "completed";

/** Structured evidence returned by an external deployment executor. */
export interface RuntimeDeploymentStepEvidence {
  readonly recordedAt: string;
  readonly externalReference?: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type RuntimeDeploymentJournalKind =
  | "deployment-created"
  | "deployment-approved"
  | "deployment-policy-evaluated"
  | "deployment-started"
  | "deployment-cancelled"
  | "deployment-completed"
  | "step-leased"
  | "step-completed"
  | "step-failed"
  | "step-retry-requested"
  | "step-recovered-completed"
  | "step-reconciliation-unknown";

export interface RuntimeDeploymentJournalEntry {
  /** 1-based monotonically increasing sequence within one deployment. */
  readonly sequence: number;
  readonly kind: RuntimeDeploymentJournalKind;
  readonly occurredAt: string;
  readonly stepId?: string;
  readonly attempt?: number;
  readonly executorId?: string;
  readonly idempotencyKey?: string;
  readonly error?: string;
  readonly recoveryResolution?: "retry" | "completed" | "unknown";
  readonly policyId?: string;
  readonly policyOutcome?: "allow" | "warn" | "deny";
  readonly message?: string;
  readonly evidence?: RuntimeDeploymentStepEvidence;
}

export type RuntimeDeploymentJournalEvent = Omit<RuntimeDeploymentJournalEntry, "sequence">;

export interface RuntimeDeploymentStepState {
  readonly stepId: string;
  readonly status: RuntimeDeploymentStepStatus;
  readonly attempts: number;
  /** Executor identity is locked on the first durable lease. */
  readonly executorId?: string;
  /** Stable token that an executor must use to deduplicate/reconcile side effects. */
  readonly idempotencyKey?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly lastError?: string;
  readonly evidence?: RuntimeDeploymentStepEvidence;
}

export interface RuntimeDeploymentRecord {
  readonly deploymentId: string;
  readonly status: RuntimeDeploymentStatus;
  readonly revision: number;
  readonly profileId: string;
  readonly fromProfileVersion: number;
  readonly toProfileVersion: number;
  /** Immutable M16 plan snapshot captured when the deployment is created. */
  readonly plan: RuntimeProfileUpgradePlan;
  readonly steps: readonly RuntimeDeploymentStepState[];
  /** Append-only audit trail. Optional only for backwards-compatible legacy records. */
  readonly journal?: readonly RuntimeDeploymentJournalEntry[];
  readonly approvedAt?: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly cancelledAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RuntimeDeploymentRecordFilter {
  readonly status?: RuntimeDeploymentStatus;
  readonly profileId?: string;
}

export interface RuntimeDeploymentStore {
  get(deploymentId: string): Promise<RuntimeDeploymentRecord | null>;
  list(filter?: RuntimeDeploymentRecordFilter): Promise<readonly RuntimeDeploymentRecord[]>;
  save(record: RuntimeDeploymentRecord, expectedRevision?: number): Promise<RuntimeDeploymentRecord>;
  delete(deploymentId: string, expectedRevision: number): Promise<void>;
}

export interface RuntimeDeploymentBundle {
  readonly format: "nublox-metaobject-runtime-deployments";
  readonly formatVersion: 1;
  readonly records: readonly RuntimeDeploymentRecord[];
}

export function appendRuntimeDeploymentJournal(
  record: Pick<RuntimeDeploymentRecord, "journal">,
  ...events: readonly RuntimeDeploymentJournalEvent[]
): readonly RuntimeDeploymentJournalEntry[] {
  const existing = record.journal ?? [];
  let sequence = existing.length === 0 ? 0 : existing[existing.length - 1]!.sequence;
  return [
    ...structuredClone(existing),
    ...events.map((event) => ({ ...structuredClone(event), sequence: ++sequence })),
  ];
}

/** Validate sequence/order and basic event integrity before persistence/import. */
export function validateRuntimeDeploymentJournal(record: Pick<RuntimeDeploymentRecord, "deploymentId" | "journal">): void {
  const journal = record.journal;
  if (journal === undefined) return;

  for (let index = 0; index < journal.length; index += 1) {
    const entry = journal[index]!;
    if (entry.sequence !== index + 1) {
      throw new MetadataError(
        `Runtime deployment '${record.deploymentId}' journal sequence ${entry.sequence} is invalid at position ${index + 1}.`,
      );
    }
    if (!entry.occurredAt.trim()) {
      throw new MetadataError(`Runtime deployment '${record.deploymentId}' journal entry ${entry.sequence} is missing occurredAt.`);
    }
    if (entry.stepId !== undefined && !entry.stepId.trim()) {
      throw new MetadataError(`Runtime deployment '${record.deploymentId}' journal entry ${entry.sequence} has an empty stepId.`);
    }
    if (entry.attempt !== undefined && (!Number.isSafeInteger(entry.attempt) || entry.attempt < 1)) {
      throw new MetadataError(`Runtime deployment '${record.deploymentId}' journal entry ${entry.sequence} has an invalid attempt.`);
    }
    if (entry.executorId !== undefined && !entry.executorId.trim()) {
      throw new MetadataError(`Runtime deployment '${record.deploymentId}' journal entry ${entry.sequence} has an empty executorId.`);
    }
    if (entry.idempotencyKey !== undefined && !entry.idempotencyKey.trim()) {
      throw new MetadataError(`Runtime deployment '${record.deploymentId}' journal entry ${entry.sequence} has an empty idempotencyKey.`);
    }
    if (entry.error !== undefined && !entry.error.trim()) {
      throw new MetadataError(`Runtime deployment '${record.deploymentId}' journal entry ${entry.sequence} has an empty error.`);
    }
    if (entry.message !== undefined && !entry.message.trim()) {
      throw new MetadataError(`Runtime deployment '${record.deploymentId}' journal entry ${entry.sequence} has an empty message.`);
    }
    if (entry.kind === "deployment-policy-evaluated") {
      if (!entry.policyId?.trim()) {
        throw new MetadataError(`Runtime deployment '${record.deploymentId}' policy journal entry ${entry.sequence} is missing policyId.`);
      }
      if (entry.policyOutcome === undefined) {
        throw new MetadataError(`Runtime deployment '${record.deploymentId}' policy journal entry ${entry.sequence} is missing policyOutcome.`);
      }
      if (entry.policyOutcome !== "allow" && !entry.message?.trim()) {
        throw new MetadataError(
          `Runtime deployment '${record.deploymentId}' ${entry.policyOutcome} policy journal entry ${entry.sequence} requires a message.`,
        );
      }
    }
  }
}

function structuralEqual(
  left: unknown,
  right: unknown,
  seen: WeakMap<object, WeakSet<object>> = new WeakMap(),
): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;

  const previouslyCompared = seen.get(left);
  if (previouslyCompared?.has(right)) return true;
  const rightSet = previouslyCompared ?? new WeakSet<object>();
  rightSet.add(right);
  if (!previouslyCompared) seen.set(left, rightSet);

  if (left instanceof Date || right instanceof Date) {
    return left instanceof Date && right instanceof Date && left.getTime() === right.getTime();
  }
  if (left instanceof Uint8Array || right instanceof Uint8Array) {
    return left instanceof Uint8Array
      && right instanceof Uint8Array
      && left.length === right.length
      && left.every((value, index) => value === right[index]);
  }
  if (left instanceof ArrayBuffer || right instanceof ArrayBuffer) {
    if (!(left instanceof ArrayBuffer) || !(right instanceof ArrayBuffer) || left.byteLength !== right.byteLength) return false;
    return structuralEqual(new Uint8Array(left), new Uint8Array(right), seen);
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => structuralEqual(value, right[index], seen));
  }
  if (left instanceof Map || right instanceof Map) {
    if (!(left instanceof Map) || !(right instanceof Map) || left.size !== right.size) return false;
    const unmatched = [...right.entries()];
    return [...left.entries()].every(([leftKey, leftValue]) => {
      const index = unmatched.findIndex(
        ([rightKey, rightValue]) => structuralEqual(leftKey, rightKey, seen) && structuralEqual(leftValue, rightValue, seen),
      );
      if (index < 0) return false;
      unmatched.splice(index, 1);
      return true;
    });
  }
  if (left instanceof Set || right instanceof Set) {
    if (!(left instanceof Set) || !(right instanceof Set) || left.size !== right.size) return false;
    const unmatched = [...right.values()];
    return [...left.values()].every((leftValue) => {
      const index = unmatched.findIndex((rightValue) => structuralEqual(leftValue, rightValue, seen));
      if (index < 0) return false;
      unmatched.splice(index, 1);
      return true;
    });
  }

  const leftKeys = Object.keys(left as Record<string, unknown>).sort();
  const rightKeys = Object.keys(right as Record<string, unknown>).sort();
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key, index) => key !== rightKeys[index])) return false;
  return leftKeys.every((key) => structuralEqual(
    (left as Record<string, unknown>)[key],
    (right as Record<string, unknown>)[key],
    seen,
  ));
}

/**
 * Ensure an already-persisted journal can only grow by appending new entries.
 * Existing journal entries may never be removed, reordered or rewritten.
 */
export function assertRuntimeDeploymentJournalAppendOnly(
  current: Pick<RuntimeDeploymentRecord, "deploymentId" | "journal">,
  next: Pick<RuntimeDeploymentRecord, "deploymentId" | "journal">,
): void {
  if (current.deploymentId !== next.deploymentId) {
    throw new MetadataError(
      `Cannot compare runtime deployment journals for different deployments '${current.deploymentId}' and '${next.deploymentId}'.`,
    );
  }

  const existing = current.journal;
  if (existing === undefined || existing.length === 0) return;
  const candidate = next.journal;
  if (candidate === undefined) {
    throw new MetadataError(`Runtime deployment '${current.deploymentId}' journal cannot be removed once established.`);
  }
  if (candidate.length < existing.length) {
    throw new MetadataError(
      `Runtime deployment '${current.deploymentId}' journal cannot be truncated from ${existing.length} to ${candidate.length} entries.`,
    );
  }

  for (let index = 0; index < existing.length; index += 1) {
    if (!structuralEqual(existing[index], candidate[index])) {
      throw new MetadataError(
        `Runtime deployment '${current.deploymentId}' journal entry ${index + 1} is immutable and cannot be rewritten.`,
      );
    }
  }
}
