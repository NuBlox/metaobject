import { MetadataError } from "../errors/errors.js";
import type { ObjectRuleDefinition } from "../metadata/definitions.js";
import type { MetaObject } from "../runtime/meta-object.js";
import type { RuleValidationContext, ValidationIssue } from "./model.js";

export type ObjectRuleEvaluator = (
  object: MetaObject,
  definition: ObjectRuleDefinition,
  context: RuleValidationContext,
) => ValidationIssue | readonly ValidationIssue[] | null;

export class ObjectRuleRegistry {
  readonly #evaluators = new Map<string, ObjectRuleEvaluator>();

  register(type: string, evaluator: ObjectRuleEvaluator): this {
    if (!type.trim()) throw new MetadataError("Object rule type is required.");
    if (this.#evaluators.has(type)) throw new MetadataError(`Object rule '${type}' is already registered.`);
    this.#evaluators.set(type, evaluator);
    return this;
  }

  has(type: string): boolean { return this.#evaluators.has(type); }

  evaluate(object: MetaObject, definition: ObjectRuleDefinition): readonly ValidationIssue[] {
    const evaluator = this.#evaluators.get(definition.type);
    if (!evaluator) {
      throw new MetadataError(
        `Object rule '${object.objectType.id}.${definition.id}' references unknown evaluator '${definition.type}'.`,
      );
    }
    const result = evaluator(object, definition, { object, rule: definition });
    if (result === null) return [];
    return Array.isArray(result) ? result : [result as ValidationIssue];
  }
}
