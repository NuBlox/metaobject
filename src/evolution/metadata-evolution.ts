import { MetadataError } from "../errors/errors.js";
import type { MetadataCatalog } from "../metadata/metadata-catalog.js";
import { MigrationPlanner, type MigrationPlan } from "./migration-planner.js";
import { diffObjectTypes, type SchemaDiff } from "./schema-evolution.js";

/** Compare and plan evolution directly between persisted metadata versions. */
export class MetadataEvolution {
  constructor(
    private readonly catalog: MetadataCatalog,
    readonly planner: MigrationPlanner = new MigrationPlanner(),
  ) {}

  async diff(objectTypeId: string, fromVersion: number, toVersion: number): Promise<SchemaDiff> {
    const before = await this.catalog.getDefinition(objectTypeId, fromVersion);
    if (!before) throw new MetadataError(`Unknown metadata '${objectTypeId}@${fromVersion}'.`);
    const after = await this.catalog.getDefinition(objectTypeId, toVersion);
    if (!after) throw new MetadataError(`Unknown metadata '${objectTypeId}@${toVersion}'.`);
    return diffObjectTypes(before, after);
  }

  async plan(objectTypeId: string, fromVersion: number, toVersion: number): Promise<MigrationPlan> {
    return this.planner.plan(await this.diff(objectTypeId, fromVersion, toVersion));
  }
}
