import { AttributeTypeNotFoundError, MetadataError } from "../errors/errors.js";
import type { AttributeType } from "./attribute-type.js";

export class TypeRegistry {
  readonly #types = new Map<string, AttributeType>();

  register<T>(type: AttributeType<T>): this {
    if (this.#types.has(type.name)) {
      throw new MetadataError(`Attribute type '${type.name}' is already registered.`);
    }
    this.#types.set(type.name, type as AttributeType);
    return this;
  }

  replace<T>(type: AttributeType<T>): this {
    this.#types.set(type.name, type as AttributeType);
    return this;
  }

  get<T = unknown>(name: string): AttributeType<T> {
    const type = this.#types.get(name);
    if (!type) {
      throw new AttributeTypeNotFoundError(`Unknown attribute type '${name}'.`);
    }
    return type as AttributeType<T>;
  }

  has(name: string): boolean {
    return this.#types.has(name);
  }

  names(): readonly string[] {
    return [...this.#types.keys()];
  }
}
