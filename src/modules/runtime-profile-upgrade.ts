import { MetadataError } from "../errors/errors.js";
import { MigrationPlanner, type MigrationPlan } from "../evolution/migration-planner.js";
import { diffObjectTypes, type SchemaChangeImpact, type SchemaDiff } from "../evolution/schema-evolution.js";
import type { MetadataCatalog } from "../metadata/metadata-catalog.js";
import type { MetadataModuleSetLockfile, MetadataModuleSetModuleLock } from "./module-set.js";
import type { RuntimeProfileCatalog } from "./runtime-profile-catalog.js";
import type { RuntimeProfileRecord } from "./runtime-profile-store.js";

export type RuntimeProfileUpgradeModuleChangeKind = "added" | "removed" | "upgraded" | "downgraded";
export type RuntimeProfileUpgradeObjectChangeKind = "added" | "removed" | "upgraded" | "downgraded" | "moved";

export interface RuntimeProfileUpgradeModuleChange {
  readonly moduleId: string;
  readonly kind: RuntimeProfileUpgradeModuleChangeKind;
  readonly fromVersion?: number;
  readonly toVersion?: number;
}

export interface RuntimeProfileUpgradeObjectChange {
  readonly objectTypeId: string;
  readonly kind: RuntimeProfileUpgradeObjectChangeKind;
  readonly fromVersion?: number;
  readonly toVersion?: number;
  readonly fromModuleId?: string;
  readonly toModuleId?: string;
  readonly diff?: SchemaDiff;
  readonly migrationPlan?: MigrationPlan;
}

export type RuntimeProfileUpgradeStepKind =
  | "add-module"
  | "upgrade-module"
  | "downgrade-module"
  | "add-object-type"
  | "migrate-object-type"
  | "downgrade-object-type"
  | "move-object-type"
  | "remove-object-type"
  | "remove-module";

export interface RuntimeProfileUpgradeStep {
  readonly id: string;
  readonly kind: RuntimeProfileUpgradeStepKind;
  readonly moduleId: string;
  readonly objectTypeId?: string;
  readonly fromVersion?: number;
  readonly toVersion?: number;
  readonly blocking: boolean;
  readonly requiresManualReview: boolean;
  readonly description: string;
  readonly migrationPlan?: MigrationPlan;
}

export interface RuntimeProfileUpgradePlan {
  readonly format: "nublox-metaobject-runtime-profile-upgrade";
  readonly formatVersion: 1;
  readonly profileId: string;
  readonly fromProfileVersion: number;
  readonly toProfileVersion: number;
  readonly impact: SchemaChangeImpact;
  readonly requiresManualReview: boolean;
  readonly blockingStepCount: number;
  readonly moduleChanges: readonly RuntimeProfileUpgradeModuleChange[];
  readonly objectChanges: readonly RuntimeProfileUpgradeObjectChange[];
  /** Target dependency order first; removals are emitted in reverse source dependency order. */
  readonly steps: readonly RuntimeProfileUpgradeStep[];
}

interface LockedObjectMember {
  readonly objectTypeId: string;
  readonly version: number;
  readonly moduleId: string;
  readonly moduleVersion: number;
  readonly moduleIndex: number;
}

const impactRank: Readonly<Record<SchemaChangeImpact, number>> = {
  compatible: 0,
  "requires-migration": 1,
  breaking: 2,
};

function worseImpact(left: SchemaChangeImpact, right: SchemaChangeImpact): SchemaChangeImpact {
  return impactRank[right] > impactRank[left] ? right : left;
}

function moduleMap(lockfile: MetadataModuleSetLockfile): Map<string, MetadataModuleSetModuleLock> {
  return new Map(lockfile.modules.map((module) => [module.moduleId, module]));
}

function objectMap(lockfile: MetadataModuleSetLockfile): Map<string, LockedObjectMember> {
  const members = new Map<string, LockedObjectMember>();
  lockfile.modules.forEach((module, moduleIndex) => {
    for (const member of module.members) {
      members.set(member.objectTypeId, {
        objectTypeId: member.objectTypeId,
        version: member.version,
        moduleId: module.moduleId,
        moduleVersion: module.version,
        moduleIndex,
      });
    }
  });
  return members;
}

function stepId(ordinal: number, kind: RuntimeProfileUpgradeStepKind, subject: string): string {
  return `${String(ordinal + 1).padStart(3, "0")}:${kind}:${subject}`;
}

/**
 * Compare two exact activated runtime-profile states and produce a deterministic,
 * database-neutral deployment plan. Target work follows dependency-first module
 * order; removals run in reverse source dependency order.
 */
export class RuntimeProfileUpgradePlanner {
  constructor(
    private readonly profiles: RuntimeProfileCatalog,
    private readonly metadata: MetadataCatalog,
    readonly migrations: MigrationPlanner = new MigrationPlanner(),
  ) {}

  async plan(profileId: string, fromVersion: number, toVersion: number): Promise<RuntimeProfileUpgradePlan> {
    if (toVersion <= fromVersion) {
      throw new MetadataError(
        `Runtime profile upgrade requires target version ${toVersion} to be greater than source version ${fromVersion}.`,
      );
    }

    const source = await this.requireLockedProfile(profileId, fromVersion);
    const target = await this.requireLockedProfile(profileId, toVersion);

    // Rebuild both registries as an integrity check before planning against the locks.
    await this.profiles.buildObjectTypeRegistry(profileId, fromVersion);
    await this.profiles.buildObjectTypeRegistry(profileId, toVersion);

    const sourceLock = source.lockfile!;
    const targetLock = target.lockfile!;
    const sourceModules = moduleMap(sourceLock);
    const targetModules = moduleMap(targetLock);
    const sourceObjects = objectMap(sourceLock);
    const targetObjects = objectMap(targetLock);

    const moduleChanges: RuntimeProfileUpgradeModuleChange[] = [];
    const objectChanges: RuntimeProfileUpgradeObjectChange[] = [];
    const steps: RuntimeProfileUpgradeStep[] = [];
    let impact: SchemaChangeImpact = "compatible";

    const addStep = (step: Omit<RuntimeProfileUpgradeStep, "id">): void => {
      const subject = step.objectTypeId ?? step.moduleId;
      steps.push({ ...step, id: stepId(steps.length, step.kind, subject) });
    };

    // Add/upgrade/downgrade target modules in target dependency-first order.
    for (const targetModule of targetLock.modules) {
      const sourceModule = sourceModules.get(targetModule.moduleId);
      if (!sourceModule) {
        moduleChanges.push({ moduleId: targetModule.moduleId, kind: "added", toVersion: targetModule.version });
        addStep({
          kind: "add-module",
          moduleId: targetModule.moduleId,
          toVersion: targetModule.version,
          blocking: false,
          requiresManualReview: false,
          description: `Add module '${targetModule.moduleId}@${targetModule.version}'.`,
        });
      } else if (sourceModule.version !== targetModule.version) {
        const downgrade = targetModule.version < sourceModule.version;
        moduleChanges.push({
          moduleId: targetModule.moduleId,
          kind: downgrade ? "downgraded" : "upgraded",
          fromVersion: sourceModule.version,
          toVersion: targetModule.version,
        });
        if (downgrade) impact = "breaking";
        addStep({
          kind: downgrade ? "downgrade-module" : "upgrade-module",
          moduleId: targetModule.moduleId,
          fromVersion: sourceModule.version,
          toVersion: targetModule.version,
          blocking: downgrade,
          requiresManualReview: downgrade,
          description: downgrade
            ? `Downgrade module '${targetModule.moduleId}' from ${sourceModule.version} to ${targetModule.version}; explicit compatibility review is required.`
            : `Upgrade module '${targetModule.moduleId}' from ${sourceModule.version} to ${targetModule.version}.`,
        });
      }

      // Object work follows the owning target module so dependency modules are handled first.
      for (const targetMember of targetModule.members) {
        const sourceMember = sourceObjects.get(targetMember.objectTypeId);
        if (!sourceMember) {
          objectChanges.push({
            objectTypeId: targetMember.objectTypeId,
            kind: "added",
            toVersion: targetMember.version,
            toModuleId: targetModule.moduleId,
          });
          addStep({
            kind: "add-object-type",
            moduleId: targetModule.moduleId,
            objectTypeId: targetMember.objectTypeId,
            toVersion: targetMember.version,
            blocking: false,
            requiresManualReview: false,
            description: `Add object type '${targetMember.objectTypeId}@${targetMember.version}'.`,
          });
          continue;
        }

        if (sourceMember.version === targetMember.version) {
          if (sourceMember.moduleId !== targetModule.moduleId) {
            objectChanges.push({
              objectTypeId: targetMember.objectTypeId,
              kind: "moved",
              fromVersion: sourceMember.version,
              toVersion: targetMember.version,
              fromModuleId: sourceMember.moduleId,
              toModuleId: targetModule.moduleId,
            });
            addStep({
              kind: "move-object-type",
              moduleId: targetModule.moduleId,
              objectTypeId: targetMember.objectTypeId,
              fromVersion: sourceMember.version,
              toVersion: targetMember.version,
              blocking: false,
              requiresManualReview: false,
              description: `Move object type '${targetMember.objectTypeId}' ownership from module '${sourceMember.moduleId}' to '${targetModule.moduleId}'.`,
            });
          }
          continue;
        }

        if (targetMember.version < sourceMember.version) {
          impact = "breaking";
          objectChanges.push({
            objectTypeId: targetMember.objectTypeId,
            kind: "downgraded",
            fromVersion: sourceMember.version,
            toVersion: targetMember.version,
            fromModuleId: sourceMember.moduleId,
            toModuleId: targetModule.moduleId,
          });
          addStep({
            kind: "downgrade-object-type",
            moduleId: targetModule.moduleId,
            objectTypeId: targetMember.objectTypeId,
            fromVersion: sourceMember.version,
            toVersion: targetMember.version,
            blocking: true,
            requiresManualReview: true,
            description: `Downgrade object type '${targetMember.objectTypeId}' from ${sourceMember.version} to ${targetMember.version}; automatic reverse migration is not inferred.`,
          });
          continue;
        }

        const before = await this.metadata.getDefinition(targetMember.objectTypeId, sourceMember.version);
        const after = await this.metadata.getDefinition(targetMember.objectTypeId, targetMember.version);
        if (!before || !after) {
          throw new MetadataError(
            `Cannot plan '${targetMember.objectTypeId}' ${sourceMember.version} -> ${targetMember.version}; exact metadata definitions are unavailable.`,
          );
        }
        const diff = diffObjectTypes(before, after);
        const migrationPlan = this.migrations.plan(diff);
        impact = worseImpact(impact, diff.impact);
        objectChanges.push({
          objectTypeId: targetMember.objectTypeId,
          kind: "upgraded",
          fromVersion: sourceMember.version,
          toVersion: targetMember.version,
          fromModuleId: sourceMember.moduleId,
          toModuleId: targetModule.moduleId,
          diff,
          migrationPlan,
        });
        addStep({
          kind: "migrate-object-type",
          moduleId: targetModule.moduleId,
          objectTypeId: targetMember.objectTypeId,
          fromVersion: sourceMember.version,
          toVersion: targetMember.version,
          blocking: migrationPlan.steps.some((step) => step.blocking),
          requiresManualReview: migrationPlan.requiresManualReview,
          description: `Migrate object type '${targetMember.objectTypeId}' from ${sourceMember.version} to ${targetMember.version} (${diff.impact}).`,
          migrationPlan,
        });
      }
    }

    // Remove object types/capabilities in reverse source dependency order so dependents leave first.
    for (const sourceModule of [...sourceLock.modules].reverse()) {
      for (const sourceMember of [...sourceModule.members].reverse()) {
        if (targetObjects.has(sourceMember.objectTypeId)) continue;
        impact = "breaking";
        objectChanges.push({
          objectTypeId: sourceMember.objectTypeId,
          kind: "removed",
          fromVersion: sourceMember.version,
          fromModuleId: sourceModule.moduleId,
        });
        addStep({
          kind: "remove-object-type",
          moduleId: sourceModule.moduleId,
          objectTypeId: sourceMember.objectTypeId,
          fromVersion: sourceMember.version,
          blocking: true,
          requiresManualReview: true,
          description: `Remove object type '${sourceMember.objectTypeId}@${sourceMember.version}'; data retention/removal must be explicitly approved.`,
        });
      }

      if (targetModules.has(sourceModule.moduleId)) continue;
      impact = "breaking";
      moduleChanges.push({ moduleId: sourceModule.moduleId, kind: "removed", fromVersion: sourceModule.version });
      addStep({
        kind: "remove-module",
        moduleId: sourceModule.moduleId,
        fromVersion: sourceModule.version,
        blocking: true,
        requiresManualReview: true,
        description: `Remove module '${sourceModule.moduleId}@${sourceModule.version}'.`,
      });
    }

    if (impact === "compatible" && steps.some((step) => step.blocking)) impact = "requires-migration";
    if (steps.some((step) => step.requiresManualReview)) impact = "breaking";

    return {
      format: "nublox-metaobject-runtime-profile-upgrade",
      formatVersion: 1,
      profileId,
      fromProfileVersion: fromVersion,
      toProfileVersion: toVersion,
      impact,
      requiresManualReview: steps.some((step) => step.requiresManualReview),
      blockingStepCount: steps.filter((step) => step.blocking).length,
      moduleChanges,
      objectChanges,
      steps,
    };
  }

  private async requireLockedProfile(profileId: string, version: number): Promise<RuntimeProfileRecord> {
    const record = await this.profiles.get(profileId, version);
    if (!record) throw new MetadataError(`Unknown runtime profile '${profileId}@${version}'.`);
    if (record.status === "draft") {
      throw new MetadataError(`Runtime profile '${profileId}@${version}' must be active or deprecated before upgrade planning.`);
    }
    if (!record.lockfile) throw new MetadataError(`Runtime profile '${profileId}@${version}' is missing its lockfile.`);
    return record;
  }
}
