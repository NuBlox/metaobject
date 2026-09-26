import type { RuntimeProfileUpgradePlan } from "./runtime-profile-upgrade.js";

export type RuntimeDeploymentStatus = "planned" | "running" | "failed" | "completed" | "cancelled";
export type RuntimeDeploymentStepStatus = "pending" | "running" | "failed" | "completed";

export interface RuntimeDeploymentStepState {
  readonly stepId: string;
  readonly status: RuntimeDeploymentStepStatus;
  readonly attempts: number;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly lastError?: string;
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
