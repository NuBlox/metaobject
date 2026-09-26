import { MetadataError } from "../errors/errors.js";
import type { MetadataCatalog } from "../metadata/metadata-catalog.js";
import { ObjectTypeRegistry } from "../registry/object-type-registry.js";
import type { TypeRegistry } from "../types/type-registry.js";
import type {
  MetadataModuleDependency,
  MetadataModuleMember,
} from "./metadata-module.js";
import type { MetadataModuleCatalog } from "./module-catalog.js";
import type { MetadataModuleRecord } from "./module-store.js";

export interface MetadataModuleSetRequirement extends MetadataModuleDependency {}

export interface MetadataModuleSetRootLock {
  readonly moduleId: string;
  readonly version: number;
}

export interface MetadataModuleSetModuleLock {
  readonly moduleId: string;
  readonly version: number;
  readonly dependencies: readonly MetadataModuleSetRootLock[];
  readonly members: readonly MetadataModuleMember[];
}

export interface MetadataModuleSetLockfile {
  readonly format: "nublox-metaobject-module-set";
  readonly formatVersion: 1;
  /** Explicit requested roots after version-range resolution. */
  readonly roots: readonly MetadataModuleSetRootLock[];
  /** Dependency-first exact module closure. */
  readonly modules: readonly MetadataModuleSetModuleLock[];
}

function moduleKey(moduleId: string, version: number): string {
  return `${moduleId}@${version}`;
}

function requirementMatches(version: number, requirement: MetadataModuleSetRequirement): boolean {
  if (requirement.minimumVersion !== undefined && version < requirement.minimumVersion) return false;
  if (requirement.maximumVersion !== undefined && version > requirement.maximumVersion) return false;
  return true;
}

function validateRequirement(requirement: MetadataModuleSetRequirement): void {
  if (!requirement.moduleId.trim()) throw new MetadataError("Module-set requirement moduleId is required.");
  if (
    requirement.minimumVersion !== undefined
    && (!Number.isSafeInteger(requirement.minimumVersion) || requirement.minimumVersion < 1)
  ) {
    throw new MetadataError(`Module-set requirement '${requirement.moduleId}' minimumVersion must be a positive integer.`);
  }
  if (
    requirement.maximumVersion !== undefined
    && (!Number.isSafeInteger(requirement.maximumVersion) || requirement.maximumVersion < 1)
  ) {
    throw new MetadataError(`Module-set requirement '${requirement.moduleId}' maximumVersion must be a positive integer.`);
  }
  if (
    requirement.minimumVersion !== undefined
    && requirement.maximumVersion !== undefined
    && requirement.minimumVersion > requirement.maximumVersion
  ) {
    throw new MetadataError(`Module-set requirement '${requirement.moduleId}' has an invalid version range.`);
  }
}

function sameMembers(left: readonly MetadataModuleMember[], right: readonly MetadataModuleMember[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((member, index) => {
    const other = right[index];
    return other !== undefined
      && member.objectTypeId === other.objectTypeId
      && member.version === other.version;
  });
}

function sameDependencies(
  left: readonly MetadataModuleSetRootLock[],
  right: readonly MetadataModuleSetRootLock[],
): boolean {
  if (left.length !== right.length) return false;
  return left.every((dependency, index) => {
    const other = right[index];
    return other !== undefined
      && dependency.moduleId === other.moduleId
      && dependency.version === other.version;
  });
}

/**
 * Resolve published module requirements into an exact, portable runtime lockfile
 * and reconstruct the exact object-type registry described by that lockfile.
 *
 * Dependency traversal follows each published module's locked release manifest,
 * not its original version ranges. Historical module semantics therefore remain
 * stable when newer compatible dependency versions are published later.
 */
export class MetadataModuleSetResolver {
  constructor(
    private readonly modules: MetadataModuleCatalog,
    private readonly metadata: MetadataCatalog,
    private readonly types: TypeRegistry,
  ) {}

  async resolve(requirements: readonly MetadataModuleSetRequirement[]): Promise<MetadataModuleSetLockfile> {
    if (requirements.length === 0) throw new MetadataError("A module set requires at least one root module.");

    const rootIds = new Set<string>();
    const roots: MetadataModuleSetRootLock[] = [];
    const selectedVersions = new Map<string, number>();
    const visited = new Set<string>();
    const visiting: string[] = [];
    const ordered: MetadataModuleSetModuleLock[] = [];

    const registry = await this.modules.createPublishedRegistry();
    const sortedRequirements = [...requirements].sort((left, right) => left.moduleId.localeCompare(right.moduleId));

    const visit = async (record: MetadataModuleRecord): Promise<void> => {
      const selected = selectedVersions.get(record.moduleId);
      if (selected !== undefined && selected !== record.moduleVersion) {
        throw new MetadataError(
          `Module-set version conflict for '${record.moduleId}': locked both ${selected} and ${record.moduleVersion}.`,
        );
      }
      selectedVersions.set(record.moduleId, record.moduleVersion);

      const key = moduleKey(record.moduleId, record.moduleVersion);
      if (visited.has(key)) return;
      const cycleStart = visiting.indexOf(key);
      if (cycleStart >= 0) {
        throw new MetadataError(`Module-set dependency cycle detected: ${[...visiting.slice(cycleStart), key].join(" -> ")}.`);
      }

      const manifest = record.releasedManifest;
      if (!manifest) throw new MetadataError(`Published module '${key}' is missing its locked release manifest.`);
      visiting.push(key);
      for (const dependency of manifest.dependencies) {
        const dependencyRecord = await this.requirePublished(dependency.moduleId, dependency.version);
        await visit(dependencyRecord);
      }
      visiting.pop();
      visited.add(key);
      ordered.push({
        moduleId: record.moduleId,
        version: record.moduleVersion,
        dependencies: manifest.dependencies.map((dependency) => ({ ...dependency })),
        members: manifest.members.map((member) => ({ ...member })),
      });
    };

    for (const requirement of sortedRequirements) {
      validateRequirement(requirement);
      if (rootIds.has(requirement.moduleId)) {
        throw new MetadataError(`Duplicate module-set root requirement '${requirement.moduleId}'.`);
      }
      rootIds.add(requirement.moduleId);
      const rootDefinition = registry.resolveDependency(requirement);
      if (!requirementMatches(rootDefinition.version, requirement)) {
        throw new MetadataError(`Resolved module '${rootDefinition.id}@${rootDefinition.version}' does not satisfy its requirement.`);
      }
      const root = await this.requirePublished(rootDefinition.id, rootDefinition.version);
      roots.push({ moduleId: root.moduleId, version: root.moduleVersion });
      await visit(root);
    }

    this.assertUniqueObjectOwnership(ordered);
    return {
      format: "nublox-metaobject-module-set",
      formatVersion: 1,
      roots,
      modules: ordered,
    };
  }

  async validate(lockfile: MetadataModuleSetLockfile): Promise<void> {
    if (lockfile.format !== "nublox-metaobject-module-set" || lockfile.formatVersion !== 1) {
      throw new MetadataError("Unsupported metadata module-set lockfile format.");
    }
    if (lockfile.roots.length === 0) throw new MetadataError("A module-set lockfile requires at least one root module.");

    const locksById = new Map<string, MetadataModuleSetModuleLock>();
    for (const locked of lockfile.modules) {
      if (locksById.has(locked.moduleId)) {
        throw new MetadataError(`Module-set lockfile contains multiple versions of module '${locked.moduleId}'.`);
      }
      locksById.set(locked.moduleId, locked);
      const record = await this.requirePublished(locked.moduleId, locked.version);
      const manifest = record.releasedManifest!;
      if (!sameDependencies(locked.dependencies, manifest.dependencies)) {
        throw new MetadataError(`Module-set lock for '${moduleKey(locked.moduleId, locked.version)}' has altered dependencies.`);
      }
      if (!sameMembers(locked.members, manifest.members)) {
        throw new MetadataError(`Module-set lock for '${moduleKey(locked.moduleId, locked.version)}' has altered members.`);
      }
    }

    const rootIds = new Set<string>();
    for (const root of lockfile.roots) {
      if (rootIds.has(root.moduleId)) throw new MetadataError(`Duplicate module-set root '${root.moduleId}'.`);
      rootIds.add(root.moduleId);
      const locked = locksById.get(root.moduleId);
      if (!locked || locked.version !== root.version) {
        throw new MetadataError(`Module-set root '${moduleKey(root.moduleId, root.version)}' is not present in the lockfile closure.`);
      }
    }

    const reachable = new Set<string>();
    const visiting = new Set<string>();
    const visit = (moduleId: string): void => {
      if (reachable.has(moduleId)) return;
      if (visiting.has(moduleId)) throw new MetadataError(`Module-set lockfile contains a dependency cycle at '${moduleId}'.`);
      const locked = locksById.get(moduleId);
      if (!locked) throw new MetadataError(`Module-set lockfile is missing dependency module '${moduleId}'.`);
      visiting.add(moduleId);
      for (const dependency of locked.dependencies) {
        const dependencyLock = locksById.get(dependency.moduleId);
        if (!dependencyLock || dependencyLock.version !== dependency.version) {
          throw new MetadataError(`Module-set lockfile is missing exact dependency '${moduleKey(dependency.moduleId, dependency.version)}'.`);
        }
        visit(dependency.moduleId);
      }
      visiting.delete(moduleId);
      reachable.add(moduleId);
    };
    for (const root of lockfile.roots) visit(root.moduleId);
    if (reachable.size !== lockfile.modules.length) {
      const extras = lockfile.modules.filter((entry) => !reachable.has(entry.moduleId));
      throw new MetadataError(`Module-set lockfile contains unreachable module(s): ${extras.map((entry) => moduleKey(entry.moduleId, entry.version)).join(", ")}.`);
    }

    this.assertUniqueObjectOwnership(lockfile.modules);
  }

  /** Build the exact runtime object-type registry represented by a validated lockfile. */
  async buildObjectTypeRegistry(lockfile: MetadataModuleSetLockfile): Promise<ObjectTypeRegistry> {
    await this.validate(lockfile);
    const registry = new ObjectTypeRegistry(this.types);
    const registered = new Set<string>();

    for (const module of lockfile.modules) {
      for (const member of module.members) {
        if (registered.has(member.objectTypeId)) continue;
        const record = await this.metadata.get(member.objectTypeId, member.version);
        if (!record || record.status !== "published") {
          throw new MetadataError(
            `Module-set member '${member.objectTypeId}@${member.version}' is not published metadata.`,
          );
        }
        const definition = await this.metadata.getDefinition(member.objectTypeId, member.version);
        if (!definition) throw new MetadataError(`Unknown module-set metadata '${member.objectTypeId}@${member.version}'.`);
        registry.register(definition);
        registered.add(member.objectTypeId);
      }
    }

    registry.validateHierarchy();
    registry.validateRelationships();
    return registry;
  }

  private async requirePublished(moduleId: string, version: number): Promise<MetadataModuleRecord> {
    const record = await this.modules.get(moduleId, version);
    if (!record || record.status !== "published") {
      throw new MetadataError(`Metadata module '${moduleKey(moduleId, version)}' is not published.`);
    }
    if (!record.releasedManifest) {
      throw new MetadataError(`Published module '${moduleKey(moduleId, version)}' is missing its locked release manifest.`);
    }
    return record;
  }

  private assertUniqueObjectOwnership(modules: readonly MetadataModuleSetModuleLock[]): void {
    const owners = new Map<string, string>();
    for (const module of modules) {
      const owner = moduleKey(module.moduleId, module.version);
      for (const member of module.members) {
        const existing = owners.get(member.objectTypeId);
        if (existing && existing !== owner) {
          throw new MetadataError(
            `Object type '${member.objectTypeId}' is owned by multiple locked modules: '${existing}' and '${owner}'.`,
          );
        }
        owners.set(member.objectTypeId, owner);
      }
    }
  }
}
