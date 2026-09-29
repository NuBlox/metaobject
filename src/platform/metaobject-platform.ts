import type { AttributeDefinition, ObjectTypeDefinition } from "../metadata/definitions.js";
import type { InferInputValues, InferValues } from "../metadata/inference.js";
import type { ObjectQuery } from "../query/query.js";
import { ObjectTypeRegistry } from "../registry/object-type-registry.js";
import type { MetaObject } from "../runtime/meta-object.js";
import { ObjectFactory, type IdGenerator } from "../runtime/object-factory.js";
import type { ObjectIdentity } from "../runtime/model.js";
import { MemoryStorageAdapter } from "../storage/memory-storage-adapter.js";
import { MetaObjectRepository, type RepositoryOptions } from "../storage/repository.js";
import type { StorageAdapter } from "../storage/storage-adapter.js";
import { createDefaultTypeRegistry } from "../types/builtins.js";
import type { TypeRegistry } from "../types/type-registry.js";
import { ConstraintRegistry, Validator } from "../validation/validation.js";

export type MetaObjectCapability =
  | "metadata-driven-types"
  | "validation"
  | "relationships"
  | "optimistic-concurrency"
  | "batch-write"
  | "query"
  | "query-pushdown"
  | "deterministic-comparison";

export interface MetaObjectStorageSelection {
  readonly adapter: StorageAdapter;
  readonly name?: string;
}

export interface CreateMetaObjectOptions {
  readonly storage?: "memory" | StorageAdapter | MetaObjectStorageSelection;
  readonly types?: TypeRegistry;
  readonly constraints?: ConstraintRegistry;
  readonly idGenerator?: IdGenerator;
  readonly repository?: RepositoryOptions;
}

export interface MetaObjectDescriptor {
  readonly storage: string;
  readonly capabilities: Readonly<Record<MetaObjectCapability, boolean>>;
}

type AttributeOptions = Omit<AttributeDefinition, "type">;

type BuiltinAttribute<Name extends string> = AttributeDefinition & { readonly type: Name };

function attribute<Name extends string>(type: Name, options: AttributeOptions = {}): BuiltinAttribute<Name> {
  return Object.freeze({ type, ...options }) as BuiltinAttribute<Name>;
}

/** Convenience builders for the built-in metadata types. */
export const meta = Object.freeze({
  string: (options?: AttributeOptions) => attribute("string", options),
  integer: (options?: AttributeOptions) => attribute("integer", options),
  number: (options?: AttributeOptions) => attribute("number", options),
  decimal: (options?: AttributeOptions) => attribute("decimal", options),
  boolean: (options?: AttributeOptions) => attribute("boolean", options),
  date: (options?: AttributeOptions) => attribute("date", options),
  datetime: (options?: AttributeOptions) => attribute("datetime", options),
  uuid: (options?: AttributeOptions) => attribute("uuid", options),
  json: (options?: AttributeOptions) => attribute("json", options),
  binary: (options?: AttributeOptions) => attribute("binary", options),
});

/** Define metadata without registering it. Registration occurs through MetaObjectPlatform.define(). */
export function defineObject<const D extends ObjectTypeDefinition>(definition: D): Readonly<D> {
  return Object.freeze(definition);
}

function resolveStorage(
  storage: CreateMetaObjectOptions["storage"],
): { readonly adapter: StorageAdapter; readonly name: string } {
  if (storage === undefined || storage === "memory") {
    return { adapter: new MemoryStorageAdapter(), name: "memory" };
  }
  if ("adapter" in storage) {
    return { adapter: storage.adapter, name: storage.name ?? "custom" };
  }
  return { adapter: storage, name: storage.constructor?.name ?? "custom" };
}

export class MetaObjectPlatform {
  readonly types: TypeRegistry;
  readonly objectTypes: ObjectTypeRegistry;
  readonly factory: ObjectFactory;
  readonly storage: StorageAdapter;
  readonly repository: MetaObjectRepository;
  readonly storageName: string;

  constructor(options: CreateMetaObjectOptions = {}) {
    this.types = options.types ?? createDefaultTypeRegistry();
    this.objectTypes = new ObjectTypeRegistry(this.types);
    this.factory = new ObjectFactory(this.objectTypes, this.types, options.idGenerator);
    const resolvedStorage = resolveStorage(options.storage);
    this.storage = resolvedStorage.adapter;
    this.storageName = resolvedStorage.name;
    this.repository = new MetaObjectRepository(
      this.storage,
      this.factory,
      new Validator(options.constraints),
      options.repository,
    );
  }

  define<const D extends ObjectTypeDefinition>(definition: D): Readonly<D> {
    return this.objectTypes.register(definition);
  }

  create<const D extends ObjectTypeDefinition>(definition: D, values: InferInputValues<D>): MetaObject<InferValues<D>>;
  create(objectTypeId: string, values?: Record<string, unknown>): MetaObject;
  create(
    definitionOrId: ObjectTypeDefinition | string,
    values: Record<string, unknown> = {},
  ): MetaObject {
    return this.factory.create(definitionOrId as string, values);
  }

  save<T extends Record<string, unknown>>(object: MetaObject<T>): Promise<MetaObject<T>> {
    return this.repository.save(object);
  }

  saveAll<const T extends readonly MetaObject[]>(objects: T): Promise<T> {
    return this.repository.saveAll(objects);
  }

  find(identity: ObjectIdentity): Promise<MetaObject | null> {
    return this.repository.find(identity);
  }

  query(query: ObjectQuery): Promise<readonly MetaObject[]> {
    return this.repository.query(query);
  }

  delete(object: MetaObject): Promise<void> {
    return this.repository.delete(object);
  }

  related(object: MetaObject, relationshipName: string): Promise<readonly MetaObject[]> {
    return this.repository.related(object, relationshipName);
  }

  supports(capability: MetaObjectCapability): boolean {
    switch (capability) {
      case "query-pushdown":
        return (this.storage.queryPushdownCapabilities?.filterOperators.length ?? 0) > 0;
      case "metadata-driven-types":
      case "validation":
      case "relationships":
      case "optimistic-concurrency":
      case "batch-write":
      case "query":
      case "deterministic-comparison":
        return true;
    }
  }

  descriptor(): MetaObjectDescriptor {
    const capabilities = Object.freeze({
      "metadata-driven-types": this.supports("metadata-driven-types"),
      validation: this.supports("validation"),
      relationships: this.supports("relationships"),
      "optimistic-concurrency": this.supports("optimistic-concurrency"),
      "batch-write": this.supports("batch-write"),
      query: this.supports("query"),
      "query-pushdown": this.supports("query-pushdown"),
      "deterministic-comparison": this.supports("deterministic-comparison"),
    });
    return Object.freeze({ storage: this.storageName, capabilities });
  }
}

/** Primary NuBloxMetaObject public entry point. */
export function createMetaObject(options: CreateMetaObjectOptions = {}): MetaObjectPlatform {
  return new MetaObjectPlatform(options);
}
