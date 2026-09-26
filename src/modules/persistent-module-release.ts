import { MetadataError } from "../errors/errors.js";
import type { MetadataCatalog } from "../metadata/metadata-catalog.js";
import type { MetadataReleaseManager, MetadataReleaseOptions } from "../release/metadata-release-manager.js";
import { MetadataModuleRegistry } from "./metadata-module.js";
import type { MetadataModuleCatalog } from "./module-catalog.js";
import {
  MetadataModuleReleaseManager,
  type MetadataModuleReleasePreparation,
  type MetadataModuleReleaseResult,
} from "./metadata-module-release.js";
import type { MetadataModuleRecord } from "./module-store.js";

export interface PersistentModuleReleasePreparation {
  readonly moduleRevision: number;
  readonly preparation: MetadataModuleReleasePreparation;
}

export interface PersistentModuleReleaseResult {
  readonly moduleRecord: MetadataModuleRecord;
  readonly release: MetadataModuleReleaseResult;
}

/**
 * Coordinate durable module lifecycle state with the M10/M9 release pipeline.
 * A module is locked as `releasing` before migrations/member publication begin.
 */
export class PersistentMetadataModuleReleaseManager {
  constructor(
    private readonly modules: MetadataModuleCatalog,
    private readonly metadata: MetadataCatalog,
    private readonly metadataReleases: MetadataReleaseManager,
  ) {}

  async prepare(
    moduleId: string,
    version: number,
    artifactGenerators?: readonly string[],
  ): Promise<PersistentModuleReleasePreparation> {
    const record = await this.requireModule(moduleId, version);
    if (record.status !== "draft") {
      throw new MetadataError(`Metadata module '${moduleId}@${version}' must be draft before release preparation.`);
    }
    const releaseManager = await this.createReleaseManager(record);
    const preparation = await releaseManager.prepare(moduleId, version, artifactGenerators);
    return { moduleRevision: record.revision, preparation };
  }

  async release(
    moduleId: string,
    version: number,
    options: MetadataReleaseOptions = {},
  ): Promise<PersistentModuleReleaseResult> {
    const prepared = await this.prepare(moduleId, version, options.artifactGenerators);
    const locked = await this.modules.beginRelease(
      moduleId,
      version,
      prepared.moduleRevision,
      prepared.preparation.manifest,
    );

    const releaseManager = await this.createReleaseManager(locked);
    // On failure the module intentionally remains `releasing`. External migration
    // side effects may already exist, so silently returning to draft would be unsafe.
    const release = await releaseManager.release(moduleId, version, options);

    const current = await this.requireModule(moduleId, version);
    if (current.status !== "releasing") {
      throw new MetadataError(`Metadata module '${moduleId}@${version}' lost its release lock before completion.`);
    }
    const moduleRecord = await this.modules.completeRelease(moduleId, version, current.revision);
    return { moduleRecord, release };
  }

  /** Complete a release after an interrupted process once every member is published. */
  async recover(moduleId: string, version: number): Promise<MetadataModuleRecord> {
    const record = await this.requireModule(moduleId, version);
    if (record.status !== "releasing") {
      throw new MetadataError(`Metadata module '${moduleId}@${version}' is not in releasing state.`);
    }
    const unpublished = await this.memberStates(record);
    const incomplete = unpublished.filter((entry) => entry.status !== "published");
    if (incomplete.length > 0) {
      throw new MetadataError(
        `Cannot complete module '${moduleId}@${version}'; unpublished members: ${incomplete.map((entry) => `${entry.objectTypeId}@${entry.version}`).join(", ")}.`,
      );
    }
    return this.modules.completeRelease(moduleId, version, record.revision);
  }

  /**
   * Explicitly abandon a release lock only when no module member has been
   * published. Callers remain responsible for compensating any external adapter
   * side effects before aborting.
   */
  async abort(moduleId: string, version: number): Promise<MetadataModuleRecord> {
    const record = await this.requireModule(moduleId, version);
    if (record.status !== "releasing") {
      throw new MetadataError(`Metadata module '${moduleId}@${version}' is not in releasing state.`);
    }
    const states = await this.memberStates(record);
    const published = states.filter((entry) => entry.status === "published");
    if (published.length > 0) {
      throw new MetadataError(
        `Cannot abort module '${moduleId}@${version}' after member publication: ${published.map((entry) => `${entry.objectTypeId}@${entry.version}`).join(", ")}.`,
      );
    }
    return this.modules.abortRelease(moduleId, version, record.revision);
  }

  private async createReleaseManager(record: MetadataModuleRecord): Promise<MetadataModuleReleaseManager> {
    const registry: MetadataModuleRegistry = await this.modules.createPublishedRegistry();
    registry.register(record.definition);
    return new MetadataModuleReleaseManager(registry, this.metadata, this.metadataReleases);
  }

  private async memberStates(record: MetadataModuleRecord): Promise<Array<{
    objectTypeId: string;
    version: number;
    status: "missing" | "draft" | "published" | "deprecated";
  }>> {
    const states: Array<{
      objectTypeId: string;
      version: number;
      status: "missing" | "draft" | "published" | "deprecated";
    }> = [];
    for (const member of record.definition.members) {
      const metadata = await this.metadata.get(member.objectTypeId, member.version);
      states.push({
        objectTypeId: member.objectTypeId,
        version: member.version,
        status: metadata?.status ?? "missing",
      });
    }
    return states;
  }

  private async requireModule(moduleId: string, version: number): Promise<MetadataModuleRecord> {
    const record = await this.modules.get(moduleId, version);
    if (!record) throw new MetadataError(`Unknown metadata module '${moduleId}@${version}'.`);
    return record;
  }
}
