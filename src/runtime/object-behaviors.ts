import { MetadataError } from "../errors/errors.js";
import type { AttributeDefinition } from "../metadata/definitions.js";
import type { TypeRegistry } from "../types/type-registry.js";
import { BehaviorRegistry, EventBus } from "./behavior-registry.js";
import type { MetaObject } from "./meta-object.js";

interface CachedComputedValue {
  readonly token: string;
  readonly value: unknown;
}

export class ObjectBehaviorRuntime {
  readonly #computedCache = new WeakMap<MetaObject, Map<string, CachedComputedValue>>();

  constructor(
    readonly behaviors: BehaviorRegistry,
    private readonly types: TypeRegistry,
    readonly events: EventBus = new EventBus(),
  ) {}

  /** Read a stored value or calculate a metadata-defined computed attribute. */
  read(object: MetaObject, attribute: string): unknown {
    const definition = object.objectType.attributes[attribute];
    if (!definition) throw new MetadataError(`Unknown attribute '${object.objectType.id}.${attribute}'.`);
    if (!definition.computed) return object.get(attribute);

    const token = definition.computed.cache ? this.cacheToken(object) : undefined;
    if (token !== undefined) {
      const cached = this.#computedCache.get(object)?.get(attribute);
      if (cached?.token === token) return cached.value;
    }

    const value = this.behaviors.compute(definition.computed.resolver, { object, attribute });
    this.assertComputedValue(attribute, definition, value);
    if (token !== undefined) {
      let cache = this.#computedCache.get(object);
      if (!cache) {
        cache = new Map<string, CachedComputedValue>();
        this.#computedCache.set(object, cache);
      }
      cache.set(attribute, { token, value });
    }
    return value;
  }

  /** Remove cached computed values for an object explicitly. */
  invalidate(object: MetaObject, attribute?: string): void {
    if (attribute === undefined) {
      this.#computedCache.delete(object);
      return;
    }
    this.#computedCache.get(object)?.delete(attribute);
  }

  /** Invoke a metadata-declared operation through its registered runtime behaviour. */
  invoke(object: MetaObject, operation: string, input?: unknown): unknown {
    const definition = object.objectType.operations?.[operation];
    if (!definition) throw new MetadataError(`Unknown operation '${object.objectType.id}.${operation}'.`);
    return this.behaviors.invoke(definition.handler, { object, operation, input });
  }

  /** Emit a declared domain event. Undeclared event names are rejected. */
  emit(object: MetaObject, name: string, payload?: unknown): void {
    if (!object.objectType.events?.[name]) {
      throw new MetadataError(`Unknown event '${object.objectType.id}.${name}'.`);
    }
    this.events.emit({ object, name, payload, occurredAt: new Date() });
  }

  private cacheToken(object: MetaObject): string {
    return JSON.stringify([
      object.version,
      object.state,
      object.changedAttributes(),
      object.changedRelationships(),
    ]);
  }

  private assertComputedValue(attribute: string, definition: AttributeDefinition, value: unknown): void {
    if (value === null) {
      if (!definition.nullable) throw new TypeError(`Computed attribute '${attribute}' does not allow null.`);
      return;
    }
    if (value === undefined) return;
    const type = this.types.get(definition.type);
    if (definition.multiple) {
      if (!Array.isArray(value) || !value.every((item) => type.validate(item))) {
        throw new TypeError(`Computed attribute '${attribute}' must return an array of '${definition.type}' values.`);
      }
      return;
    }
    if (!type.validate(value)) {
      throw new TypeError(`Computed attribute '${attribute}' must return type '${definition.type}'.`);
    }
  }
}
