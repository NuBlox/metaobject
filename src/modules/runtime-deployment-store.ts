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
  }
}
