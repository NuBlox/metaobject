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

export interface MetadataReleaseRequest {
  readonly objectTypeId: string;
  readonly targetVersion: number;
}

export interface MetadataReleasePreparation extends MetadataReleaseRequest {
  readonly targetRevision: number;
  readonly previousPublishedVersion?: number;
  readonly diff?: SchemaDiff;
  readonly migrationPlan?: MigrationPlan;
  readonly artifacts: readonly GeneratedArtifact[];
}

export interface MetadataBatchReleasePreparation {
  readonly releases: readonly MetadataReleasePreparation[];
  readonly artifacts: readonly GeneratedArtifact[];
  readonly requiresManualReview: boolean;
  readonly blockingMigrationSteps: number;
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

export interface MetadataBatchReleaseResult extends MetadataBatchReleasePreparation {
  readonly published: readonly MetadataRecord[];
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

  async prepareMany(
    requests: readonly MetadataReleaseRequest[],
    artifactGenerators: readonly string[] = defaultArtifacts,
  ): Promise<MetadataBatchReleasePreparation> {
    const objectTypeIds = new Set<string>();
    for (const request of requests) {
      if (objectTypeIds.has(request.objectTypeId)) {
        throw new MetadataError(`Duplicate object type '${request.objectTypeId}' in metadata release batch.`);
      }
      objectTypeIds.add(request.objectTypeId);
    }

    const releases: MetadataReleasePreparation[] = [];
    for (const request of requests) {
      releases.push(await this.prepare(request.objectTypeId, request.targetVersion, artifactGenerators));
    }
    const blockingMigrationSteps = releases.reduce(
      (total, release) => total + this.executableBlockingSteps(release).length,
      0,
    );
    return {
      releases,
      artifacts: releases.flatMap((release) => release.artifacts),
      requiresManualReview: releases.some((release) => release.migrationPlan?.requiresManualReview === true),
      blockingMigrationSteps,
    };
  }

  async release(
    objectTypeId: string,
    targetVersion: number,
    options: MetadataReleaseOptions = {},
  ): Promise<MetadataReleaseResult> {
    const batch = await this.releaseMany([{ objectTypeId, targetVersion }], options);
    const preparation = batch.releases[0]!;
    return { ...preparation, published: batch.published[0]! };
  }

  async releaseMany(
    requests: readonly MetadataReleaseRequest[],
    options: MetadataReleaseOptions = {},
  ): Promise<MetadataBatchReleaseResult> {
    if (requests.length === 0) {
      return { releases: [], artifacts: [], requiresManualReview: false, blockingMigrationSteps: 0, published: [] };
    }

    const preparation = await this.prepareMany(
      requests,
      options.artifactGenerators ?? defaultArtifacts,
    );

    if (preparation.requiresManualReview && options.approveBreaking !== true) {
      throw new MetadataError("Metadata release batch contains breaking schema changes and requires explicit approval.");
    }
    if (preparation.blockingMigrationSteps > 0 && !options.migrationExecutor) {
      throw new MetadataError(
        `Metadata release batch requires ${preparation.blockingMigrationSteps} blocking migration step(s) before publication.`,
      );
    }

    if (options.migrationExecutor) {
      for (const release of preparation.releases) {
        const plan = release.migrationPlan;
        if (!plan) continue;
        const context: MigrationExecutionContext = {
          objectTypeId: release.objectTypeId,
          fromVersion: plan.fromVersion,
          toVersion: plan.toVersion,
        };
        for (const step of this.executableBlockingSteps(release)) {
          await options.migrationExecutor.execute(step, context);
        }
      }
    }

    for (const release of preparation.releases) await this.assertDraftStable(release);

    const published = await this.catalog.publishMany(
      preparation.releases.map((release) => ({
        objectTypeId: release.objectTypeId,
        version: release.targetVersion,
        expectedRevision: release.targetRevision,
      })),
    );
    return { ...preparation, published };
  }

  private executableBlockingSteps(release: MetadataReleasePreparation): readonly MigrationStep[] {
    return (release.migrationPlan?.steps ?? []).filter(
      (step) => step.blocking && step.kind !== "manual-review",
    );
  }

  private async assertDraftStable(preparation: MetadataReleasePreparation): Promise<void> {
    const current = await this.catalog.get(preparation.objectTypeId, preparation.targetVersion);
    if (!current || current.status !== "draft") {
      throw new MetadataError(
        `Metadata '${preparation.objectTypeId}@${preparation.targetVersion}' is no longer an unpublished draft.`,
      );
    }
    if (current.revision !== preparation.targetRevision) {
      throw new MetadataError(
        `Metadata '${preparation.objectTypeId}@${preparation.targetVersion}' changed during release preparation; prepare the release again.`,
      );
    }
  }
}
