import { MetadataError } from "../errors/errors.js";
import type {
  ComputedAttributeDefinition,
  HookDefinition,
  HookPhase,
  OperationDefinition,
} from "../metadata/definitions.js";
import type { MetaObject } from "../runtime/meta-object.js";

export interface ComputationContext {
  readonly object: MetaObject;
  readonly attribute: string;
  readonly definition: ComputedAttributeDefinition;
}

export type ComputationHandler = (context: ComputationContext) => unknown;

export interface OperationContext {
  readonly object: MetaObject;
  readonly operation: string;
  readonly definition: OperationDefinition;
}

export type OperationHandler = (
  context: OperationContext,
  input: unknown,
) => unknown | Promise<unknown>;

export interface HookContext {
  readonly object: MetaObject;
  readonly phase: HookPhase;
  readonly definition: HookDefinition;
}

export type HookHandler = (context: HookContext) => void | Promise<void>;

export class BehaviorRegistry {
  readonly #computations = new Map<string, ComputationHandler>();
  readonly #operations = new Map<string, OperationHandler>();
  readonly #hooks = new Map<string, HookHandler>();

  registerComputation(name: string, handler: ComputationHandler): this {
    this.register(this.#computations, "computation", name, handler);
    return this;
  }

  registerOperation(name: string, handler: OperationHandler): this {
    this.register(this.#operations, "operation", name, handler);
    return this;
  }

  registerHook(name: string, handler: HookHandler): this {
    this.register(this.#hooks, "hook", name, handler);
    return this;
  }

  hasComputation(name: string): boolean { return this.#computations.has(name); }
  hasOperation(name: string): boolean { return this.#operations.has(name); }
  hasHook(name: string): boolean { return this.#hooks.has(name); }

  compute(object: MetaObject, attribute: string, definition: ComputedAttributeDefinition): unknown {
    const handler = this.#computations.get(definition.resolver);
    if (!handler) {
      throw new MetadataError(
        `Computed attribute '${object.objectType.id}.${attribute}' references unknown computation '${definition.resolver}'.`,
      );
    }
    return handler({ object, attribute, definition });
  }

  async invoke(
    object: MetaObject,
    operation: string,
    definition: OperationDefinition,
    input: unknown,
  ): Promise<unknown> {
    const handler = this.#operations.get(definition.handler);
    if (!handler) {
      throw new MetadataError(
        `Operation '${object.objectType.id}.${operation}' references unknown handler '${definition.handler}'.`,
      );
    }
    return handler({ object, operation, definition }, input);
  }

  async runHooks(object: MetaObject, phase: HookPhase): Promise<void> {
    for (const definition of object.objectType.hooks ?? []) {
      if (definition.phase !== phase) continue;
      const handler = this.#hooks.get(definition.handler);
      if (!handler) {
        throw new MetadataError(
          `Hook '${object.objectType.id}.${definition.id}' references unknown handler '${definition.handler}'.`,
        );
      }
      await handler({ object, phase, definition });
    }
  }

  private register<T>(registry: Map<string, T>, kind: string, name: string, handler: T): void {
    if (!name.trim()) throw new MetadataError(`${kind} handler name is required.`);
    if (registry.has(name)) throw new MetadataError(`${kind} handler '${name}' is already registered.`);
    registry.set(name, handler);
  }
}
