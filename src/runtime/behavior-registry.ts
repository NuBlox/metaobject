import { MetadataError } from "../errors/errors.js";
import type { HookPhase } from "../metadata/definitions.js";
import type { MetaObject } from "./meta-object.js";

export interface BehaviorContext {
  readonly object: MetaObject;
  readonly operation?: string;
  readonly input?: unknown;
  readonly attribute?: string;
  readonly value?: unknown;
}

export type ComputedBehavior = (context: BehaviorContext) => unknown;
export type OperationBehavior = (context: BehaviorContext) => unknown;
export type HookBehavior = (context: BehaviorContext) => void;

export interface MetaObjectEvent {
  readonly object: MetaObject;
  readonly name: string;
  readonly payload?: unknown;
  readonly occurredAt: Date;
}

export type EventListener = (event: MetaObjectEvent) => void;

export class EventBus {
  readonly #listeners = new Map<string, Set<EventListener>>();

  on(name: string, listener: EventListener): () => void {
    let listeners = this.#listeners.get(name);
    if (!listeners) {
      listeners = new Set<EventListener>();
      this.#listeners.set(name, listeners);
    }
    listeners.add(listener);
    return () => listeners?.delete(listener);
  }

  emit(event: MetaObjectEvent): void {
    for (const listener of this.#listeners.get(event.name) ?? []) listener(event);
    for (const listener of this.#listeners.get("*") ?? []) listener(event);
  }
}

export class BehaviorRegistry {
  readonly #computed = new Map<string, ComputedBehavior>();
  readonly #operations = new Map<string, OperationBehavior>();
  readonly #hooks = new Map<string, HookBehavior>();

  registerComputed(name: string, behavior: ComputedBehavior): this {
    this.registerUnique(this.#computed, "computed", name, behavior);
    return this;
  }

  registerOperation(name: string, behavior: OperationBehavior): this {
    this.registerUnique(this.#operations, "operation", name, behavior);
    return this;
  }

  registerHook(name: string, behavior: HookBehavior): this {
    this.registerUnique(this.#hooks, "hook", name, behavior);
    return this;
  }

  compute(name: string, context: BehaviorContext): unknown {
    const behavior = this.#computed.get(name);
    if (!behavior) throw new MetadataError(`Unknown computed behavior '${name}'.`);
    return behavior(context);
  }

  invoke(name: string, context: BehaviorContext): unknown {
    const behavior = this.#operations.get(name);
    if (!behavior) throw new MetadataError(`Unknown operation behavior '${name}'.`);
    return behavior(context);
  }

  runHooks(names: readonly string[] | undefined, context: BehaviorContext): void {
    for (const name of names ?? []) {
      const behavior = this.#hooks.get(name);
      if (!behavior) throw new MetadataError(`Unknown hook behavior '${name}'.`);
      behavior(context);
    }
  }

  runObjectHooks(object: MetaObject, phase: HookPhase, context: Omit<BehaviorContext, "object"> = {}): void {
    const handlers = (object.objectType.hooks ?? [])
      .filter((hook) => hook.phase === phase)
      .map((hook) => hook.handler);
    this.runHooks(handlers, { object, ...context });
  }

  hasComputed(name: string): boolean { return this.#computed.has(name); }
  hasOperation(name: string): boolean { return this.#operations.has(name); }
  hasHook(name: string): boolean { return this.#hooks.has(name); }

  private registerUnique<T>(map: Map<string, T>, kind: string, name: string, value: T): void {
    if (!name.trim()) throw new MetadataError(`${kind} behavior name is required.`);
    if (map.has(name)) throw new MetadataError(`${kind} behavior '${name}' is already registered.`);
    map.set(name, value);
  }
}
