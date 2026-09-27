import { MetadataError } from "../errors/errors.js";
import {
  digestExternalTrustRoots,
  validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord,
  type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord,
  type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotStore,
} from "./runtime-fleet-convergence-handoff-recovery-trust-policy-lifecycle-bundle-anchor-root-snapshot.js";
import {
  replayRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernance,
  type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceEventRecord,
  type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceState,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceCatalog,
} from "./runtime-fleet-convergence-handoff-recovery-trust-policy-lifecycle-bundle-anchor-root-snapshot-governance.js";
import {
  replayRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotation,
  type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationEventRecord,
  type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationState,
  RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationCatalog,
} from "./runtime-fleet-convergence-handoff-recovery-trust-policy-lifecycle-bundle-anchor-root-rotation.js";

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootChainEntry {
  readonly snapshotId: string;
  readonly rootDigest: string;
  readonly governanceStatus: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceState["status"];
  readonly predecessorRotationId?: string;
}

export interface RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootChainResolution {
  readonly format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-external-root-chain-resolution";
  readonly formatVersion: 1;
  readonly valid: true;
  readonly authoritativeSnapshotId: string;
  readonly authoritativeRootDigest: string;
  readonly lineage: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootChainEntry[];
  readonly completedRotationIds: readonly string[];
  readonly governedSnapshotCount: number;
  readonly publishedSnapshotCount: number;
  readonly verifiedAt: string;
}

export type RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootChainClock = () => Date;

export class RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootChainResolver {
  constructor(
    private readonly snapshots: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotStore,
    private readonly governance: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceCatalog,
    private readonly rotations: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationCatalog,
    private readonly clock: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootChainClock = () => new Date(),
  ) {}

  async resolve(): Promise<RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootChainResolution> {
    const snapshotRecords = await this.snapshots.list();
    const snapshotById = await this.validateSnapshots(snapshotRecords);

    const governanceEvents = await this.governance.history();
    const governanceStates = this.replayGovernance(governanceEvents, snapshotById);

    const rotationEvents = await this.rotations.history();
    const rotationStates = this.replayRotations(rotationEvents, snapshotById);
    this.validateRotationGraph(rotationStates);
    this.validateCompletedRotationGovernance(rotationStates, governanceStates, governanceEvents);

    const incomplete = [...rotationStates.values()].filter((state) => state.status !== "completed");
    if (incomplete.length > 0) {
      const ids = incomplete.map((state) => state.rotationId).sort().join(", ");
      throw new MetadataError(`External trust root authority cannot be resolved while rotations are incomplete: ${ids}.`);
    }

    const active = [...governanceStates.values()].filter((state) => state.status === "active");
    if (active.length !== 1) {
      throw new MetadataError(`External trust root authority requires exactly one active snapshot; found ${active.length}.`);
    }

    const completed = [...rotationStates.values()];
    const bySuccessor = new Map(completed.map((state) => [state.successorSnapshotId, state] as const));
    const byPredecessor = new Map(completed.map((state) => [state.predecessorSnapshotId, state] as const));
    const authoritative = active[0]!;
    if (byPredecessor.has(authoritative.snapshotId)) {
      throw new MetadataError(`Active external trust root snapshot '${authoritative.snapshotId}' is not the tip of its completed rotation lineage.`);
    }

    const reverseLineage: RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootChainEntry[] = [];
    const visited = new Set<string>();
    let snapshotId: string | undefined = authoritative.snapshotId;
    while (snapshotId !== undefined) {
      if (visited.has(snapshotId)) throw new MetadataError("External trust root completed rotation lineage contains a cycle.");
      visited.add(snapshotId);
      const snapshot = snapshotById.get(snapshotId);
      const governanceState = governanceStates.get(snapshotId);
      if (!snapshot || !governanceState) {
        throw new MetadataError(`External trust root lineage snapshot '${snapshotId}' is missing immutable snapshot or governance evidence.`);
      }
      const predecessorRotation = bySuccessor.get(snapshotId);
      reverseLineage.push({
        snapshotId,
        rootDigest: snapshot.rootDigest,
        governanceStatus: governanceState.status,
        ...(predecessorRotation === undefined ? {} : { predecessorRotationId: predecessorRotation.rotationId }),
      });
      snapshotId = predecessorRotation?.predecessorSnapshotId;
    }

    const lineage = reverseLineage.reverse();
    const lineageRotationIds = new Set(lineage.flatMap((entry) => entry.predecessorRotationId ? [entry.predecessorRotationId] : []));
    if (lineageRotationIds.size !== completed.length) {
      throw new MetadataError("Completed external trust root rotations do not form one authoritative lineage.");
    }

    const authoritativeSnapshot = snapshotById.get(authoritative.snapshotId)!;
    return {
      format: "nublox-metaobject-runtime-fleet-handoff-recovery-evidence-trust-policy-lifecycle-external-root-chain-resolution",
      formatVersion: 1,
      valid: true,
      authoritativeSnapshotId: authoritative.snapshotId,
      authoritativeRootDigest: authoritativeSnapshot.rootDigest,
      lineage,
      completedRotationIds: completed.map((state) => state.rotationId).sort(),
      governedSnapshotCount: governanceStates.size,
      publishedSnapshotCount: snapshotById.size,
      verifiedAt: this.clock().toISOString(),
    };
  }

  private async validateSnapshots(
    records: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord[],
  ): Promise<Map<string, RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord>> {
    const byId = new Map<string, RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord>();
    for (const record of records) {
      validateRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord(record);
      if (byId.has(record.snapshotId)) {
        throw new MetadataError(`External trust root snapshot '${record.snapshotId}' is duplicated.`);
      }
      if (await digestExternalTrustRoots(record.roots) !== record.rootDigest) {
        throw new MetadataError(`External trust root snapshot '${record.snapshotId}' is invalid.`);
      }
      byId.set(record.snapshotId, record);
    }
    return byId;
  }

  private replayGovernance(
    events: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceEventRecord[],
    snapshots: ReadonlyMap<string, RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord>,
  ): Map<string, RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceState> {
    const grouped = groupBy(events, (event) => event.snapshotId);
    const states = new Map<string, RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceState>();
    for (const [snapshotId, history] of grouped) {
      if (!snapshots.has(snapshotId)) {
        throw new MetadataError(`Governance references unknown external trust root snapshot '${snapshotId}'.`);
      }
      states.set(
        snapshotId,
        replayRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernance(snapshotId, history),
      );
    }
    return states;
  }

  private replayRotations(
    events: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationEventRecord[],
    snapshots: ReadonlyMap<string, RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotRecord>,
  ): Map<string, RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationState> {
    const grouped = groupBy(events, (event) => event.rotationId);
    const states = new Map<string, RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationState>();
    for (const [rotationId, history] of grouped) {
      const state = replayRuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotation(rotationId, history);
      const predecessor = snapshots.get(state.predecessorSnapshotId);
      const successor = snapshots.get(state.successorSnapshotId);
      if (!predecessor || !successor) {
        throw new MetadataError(`External trust root rotation '${rotationId}' references an unknown snapshot.`);
      }
      if (predecessor.rootDigest !== state.predecessorDigest || successor.rootDigest !== state.successorDigest) {
        throw new MetadataError(`External trust root rotation '${rotationId}' frozen digest does not match immutable snapshot evidence.`);
      }
      states.set(rotationId, state);
    }
    return states;
  }

  private validateRotationGraph(
    rotations: ReadonlyMap<string, RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationState>,
  ): void {
    const successorByPredecessor = new Map<string, string>();
    const predecessorBySuccessor = new Map<string, string>();
    for (const state of rotations.values()) {
      const existingSuccessor = successorByPredecessor.get(state.predecessorSnapshotId);
      if (existingSuccessor !== undefined && existingSuccessor !== state.successorSnapshotId) {
        throw new MetadataError(`External trust root snapshot '${state.predecessorSnapshotId}' has competing successors.`);
      }
      const existingPredecessor = predecessorBySuccessor.get(state.successorSnapshotId);
      if (existingPredecessor !== undefined && existingPredecessor !== state.predecessorSnapshotId) {
        throw new MetadataError(`External trust root snapshot '${state.successorSnapshotId}' has competing predecessors.`);
      }
      successorByPredecessor.set(state.predecessorSnapshotId, state.successorSnapshotId);
      predecessorBySuccessor.set(state.successorSnapshotId, state.predecessorSnapshotId);
    }

    for (const start of successorByPredecessor.keys()) {
      const visited = new Set<string>();
      let cursor: string | undefined = start;
      while (cursor !== undefined) {
        if (visited.has(cursor)) throw new MetadataError("External trust root rotation graph contains a cycle.");
        visited.add(cursor);
        cursor = successorByPredecessor.get(cursor);
      }
    }
  }

  private validateCompletedRotationGovernance(
    rotations: ReadonlyMap<string, RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootRotationState>,
    governanceStates: ReadonlyMap<string, RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceState>,
    governanceEvents: readonly RuntimeFleetHandoffRecoveryEvidenceTrustPolicyLifecycleExternalTrustRootSnapshotGovernanceEventRecord[],
  ): void {
    for (const state of rotations.values()) {
      if (state.status !== "completed") continue;
      const predecessor = governanceStates.get(state.predecessorSnapshotId);
      const successor = governanceStates.get(state.successorSnapshotId);
      if (!predecessor || !successor) {
        throw new MetadataError(`Completed external trust root rotation '${state.rotationId}' lacks governance evidence.`);
      }
      if (predecessor.status === "active") {
        throw new MetadataError(`Completed external trust root rotation '${state.rotationId}' left its predecessor active.`);
      }
      const activationEventId = `${state.rotationId}:m60:activate-successor`;
      const retirementEventId = `${state.rotationId}:m60:retire-predecessor`;
      if (!governanceEvents.some((event) => event.eventId === activationEventId && event.snapshotId === state.successorSnapshotId && event.type === "activated")) {
        throw new MetadataError(`Completed external trust root rotation '${state.rotationId}' lacks its exact successor activation evidence.`);
      }
      if (!governanceEvents.some((event) => event.eventId === retirementEventId && event.snapshotId === state.predecessorSnapshotId && event.type === "retired")) {
        throw new MetadataError(`Completed external trust root rotation '${state.rotationId}' lacks its exact predecessor retirement evidence.`);
      }
    }
  }
}

function groupBy<T>(values: readonly T[], key: (value: T) => string): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const id = key(value);
    const bucket = grouped.get(id);
    if (bucket) bucket.push(value);
    else grouped.set(id, [value]);
  }
  return grouped;
}
