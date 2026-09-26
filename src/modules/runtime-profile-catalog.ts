import { MetadataError } from "../errors/errors.js";
import type { ObjectTypeRegistry } from "../registry/object-type-registry.js";
import type { MetadataModuleSetResolver } from "./module-set.js";
import type {
  RuntimeProfileBundle,
  RuntimeProfileDefinition,
  RuntimeProfileRecord,
  RuntimeProfileStatus,
  RuntimeProfileStore,
} from "./runtime-profile-store.js";

export type RuntimeProfileClock = () => Date;

function profileKey(id: string, version: number): string {
  return `${id}@${version}`;
}

export class RuntimeProfileCatalog {
  constructor(
    private readonly store: RuntimeProfileStore,
    private readonly moduleSets: MetadataModuleSetResolver,
    private readonly clock: RuntimeProfileClock = () => new Date(),
  ) {}

  async saveDraft(definition: RuntimeProfileDefinition, expectedRevision?: number): Promise<RuntimeProfileRecord> {
    this.validateDefinition(definition);
    const existing = await this.store.get(definition.id, definition.version);
    if (existing && existing.status !== "draft") {
      throw new MetadataError(
        `Runtime profile '${profileKey(definition.id, definition.version)}' is ${existing.status} and cannot be edited as a draft.`,
      );
    }
    const latestActive = await this.latest(definition.id, "active");
    if (latestActive && definition.version <= latestActive.profileVersion && !existing) {
      throw new MetadataError(
        `New runtime profile version ${definition.version} must be greater than active version ${latestActive.profileVersion}.`,
      );
    }

    const now = this.clock().toISOString();
    return this.store.save({
      profileId: definition.id,
      profileVersion: definition.version,
      status: "draft",
      revision: existing?.revision ?? 0,
      definition: structuredClone(definition),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }, expectedRevision);
  }

  /** Resolve requirements to an exact lockfile and freeze this profile version as active. */
  async activate(profileId: string, version: number, expectedRevision: number): Promise<RuntimeProfileRecord> {
    const current = await this.requireRecord(profileId, version);
    if (current.status !== "draft") {
      throw new MetadataError(`Runtime profile '${profileKey(profileId, version)}' must be draft before activation.`);
    }
    const latestActive = await this.latest(profileId, "active");
    if (latestActive && version <= latestActive.profileVersion) {
      throw new MetadataError(
        `Runtime profile version ${version} must be greater than active version ${latestActive.profileVersion}.`,
      );
    }

    const lockfile = await this.moduleSets.resolve(current.definition.requirements);
    await this.moduleSets.validate(lockfile);
    return this.store.save({
      ...current,
      status: "active",
      lockfile,
      updatedAt: this.clock().toISOString(),
    }, expectedRevision);
  }

  async deprecate(profileId: string, version: number, expectedRevision: number): Promise<RuntimeProfileRecord> {
    const current = await this.requireRecord(profileId, version);
    if (current.status !== "active") {
      throw new MetadataError(`Only active runtime profiles can be deprecated: '${profileKey(profileId, version)}'.`);
    }
    if (!current.lockfile) {
      throw new MetadataError(`Active runtime profile '${profileKey(profileId, version)}' is missing its lockfile.`);
    }
    return this.store.save({
      ...current,
      status: "deprecated",
      updatedAt: this.clock().toISOString(),
    }, expectedRevision);
  }

  async get(profileId: string, version: number): Promise<RuntimeProfileRecord | null> {
    return this.store.get(profileId, version);
  }

  async latest(profileId: string, status?: RuntimeProfileStatus): Promise<RuntimeProfileRecord | null> {
    const records = await this.store.list({ profileId, ...(status === undefined ? {} : { status }) });
    return records.reduce<RuntimeProfileRecord | null>(
      (latest, record) => latest === null || record.profileVersion > latest.profileVersion ? record : latest,
      null,
    );
  }

  /** Reconstruct the exact runtime object registry frozen into an active/deprecated profile. */
  async buildObjectTypeRegistry(profileId: string, version?: number): Promise<ObjectTypeRegistry> {
    const record = version === undefined
      ? await this.latest(profileId, "active")
      : await this.store.get(profileId, version);
    if (!record) {
      throw new MetadataError(
        version === undefined ? `No active runtime profile '${profileId}'.` : `Unknown runtime profile '${profileKey(profileId, version)}'.`,
      );
    }
    if (record.status === "draft") {
      throw new MetadataError(`Runtime profile '${profileKey(record.profileId, record.profileVersion)}' is not activated.`);
    }
    if (!record.lockfile) {
      throw new MetadataError(`Runtime profile '${profileKey(record.profileId, record.profileVersion)}' is missing its lockfile.`);
    }
    return this.moduleSets.buildObjectTypeRegistry(record.lockfile);
  }

  async exportBundle(status?: RuntimeProfileStatus): Promise<RuntimeProfileBundle> {
    const records = await this.store.list(status === undefined ? {} : { status });
    return {
      format: "nublox-metaobject-runtime-profiles",
      formatVersion: 1,
      records: structuredClone(records),
    };
  }

  /** Validate the complete bundle before writing any records. */
  async importBundle(bundle: RuntimeProfileBundle, options: { replaceDrafts?: boolean } = {}): Promise<void> {
    if (bundle.format !== "nublox-metaobject-runtime-profiles" || bundle.formatVersion !== 1) {
      throw new MetadataError("Unsupported runtime profile bundle format.");
    }

    const existing = await this.store.list();
    const existingByKey = new Map(existing.map((record) => [profileKey(record.profileId, record.profileVersion), record]));
    const incomingKeys = new Set<string>();

    for (const incoming of bundle.records) {
      const key = profileKey(incoming.profileId, incoming.profileVersion);
      if (incomingKeys.has(key)) throw new MetadataError(`Duplicate runtime profile bundle record '${key}'.`);
      incomingKeys.add(key);
      if (incoming.definition.id !== incoming.profileId || incoming.definition.version !== incoming.profileVersion) {
        throw new MetadataError(`Runtime profile bundle identity mismatch for '${key}'.`);
      }
      this.validateDefinition(incoming.definition);
      if (incoming.status === "draft") {
        if (incoming.lockfile !== undefined) {
          throw new MetadataError(`Draft runtime profile '${key}' cannot contain an activated lockfile.`);
        }
      } else {
        if (!incoming.lockfile) throw new MetadataError(`Runtime profile '${key}' is missing its activated lockfile.`);
        await this.moduleSets.validate(incoming.lockfile);
      }
      const current = existingByKey.get(key);
      if (current && (!options.replaceDrafts || current.status !== "draft" || incoming.status !== "draft")) {
        throw new MetadataError(`Runtime profile '${key}' already exists.`);
      }
    }

    for (const incoming of bundle.records) {
      const key = profileKey(incoming.profileId, incoming.profileVersion);
      const current = existingByKey.get(key);
      if (!current) {
        await this.store.save(structuredClone(incoming));
        continue;
      }
      await this.store.save({
        ...structuredClone(incoming),
        revision: current.revision,
        createdAt: current.createdAt,
        updatedAt: this.clock().toISOString(),
      }, current.revision);
    }
  }

  private validateDefinition(definition: RuntimeProfileDefinition): void {
    if (!definition.id.trim()) throw new MetadataError("Runtime profile id is required.");
    if (!definition.name.trim()) throw new MetadataError(`${definition.id}: runtime profile name is required.`);
    if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
      throw new MetadataError(`${definition.id}: runtime profile version must be a positive integer.`);
    }
    if (definition.requirements.length === 0) {
      throw new MetadataError(`${profileKey(definition.id, definition.version)}: runtime profile requires at least one module.`);
    }
    const moduleIds = new Set<string>();
    for (const requirement of definition.requirements) {
      if (!requirement.moduleId.trim()) throw new MetadataError(`${profileKey(definition.id, definition.version)}: module requirement id is required.`);
      if (moduleIds.has(requirement.moduleId)) {
        throw new MetadataError(`${profileKey(definition.id, definition.version)}: duplicate module requirement '${requirement.moduleId}'.`);
      }
      moduleIds.add(requirement.moduleId);
      if (requirement.minimumVersion !== undefined && (!Number.isSafeInteger(requirement.minimumVersion) || requirement.minimumVersion < 1)) {
        throw new MetadataError(`${profileKey(definition.id, definition.version)}: '${requirement.moduleId}' minimumVersion must be positive.`);
      }
      if (requirement.maximumVersion !== undefined && (!Number.isSafeInteger(requirement.maximumVersion) || requirement.maximumVersion < 1)) {
        throw new MetadataError(`${profileKey(definition.id, definition.version)}: '${requirement.moduleId}' maximumVersion must be positive.`);
      }
      if (
        requirement.minimumVersion !== undefined
        && requirement.maximumVersion !== undefined
        && requirement.minimumVersion > requirement.maximumVersion
      ) {
        throw new MetadataError(`${profileKey(definition.id, definition.version)}: '${requirement.moduleId}' has an invalid version range.`);
      }
    }
  }

  private async requireRecord(profileId: string, version: number): Promise<RuntimeProfileRecord> {
    const record = await this.store.get(profileId, version);
    if (!record) throw new MetadataError(`Unknown runtime profile '${profileKey(profileId, version)}'.`);
    return record;
  }
}
