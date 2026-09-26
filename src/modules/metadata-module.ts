import { MetadataError } from "../errors/errors.js";

export interface MetadataModuleMember {
  readonly objectTypeId: string;
  readonly version: number;
}

export interface MetadataModuleDependency {
  readonly moduleId: string;
  readonly minimumVersion?: number;
  readonly maximumVersion?: number;
}

export interface MetadataModuleDefinition {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly description?: string;
  readonly members: readonly MetadataModuleMember[];
  readonly dependencies?: readonly MetadataModuleDependency[];
}

export interface ResolvedMetadataModuleDependency {
  readonly requirement: MetadataModuleDependency;
  readonly module: MetadataModuleDefinition;
}

export interface MetadataModuleResolution {
  readonly root: MetadataModuleDefinition;
  /** Dependencies first, root last. */
  readonly order: readonly MetadataModuleDefinition[];
  readonly dependencies: readonly ResolvedMetadataModuleDependency[];
}

export function defineMetadataModule<const D extends MetadataModuleDefinition>(definition: D): Readonly<D> {
  return Object.freeze(definition);
}

function moduleKey(id: string, version: number): string {
  return `${id}@${version}`;
}

function versionMatches(version: number, requirement: MetadataModuleDependency): boolean {
  if (requirement.minimumVersion !== undefined && version < requirement.minimumVersion) return false;
  if (requirement.maximumVersion !== undefined && version > requirement.maximumVersion) return false;
  return true;
}

export class MetadataModuleRegistry {
  readonly #modules = new Map<string, MetadataModuleDefinition>();

  register<const D extends MetadataModuleDefinition>(definition: D): Readonly<D> {
    if (!definition.id.trim()) throw new MetadataError("Metadata module id is required.");
    if (!definition.name.trim()) throw new MetadataError(`${definition.id}: metadata module name is required.`);
    if (!Number.isSafeInteger(definition.version) || definition.version < 1) {
      throw new MetadataError(`${definition.id}: module version must be a positive integer.`);
    }
    if (definition.members.length === 0) {
      throw new MetadataError(`${definition.id}@${definition.version}: metadata module must contain at least one object type.`);
    }

    const key = moduleKey(definition.id, definition.version);
    if (this.#modules.has(key)) throw new MetadataError(`Metadata module '${key}' is already registered.`);

    const memberIds = new Set<string>();
    for (const member of definition.members) {
      if (!member.objectTypeId.trim()) throw new MetadataError(`${key}: module member object type id is required.`);
      if (!Number.isSafeInteger(member.version) || member.version < 1) {
        throw new MetadataError(`${key}: member '${member.objectTypeId}' version must be a positive integer.`);
      }
      if (memberIds.has(member.objectTypeId)) {
        throw new MetadataError(`${key}: duplicate member object type '${member.objectTypeId}'.`);
      }
      memberIds.add(member.objectTypeId);
    }

    const dependencyIds = new Set<string>();
    for (const dependency of definition.dependencies ?? []) {
      if (!dependency.moduleId.trim()) throw new MetadataError(`${key}: dependency module id is required.`);
      if (dependency.moduleId === definition.id) throw new MetadataError(`${key}: a module cannot depend on itself.`);
      if (dependencyIds.has(dependency.moduleId)) {
        throw new MetadataError(`${key}: duplicate dependency '${dependency.moduleId}'.`);
      }
      dependencyIds.add(dependency.moduleId);
      if (dependency.minimumVersion !== undefined && (!Number.isSafeInteger(dependency.minimumVersion) || dependency.minimumVersion < 1)) {
        throw new MetadataError(`${key}: dependency '${dependency.moduleId}' minimumVersion must be a positive integer.`);
      }
      if (dependency.maximumVersion !== undefined && (!Number.isSafeInteger(dependency.maximumVersion) || dependency.maximumVersion < 1)) {
        throw new MetadataError(`${key}: dependency '${dependency.moduleId}' maximumVersion must be a positive integer.`);
      }
      if (
        dependency.minimumVersion !== undefined
        && dependency.maximumVersion !== undefined
        && dependency.minimumVersion > dependency.maximumVersion
      ) {
        throw new MetadataError(`${key}: dependency '${dependency.moduleId}' has an invalid version range.`);
      }
    }

    const frozen = Object.freeze(definition);
    this.#modules.set(key, frozen as MetadataModuleDefinition);
    return frozen;
  }

  get(id: string, version: number): MetadataModuleDefinition {
    const definition = this.#modules.get(moduleKey(id, version));
    if (!definition) throw new MetadataError(`Unknown metadata module '${id}@${version}'.`);
    return definition;
  }

  all(id?: string): readonly MetadataModuleDefinition[] {
    return [...this.#modules.values()]
      .filter((definition) => id === undefined || definition.id === id)
      .sort((left, right) => left.id.localeCompare(right.id) || left.version - right.version);
  }

  latest(id: string): MetadataModuleDefinition {
    const candidates = this.all(id);
    if (candidates.length === 0) throw new MetadataError(`Unknown metadata module '${id}'.`);
    return candidates[candidates.length - 1]!;
  }

  resolveDependency(requirement: MetadataModuleDependency): MetadataModuleDefinition {
    const candidates = this.all(requirement.moduleId).filter((candidate) => versionMatches(candidate.version, requirement));
    if (candidates.length === 0) {
      const range = [
        requirement.minimumVersion === undefined ? "*" : `>=${requirement.minimumVersion}`,
        requirement.maximumVersion === undefined ? "*" : `<=${requirement.maximumVersion}`,
      ].join(" ");
      throw new MetadataError(`No registered version of metadata module '${requirement.moduleId}' satisfies ${range}.`);
    }
    return candidates[candidates.length - 1]!;
  }

  resolve(id: string, version?: number): MetadataModuleResolution {
    const root = version === undefined ? this.latest(id) : this.get(id, version);
    const order: MetadataModuleDefinition[] = [];
    const dependencies: ResolvedMetadataModuleDependency[] = [];
    const visited = new Set<string>();
    const visiting: string[] = [];

    const visit = (definition: MetadataModuleDefinition): void => {
      const key = moduleKey(definition.id, definition.version);
      if (visited.has(key)) return;
      const cycleStart = visiting.indexOf(key);
      if (cycleStart >= 0) {
        throw new MetadataError(`Metadata module dependency cycle detected: ${[...visiting.slice(cycleStart), key].join(" -> ")}.`);
      }
      visiting.push(key);
      for (const requirement of definition.dependencies ?? []) {
        const dependency = this.resolveDependency(requirement);
        dependencies.push({ requirement, module: dependency });
        visit(dependency);
      }
      visiting.pop();
      visited.add(key);
      order.push(definition);
    };

    visit(root);
    return { root, order, dependencies };
  }
}
