import { MetadataError } from "../errors/errors.js";
import { ObjectTypeRegistry } from "../registry/object-type-registry.js";
import type { TypeRegistry } from "../types/type-registry.js";
import type { ObjectTypeDefinition } from "./definitions.js";
import type {
  MetadataBundle,
  MetadataRecord,
  MetadataStatus,
  MetadataStore,
} from "./metadata-store.js";
import { denormalizeObjectType, normalizeObjectType } from "./persistence-model.js";

export type MetadataClock = () => Date;

export class MetadataCatalog {
  constructor(
    private readonly store: MetadataStore,
    private readonly types: TypeRegistry,
    private readonly clock: MetadataClock = () => new Date(),
  ) {}

  async saveDraft(definition: ObjectTypeDefinition, expectedRevision?: number): Promise<MetadataRecord> {
    const existing = await this.store.get(definition.id, definition.version);
    if (existing && existing.status !== "draft") {
      throw new MetadataError(
        `Metadata '${definition.id}@${definition.version}' is ${existing.status} and cannot be edited as a draft.`,
      );
    }
    this.validateDefinitionSet([definition]);
    const now = this.clock().toISOString();
    const record: MetadataRecord = {
      objectTypeId: definition.id,
      objectTypeVersion: definition.version,
      status: "draft",
      revision: existing?.revision ?? 0,
      snapshot: normalizeObjectType(definition),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    return this.store.save(record, expectedRevision);
  }

  async publish(objectTypeId: string, version: number, expectedRevision: number): Promise<MetadataRecord> {
    const current = await this.requireRecord(objectTypeId, version);
    if (current.status === "published") return current;
    if (current.status !== "draft") {
      throw new MetadataError(`Metadata '${objectTypeId}@${version}' must be draft before publication.`);
    }

    const candidate = denormalizeObjectType(current.snapshot);
    const published = await this.latestRecords("published");
    const definitions = published
      .filter((record) => record.objectTypeId !== objectTypeId)
      .map((record) => denormalizeObjectType(record.snapshot));
    definitions.push(candidate);
    this.validateDefinitionSet(definitions, true);

    return this.store.save({
      ...current,
      status: "published",
      updatedAt: this.clock().toISOString(),
    }, expectedRevision);
  }

  async deprecate(objectTypeId: string, version: number, expectedRevision: number): Promise<MetadataRecord> {
    const current = await this.requireRecord(objectTypeId, version);
    if (current.status !== "published") {
      throw new MetadataError(`Only published metadata can be deprecated: '${objectTypeId}@${version}'.`);
    }
    return this.store.save({
      ...current,
      status: "deprecated",
      updatedAt: this.clock().toISOString(),
    }, expectedRevision);
  }

  async get(objectTypeId: string, version: number): Promise<MetadataRecord | null> {
    return this.store.get(objectTypeId, version);
  }

  async getDefinition(objectTypeId: string, version: number): Promise<ObjectTypeDefinition | null> {
    const record = await this.store.get(objectTypeId, version);
    return record ? denormalizeObjectType(record.snapshot) : null;
  }

  async latest(objectTypeId: string, status?: MetadataStatus): Promise<MetadataRecord | null> {
    const records = await this.store.list({ objectTypeId, ...(status !== undefined ? { status } : {}) });
    return records.reduce<MetadataRecord | null>(
      (latest, record) => latest === null || record.objectTypeVersion > latest.objectTypeVersion ? record : latest,
      null,
    );
  }

  /** Register the latest published version of every object type into a runtime registry. */
  async loadPublished(registry: ObjectTypeRegistry): Promise<readonly ObjectTypeDefinition[]> {
    const records = await this.latestRecords("published");
    const definitions = records.map((record) => denormalizeObjectType(record.snapshot));
    for (const definition of definitions) registry.register(definition);
    registry.validateHierarchy();
    registry.validateRelationships();
    return definitions;
  }

  async createPublishedRegistry(): Promise<ObjectTypeRegistry> {
    const registry = new ObjectTypeRegistry(this.types);
    await this.loadPublished(registry);
    return registry;
  }

  async exportBundle(status?: MetadataStatus): Promise<MetadataBundle> {
    const records = await this.store.list(status === undefined ? {} : { status });
    return {
      format: "nublox-metaobject-metadata",
      formatVersion: 1,
      records: structuredClone(records),
    };
  }

  /**
   * Import records exactly as versioned catalogue entries. Existing records are
   * rejected unless `replaceDrafts` is enabled and the existing entry is a draft.
   */
  async importBundle(bundle: MetadataBundle, options: { replaceDrafts?: boolean } = {}): Promise<void> {
    if (bundle.format !== "nublox-metaobject-metadata" || bundle.formatVersion !== 1) {
      throw new MetadataError("Unsupported metadata bundle format.");
    }
    for (const incoming of bundle.records) {
      const definition = denormalizeObjectType(incoming.snapshot);
      if (definition.id !== incoming.objectTypeId || definition.version !== incoming.objectTypeVersion) {
        throw new MetadataError(`Metadata bundle identity mismatch for '${incoming.objectTypeId}@${incoming.objectTypeVersion}'.`);
      }
      const existing = await this.store.get(incoming.objectTypeId, incoming.objectTypeVersion);
      if (!existing) {
        await this.store.save(structuredClone(incoming));
        continue;
      }
      if (!options.replaceDrafts || existing.status !== "draft" || incoming.status !== "draft") {
        throw new MetadataError(`Metadata '${incoming.objectTypeId}@${incoming.objectTypeVersion}' already exists.`);
      }
      await this.store.save({
        ...structuredClone(incoming),
        revision: existing.revision,
        createdAt: existing.createdAt,
        updatedAt: this.clock().toISOString(),
      }, existing.revision);
    }
  }

  private async requireRecord(objectTypeId: string, version: number): Promise<MetadataRecord> {
    const record = await this.store.get(objectTypeId, version);
    if (!record) throw new MetadataError(`Unknown metadata '${objectTypeId}@${version}'.`);
    return record;
  }

  private async latestRecords(status: MetadataStatus): Promise<MetadataRecord[]> {
    const records = await this.store.list({ status });
    const latest = new Map<string, MetadataRecord>();
    for (const record of records) {
      const current = latest.get(record.objectTypeId);
      if (!current || record.objectTypeVersion > current.objectTypeVersion) {
        latest.set(record.objectTypeId, record);
      }
    }
    return [...latest.values()].sort((left, right) => left.objectTypeId.localeCompare(right.objectTypeId));
  }

  private validateDefinitionSet(definitions: readonly ObjectTypeDefinition[], validateLinks = false): void {
    const registry = new ObjectTypeRegistry(this.types);
    for (const definition of definitions) registry.register(definition);
    if (validateLinks) {
      registry.validateHierarchy();
      registry.validateRelationships();
    }
  }
}
