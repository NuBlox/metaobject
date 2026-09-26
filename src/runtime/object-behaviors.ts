import { MetadataError } from "../errors/errors.js";
import type { TypeRegistry } from "../types/type-registry.js";
import { BehaviorRegistry, EventBus } from "./behavior-registry.js";
import type { MetaObject } from "./meta-object.js";

export class ObjectBehaviorRuntime {
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

    const value = this.behaviors.compute(definition.computed.behavior, { object, attribute });
    if (value === null) {
      if (!definition.nullable) throw new TypeError(`Computed attribute '${attribute}' does not allow null.`);
      return value;
    }
    if (value === undefined) return value;
    const type = this.types.get(definition.type);
    if (definition.multiple) {
      if (!Array.isArray(value) || !value.every((item) => type.validate(item))) {
        throw new TypeError(`Computed attribute '${attribute}' must return an array of '${definition.type}' values.`);
      }
    } else if (!type.validate(value)) {
      throw new TypeError(`Computed attribute '${attribute}' must return type '${definition.type}'.`);
    }
    return value;
  }

  /** Invoke a metadata-declared operation through its registered runtime behaviour. */
  invoke(object: MetaObject, operation: string, input?: unknown): unknown {
    const definition = object.objectType.operations?.[operation];
    if (!definition) throw new MetadataError(`Unknown operation '${object.objectType.id}.${operation}'.`);

    this.behaviors.runObjectHooks(object, "beforeOperation", { operation, input });
    const result = this.behaviors.invoke(definition.behavior, { object, operation, input });
    this.behaviors.runObjectHooks(object, "afterOperation", { operation, input });
    return result;
  }

  /** Emit a declared domain event. Undeclared event names are rejected. */
  emit(object: MetaObject, name: string, payload?: unknown): void {
    if (!object.objectType.events?.[name]) {
      throw new MetadataError(`Unknown event '${object.objectType.id}.${name}'.`);
    }
    this.events.emit({ object, name, payload, occurredAt: new Date() });
  }
}
