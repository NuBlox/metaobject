import { MetadataError } from "../errors/errors.js";
import {
  MetadataModuleRegistry,
  type MetadataModuleDefinition,
  type MetadataModuleResolution,
} from "./metadata-module.js";
import type { MetadataModuleManifest } from "./metadata-module-release.js";
import type {
  MetadataModuleBundle,
  MetadataModuleRecord,
  MetadataModuleStatus,
  MetadataModuleStore,
} from "./module-store.js";

export type MetadataModuleClock = () => Date;

function moduleKey(id: string, version: number): string {
  return `${id}@${version}`;
}

function expectedManifest(resolution: MetadataModuleResolution): MetadataModuleManifest {
  return {
    format: "nublox-metaobject-module",
    formatVersion: 1,
    moduleId: resolution.root.id,
    moduleVersion: resolution.root.version,
    dependencies: resolution.order
      .filter((module) => module !== resolution.root)
      .map((module) => ({ moduleId: module.id, version: module.version })),
    members: resolution.root.members.map((member) => ({ ...member })),
  };
}

function canonical(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}

export class MetadataModuleCatalog {
  constructor(
    private readonly store: MetadataModuleStore,
    private readonly clock: MetadataModuleClock = () => new Date(),
  ) {}

  async saveDraft(definition: MetadataModuleDefinition, expectedRevision?: number): Promise<MetadataModuleRecord> {
    this.validateDefinition(definition);
    const existing = await this.store.get(definition.id, definition.version);
    if (existing && existing.status !== "draft") {
      throw new MetadataError(
        `Metadata module '${definition.id}@${definition.version}' is ${existing.status} and cannot be edited as a draft.`,
      );
    }
    const latestPublished = await this.latest(definition.id, "published");
    if (latestPublished && definition.version <= latestPublished.moduleVersion && !existing) {
      throw new MetadataError(
        `New draft module version ${definition.version} must be greater than published version ${latestPublished.moduleVersion}.`,
      );
    }

    const now = this.clock().toISOString();
    const record: MetadataModuleRecord = {
      moduleId: definition.id,
      moduleVersion: definition.version,
      status: "draft",
      revision: existing?.revision ?? 0,
      definition: structuredClone(definition),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    return this.store.save(record, expectedRevision);
  }

  async publish(
    moduleId: string,
    version: number,
    expectedRevision: number,
    manifest: MetadataModuleManifest,
  ): Promise<MetadataModuleRecord> {
    const current = await this.requireRecord(moduleId, version);
    if (current.status !== "draft") {
      throw new MetadataError(`Metadata module '${moduleKey(moduleId, version)}' must be draft before publication.`);
    }
    const latestPublished = await this.latest(moduleId, "published");
    if (latestPublished && version <= latestPublished.moduleVersion) {
      throw new MetadataError(
        `Module version ${version} must be greater than published version ${latestPublished.moduleVersion}.`,
      );
    }

    const registry = await this.createRegistryWithCandidate(current.definition);
    const resolution = registry.resolve(moduleId, version);
    await this.assertResolvedDependenciesPublished(resolution);
    const expected = expectedManifest(resolution);
    if (canonical(expected) !== canonical(manifest)) {
      throw new MetadataError(`Released manifest for '${moduleKey(moduleId, version)}' does not match resolved module metadata.`);
    }

    return this.store.save({
      ...current,
      status: "published",
      releasedManifest: structuredClone(manifest),
      updatedAt: this.clock().toISOString(),
    }, expectedRevision);
  }

  async deprecate(moduleId: string, version: number, expectedRevision: number): Promise<MetadataModuleRecord> {
    const current = await this.requireRecord(moduleId, version);
    if (current.status !== "published") {
      throw new MetadataError(`Only published metadata modules can be deprecated: '${moduleKey(moduleId, version)}'.`);
    }
    await this.assertNotRequiredByPublishedModules(current.definition);
    return this.store.save({
      ...current,
      status: "deprecated",
      updatedAt: this.clock().toISOString(),
    }, expectedRevision);
  }

  async get(moduleId: string, version: number): Promise<MetadataModuleRecord | null> {
    return this.store.get(moduleId, version);
  }

  async getDefinition(moduleId: string, version: number): Promise<MetadataModuleDefinition | null> {
    return (await this.store.get(moduleId, version))?.definition ?? null;
  }

  async latest(moduleId: string, status?: MetadataModuleStatus): Promise<MetadataModuleRecord | null> {
    const records = await this.store.list({ moduleId, ...(status === undefined ? {} : { status }) });
    return records.reduce<MetadataModuleRecord | null>(
      (latest, record) => latest === null || record.moduleVersion > latest.moduleVersion ? record : latest,
      null,
    );
  }

  /** Load every published module version so version-range resolution remains correct. */
  async createPublishedRegistry(): Promise<MetadataModuleRegistry> {
    const registry = new MetadataModuleRegistry();
    for (const record of await this.store.list({ status: "published" })) registry.register(record.definition);
    return registry;
  }

  async exportBundle(status?: MetadataModuleStatus): Promise<MetadataModuleBundle> {
    const records = await this.store.list(status === undefined ? {} : { status });
    return {
      format: "nublox-metaobject-modules",
      formatVersion: 1,
      records: structuredClone(records),
    };
  }

  async importBundle(bundle: MetadataModuleBundle, options: { replaceDrafts?: boolean } = {}): Promise<void> {
    if (bundle.format !== "nublox-metaobject-modules" || bundle.formatVersion !== 1) {
      throw new MetadataError("Unsupported metadata module bundle format.");
    }

    const existingRecords = await this.store.list();
    const existingByKey = new Map(existingRecords.map((record) => [moduleKey(record.moduleId, record.moduleVersion), record]));
    const simulated = new Map(existingByKey);
    const incomingKeys = new Set<string>();

    // Validate the complete bundle before writing any record.
    for (const incoming of bundle.records) {
      const key = moduleKey(incoming.moduleId, incoming.moduleVersion);
      if (incomingKeys.has(key)) throw new MetadataError(`Duplicate module bundle record '${key}'.`);
      incomingKeys.add(key);
      if (incoming.definition.id !== incoming.moduleId || incoming.definition.version !== incoming.moduleVersion) {
        throw new MetadataError(`Module bundle identity mismatch for '${key}'.`);
      }
      this.validateDefinition(incoming.definition);
      const existing = existingByKey.get(key);
      if (existing && (!options.replaceDrafts || existing.status !== "draft" || incoming.status !== "draft")) {
        throw new MetadataError(`Metadata module '${key}' already exists.`);
      }
      simulated.set(key, structuredClone(incoming));
    }

    for (const incoming of bundle.records) {
      if (incoming.status === "published") this.validateLockedPublishedRecord(incoming, simulated);
    }

    for (const incoming of bundle.records) {
      const key = moduleKey(incoming.moduleId, incoming.moduleVersion);
      const existing = existingByKey.get(key);
      if (!existing) {
        await this.store.save(structuredClone(incoming));
        continue;
      }
      await this.store.save({
        ...structuredClone(incoming),
        revision: existing.revision,
        createdAt: existing.createdAt,
        updatedAt: this.clock().toISOString(),
      }, existing.revision);
    }
  }

  private validateDefinition(definition: MetadataModuleDefinition): void {
    const registry = new MetadataModuleRegistry();
    registry.register(definition);
  }

  private validateLockedPublishedRecord(
    record: MetadataModuleRecord,
    records: ReadonlyMap<string, MetadataModuleRecord>,
  ): void {
    const manifest = record.releasedManifest;
    if (!manifest) {
      throw new MetadataError(`Published module '${moduleKey(record.moduleId, record.moduleVersion)}' is missing a released manifest.`);
    }
    const registry = new MetadataModuleRegistry();
    registry.register(record.definition);
    for (const dependency of manifest.dependencies) {
      const dependencyRecord = records.get(moduleKey(dependency.moduleId, dependency.version));
      if (!dependencyRecord || dependencyRecord.status !== "published") {
        throw new MetadataError(
          `Published module '${moduleKey(record.moduleId, record.moduleVersion)}' locks missing dependency '${moduleKey(dependency.moduleId, dependency.version)}'.`,
        );
      }
      registry.register(dependencyRecord.definition);
    }
    const resolved = registry.resolve(record.moduleId, record.moduleVersion);
    if (canonical(expectedManifest(resolved)) !== canonical(manifest)) {
      throw new MetadataError(
        `Published module '${moduleKey(record.moduleId, record.moduleVersion)}' has a released manifest that does not resolve from its locked dependency versions.`,
      );
    }
  }

  private async requireRecord(moduleId: string, version: number): Promise<MetadataModuleRecord> {
    const record = await this.store.get(moduleId, version);
    if (!record) throw new MetadataError(`Unknown metadata module '${moduleKey(moduleId, version)}'.`);
    return record;
  }

  private async createRegistryWithCandidate(candidate: MetadataModuleDefinition): Promise<MetadataModuleRegistry> {
    const registry = new MetadataModuleRegistry();
    for (const record of await this.store.list({ status: "published" })) {
      if (record.moduleId === candidate.id && record.moduleVersion === candidate.version) continue;
      registry.register(record.definition);
    }
    registry.register(candidate);
    return registry;
  }

  private async assertResolvedDependenciesPublished(resolution: MetadataModuleResolution): Promise<void> {
    for (const dependency of resolution.order) {
      if (dependency === resolution.root) continue;
      const record = await this.store.get(dependency.id, dependency.version);
      if (!record || record.status !== "published") {
        throw new MetadataError(
          `Metadata module '${moduleKey(resolution.root.id, resolution.root.version)}' requires published module '${moduleKey(dependency.id, dependency.version)}'.`,
        );
      }
    }
  }

  private async assertNotRequiredByPublishedModules(definition: MetadataModuleDefinition): Promise<void> {
    const published = await this.store.list({ status: "published" });
    const registry = new MetadataModuleRegistry();
    for (const candidate of published) registry.register(candidate.definition);
    for (const record of published) {
      if (record.moduleId === definition.id && record.moduleVersion === definition.version) continue;
      let resolution: MetadataModuleResolution;
      try {
        resolution = registry.resolve(record.moduleId, record.moduleVersion);
      } catch {
        continue;
      }
      if (resolution.order.some((module) => module.id === definition.id && module.version === definition.version)) {
        throw new MetadataError(
          `Cannot deprecate '${moduleKey(definition.id, definition.version)}' while published module '${moduleKey(record.moduleId, record.moduleVersion)}' resolves it as a dependency.`,
        );
      }
    }
  }
}
