import { MetadataError } from "../errors/errors.js";
import type { MetadataCatalog } from "../metadata/metadata-catalog.js";
import type { ObjectTypeDefinition } from "../metadata/definitions.js";
import type {
  MetadataBatchReleasePreparation,
  MetadataBatchReleaseResult,
  MetadataReleaseManager,
  MetadataReleaseOptions,
} from "../release/metadata-release-manager.js";
import type {
  MetadataModuleDefinition,
  MetadataModuleRegistry,
  MetadataModuleResolution,
} from "./metadata-module.js";

export interface MetadataModuleManifestDependency {
  readonly moduleId: string;
  readonly version: number;
}

export interface MetadataModuleManifest {
  readonly format: "nublox-metaobject-module";
  readonly formatVersion: 1;
  readonly moduleId: string;
  readonly moduleVersion: number;
  readonly dependencies: readonly MetadataModuleManifestDependency[];
  readonly members: readonly { readonly objectTypeId: string; readonly version: number }[];
}

export interface MetadataModuleReleasePreparation {
  readonly module: MetadataModuleDefinition;
  readonly manifest: MetadataModuleManifest;
  readonly release: MetadataBatchReleasePreparation;
}

export interface MetadataModuleReleaseResult extends MetadataModuleReleasePreparation {
  readonly release: MetadataBatchReleaseResult;
}

function moduleKey(module: MetadataModuleDefinition): string {
  return `${module.id}@${module.version}`;
}

/**
 * Release a coherent metadata module after validating explicit module ownership
 * of every inheritance and relationship dependency.
 */
export class MetadataModuleReleaseManager {
  constructor(
    private readonly modules: MetadataModuleRegistry,
    private readonly catalog: MetadataCatalog,
    private readonly releases: MetadataReleaseManager,
  ) {}

  async prepare(
    moduleId: string,
    version?: number,
    artifactGenerators?: readonly string[],
  ): Promise<MetadataModuleReleasePreparation> {
    const resolution = this.modules.resolve(moduleId, version);
    await this.assertDependencyModulesPublished(resolution);
    const definitions = await this.loadClosureDefinitions(resolution);
    this.validateObjectDependencyOwnership(resolution, definitions);

    const rootDefinitions = definitions.get(moduleKey(resolution.root))!;
    const release = await this.releases.prepareMany(
      resolution.root.members.map((member) => ({
        objectTypeId: member.objectTypeId,
        targetVersion: member.version,
      })),
      artifactGenerators,
    );

    // Ensure exact module members are the definitions prepared for release.
    for (const definition of rootDefinitions) {
      const prepared = release.releases.find((entry) => entry.objectTypeId === definition.id);
      if (!prepared || prepared.targetVersion !== definition.version) {
        throw new MetadataError(
          `Metadata module '${moduleKey(resolution.root)}' did not prepare '${definition.id}@${definition.version}'.`,
        );
      }
    }

    return {
      module: resolution.root,
      manifest: this.createManifest(resolution),
      release,
    };
  }

  async release(
    moduleId: string,
    version?: number,
    options: MetadataReleaseOptions = {},
  ): Promise<MetadataModuleReleaseResult> {
    const preparation = await this.prepare(moduleId, version, options.artifactGenerators);
    const release = await this.releases.releaseMany(
      preparation.module.members.map((member) => ({
        objectTypeId: member.objectTypeId,
        targetVersion: member.version,
      })),
      options,
    );
    return { ...preparation, release };
  }

  createManifest(resolution: MetadataModuleResolution): MetadataModuleManifest {
    const dependencies = resolution.order
      .filter((module) => module !== resolution.root)
      .map((module) => ({ moduleId: module.id, version: module.version }));
    return {
      format: "nublox-metaobject-module",
      formatVersion: 1,
      moduleId: resolution.root.id,
      moduleVersion: resolution.root.version,
      dependencies,
      members: resolution.root.members.map((member) => ({ ...member })),
    };
  }

  private async assertDependencyModulesPublished(resolution: MetadataModuleResolution): Promise<void> {
    for (const dependency of resolution.order) {
      if (dependency === resolution.root) continue;
      for (const member of dependency.members) {
        const record = await this.catalog.get(member.objectTypeId, member.version);
        if (!record || record.status !== "published") {
          throw new MetadataError(
            `Metadata module '${moduleKey(resolution.root)}' requires published dependency '${moduleKey(dependency)}', but '${member.objectTypeId}@${member.version}' is not published.`,
          );
        }
      }
    }
  }

  private async loadClosureDefinitions(
    resolution: MetadataModuleResolution,
  ): Promise<Map<string, readonly ObjectTypeDefinition[]>> {
    const output = new Map<string, readonly ObjectTypeDefinition[]>();
    const ownership = new Map<string, string>();

    for (const module of resolution.order) {
      const definitions: ObjectTypeDefinition[] = [];
      for (const member of module.members) {
        const previousOwner = ownership.get(member.objectTypeId);
        if (previousOwner) {
          throw new MetadataError(
            `Object type '${member.objectTypeId}' is owned by multiple modules in the resolved graph: '${previousOwner}' and '${moduleKey(module)}'.`,
          );
        }
        ownership.set(member.objectTypeId, moduleKey(module));
        const definition = await this.catalog.getDefinition(member.objectTypeId, member.version);
        if (!definition) {
          throw new MetadataError(
            `Metadata module '${moduleKey(module)}' references unknown metadata '${member.objectTypeId}@${member.version}'.`,
          );
        }
        definitions.push(definition);
      }
      output.set(moduleKey(module), definitions);
    }
    return output;
  }

  private validateObjectDependencyOwnership(
    resolution: MetadataModuleResolution,
    definitions: ReadonlyMap<string, readonly ObjectTypeDefinition[]>,
  ): void {
    const owners = new Map<string, string>();
    for (const module of resolution.order) {
      for (const member of module.members) owners.set(member.objectTypeId, module.id);
    }

    for (const definition of definitions.get(moduleKey(resolution.root)) ?? []) {
      const dependencies = new Set<string>();
      if (definition.baseType) dependencies.add(definition.baseType);
      for (const relationship of Object.values(definition.relationships ?? {})) dependencies.add(relationship.target);

      for (const objectTypeId of dependencies) {
        const owner = owners.get(objectTypeId);
        if (!owner) {
          throw new MetadataError(
            `Object type '${definition.id}' depends on '${objectTypeId}', but no module in '${resolution.root.id}' dependency closure owns it.`,
          );
        }
        if (owner !== resolution.root.id && !(resolution.root.dependencies ?? []).some((dependency) => dependency.moduleId === owner)) {
          // Transitive dependencies are valid through the resolved graph; the check
          // below confirms the owner is reachable from a direct dependency.
          const directRoots = (resolution.root.dependencies ?? []).map((dependency) => dependency.moduleId);
          const reachable = resolution.order.some((module) => module.id === owner)
            && directRoots.length > 0;
          if (!reachable) {
            throw new MetadataError(
              `Object type '${definition.id}' depends on '${objectTypeId}' from module '${owner}', which is not reachable from '${resolution.root.id}'.`,
            );
          }
        }
      }
    }
  }
}
