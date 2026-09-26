import {
  createDefaultArtifactGeneratorRegistry,
  type ArtifactGeneratorRegistry,
  type GeneratedArtifact,
} from "../codegen/artifact-generator.js";
import { MetadataError } from "../errors/errors.js";
import { MigrationPlanner, type MigrationPlan, type MigrationStep } from "../evolution/migration-planner.js";
import { diffObjectTypes, type SchemaDiff } from "../evolution/schema-evolution.js";
import type { MetadataCatalog } from "../metadata/metadata-catalog.js";
import type { MetadataRecord } from "../metadata/metadata-store.js";

export interface MigrationExecutionContext {
  readonly objectTypeId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
}

export interface MigrationExecutor {
  execute(step: MigrationStep, context: MigrationExecutionContext): Promise<void>;
}

export interface MetadataReleasePreparation {
  readonly objectTypeId: string;
  readonly targetVersion: number;
  readonly targetRevision: number;
  readonly previousPublishedVersion?: number;
  readonly diff?: SchemaDiff;
  readonly migrationPlan?: MigrationPlan;
  readonly artifacts: readonly GeneratedArtifact[];
}

export interface MetadataReleaseOptions {
  /** Explicit approval required before releasing a plan containing breaking changes. */
  readonly approveBreaking?: boolean;
  /** Execute blocking migration steps other than manual review. */
  readonly migrationExecutor?: MigrationExecutor;
  /** Artifact generator names. Defaults to the portable first-party release set. */
  readonly artifactGenerators?: readonly string[];
}

export interface MetadataReleaseResult extends MetadataReleasePreparation {
  readonly published: MetadataRecord;
}

const defaultArtifacts = [
  "typescript",
  "typescript-validator",
  "json-schema",
  "metadata-snapshot",
] as const;

/**
 * Coordinate metadata evolution, migration gating, publication and generated
 * release artifacts while remaining independent of a physical database.
 */
export class MetadataReleaseManager {
  constructor(
    private readonly catalog: MetadataCatalog,
    readonly planner: MigrationPlanner = new MigrationPlanner(),
    readonly artifacts: ArtifactGeneratorRegistry = createDefaultArtifactGeneratorRegistry(),
  ) {}

  async prepare(
    objectTypeId: string,
    targetVersion: number,
    artifactGenerators: readonly string[] = defaultArtifacts,
  ): Promise<MetadataReleasePreparation> {
    const targetRecord = await this.catalog.get(objectTypeId, targetVersion);
    if (!targetRecord) throw new MetadataError(`Unknown metadata '${objectTypeId}@${targetVersion}'.`);
    if (targetRecord.status !== "draft") {
      throw new MetadataError(`Metadata '${objectTypeId}@${targetVersion}' must be draft before release preparation.`);
    }
    const target = await this.catalog.getDefinition(objectTypeId, targetVersion);
    if (!target) throw new MetadataError(`Unknown metadata '${objectTypeId}@${targetVersion}'.`);

    const previous = await this.catalog.latest(objectTypeId, "published");
    if (previous && previous.objectTypeVersion >= targetVersion) {
      throw new MetadataError(
        `Target version ${targetVersion} must be greater than published version ${previous.objectTypeVersion}.`,
      );
    }

    let diff: SchemaDiff | undefined;
    let migrationPlan: MigrationPlan | undefined;
    if (previous) {
      const previousDefinition = await this.catalog.getDefinition(objectTypeId, previous.objectTypeVersion);
      if (!previousDefinition) {
        throw new MetadataError(`Published metadata '${objectTypeId}@${previous.objectTypeVersion}' cannot be loaded.`);
      }
      diff = diffObjectTypes(previousDefinition, target);
      migrationPlan = this.planner.plan(diff);
    }

    const generated = this.artifacts.generateMany(artifactGenerators, [target]);
    return {
      objectTypeId,
      targetVersion,
      targetRevision: targetRecord.revision,
      ...(previous ? { previousPublishedVersion: previous.objectTypeVersion } : {}),
      ...(diff ? { diff } : {}),
      ...(migrationPlan ? { migrationPlan } : {}),
      artifacts: generated,
    };
  }

  async release(
    objectTypeId: string,
    targetVersion: number,
    options: MetadataReleaseOptions = {},
  ): Promise<MetadataReleaseResult> {
    const preparation = await this.prepare(
      objectTypeId,
      targetVersion,
      options.artifactGenerators ?? defaultArtifacts,
    );
    const plan = preparation.migrationPlan;

    if (plan?.requiresManualReview && options.approveBreaking !== true) {
      throw new MetadataError(
        `Schema evolution '${objectTypeId}' ${plan.fromVersion} -> ${plan.toVersion} contains breaking changes and requires explicit approval.`,
      );
    }

    const executableBlocking = (plan?.steps ?? []).filter(
      (step) => step.blocking && step.kind !== "manual-review",
    );
    if (executableBlocking.length > 0 && !options.migrationExecutor) {
      throw new MetadataError(
        `Schema evolution '${objectTypeId}' requires ${executableBlocking.length} blocking migration step(s) before publication.`,
      );
    }

    if (options.migrationExecutor && plan) {
      const context: MigrationExecutionContext = {
        objectTypeId,
        fromVersion: plan.fromVersion,
        toVersion: plan.toVersion,
      };
      for (const step of executableBlocking) await options.migrationExecutor.execute(step, context);
    }

    // Ensure the draft did not move while migration work was executing.
    const current = await this.catalog.get(objectTypeId, targetVersion);
    if (!current || current.status !== "draft") {
      throw new MetadataError(`Metadata '${objectTypeId}@${targetVersion}' is no longer an unpublished draft.`);
    }
    if (current.revision !== preparation.targetRevision) {
      throw new MetadataError(
        `Metadata '${objectTypeId}@${targetVersion}' changed during release preparation; prepare the release again.`,
      );
    }

    const published = await this.catalog.publish(objectTypeId, targetVersion, preparation.targetRevision);
    return { ...preparation, published };
  }
}
