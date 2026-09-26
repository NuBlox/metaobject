import { MetadataError } from "../errors/errors.js";
import type { ConstraintDefinition } from "../metadata/definitions.js";
import type { ConstraintValidationContext, ValidationIssue } from "./model.js";
import { validationIssue } from "./model.js";

export type ConstraintEvaluator = (
  value: unknown,
  definition: ConstraintDefinition,
  context: ConstraintValidationContext,
) => ValidationIssue | readonly ValidationIssue[] | null;

function asIssues(result: ValidationIssue | readonly ValidationIssue[] | null): readonly ValidationIssue[] {
  if (result === null) return [];
  return Array.isArray(result) ? result : [result as ValidationIssue];
}

export class ConstraintRegistry {
  readonly #evaluators = new Map<string, ConstraintEvaluator>();

  register(type: string, evaluator: ConstraintEvaluator): this {
    if (!type.trim()) throw new MetadataError("Constraint type is required.");
    if (this.#evaluators.has(type)) throw new MetadataError(`Constraint '${type}' is already registered.`);
    this.#evaluators.set(type, evaluator);
    return this;
  }

  has(type: string): boolean { return this.#evaluators.has(type); }

  evaluate(
    value: unknown,
    definition: ConstraintDefinition,
    context: ConstraintValidationContext,
  ): readonly ValidationIssue[] {
    const evaluator = this.#evaluators.get(definition.type);
    if (!evaluator) {
      throw new MetadataError(
        `Attribute '${context.object.objectType.id}.${context.attribute}' references unknown constraint '${definition.type}'.`,
      );
    }
    return asIssues(evaluator(value, definition, context));
  }
}

export function createDefaultConstraintRegistry(): ConstraintRegistry {
  return new ConstraintRegistry()
    .register("minLength", (value, definition, context) => {
      if (typeof value !== "string" && !Array.isArray(value)) return null;
      const minimum = definition.value ?? 0;
      return value.length < minimum
        ? validationIssue(
          "MIN_LENGTH",
          definition.message ?? `${context.path} must contain at least ${minimum} item(s)/character(s).`,
          "error",
          context.path,
        )
        : null;
    })
    .register("maxLength", (value, definition, context) => {
      if (typeof value !== "string" && !Array.isArray(value)) return null;
      const maximum = definition.value ?? Number.MAX_SAFE_INTEGER;
      return value.length > maximum
        ? validationIssue(
          "MAX_LENGTH",
          definition.message ?? `${context.path} must contain no more than ${maximum} item(s)/character(s).`,
          "error",
          context.path,
        )
        : null;
    })
    .register("range", (value, definition, context) => {
      if (typeof value !== "number") return null;
      if (definition.minimum !== undefined && value < definition.minimum) {
        return validationIssue(
          "MINIMUM",
          definition.message ?? `${context.path} must be at least ${definition.minimum}.`,
          "error",
          context.path,
        );
      }
      if (definition.maximum !== undefined && value > definition.maximum) {
        return validationIssue(
          "MAXIMUM",
          definition.message ?? `${context.path} must be no more than ${definition.maximum}.`,
          "error",
          context.path,
        );
      }
      return null;
    })
    .register("pattern", (value, definition, context) => {
      if (typeof value !== "string") return null;
      const regex = new RegExp(definition.pattern ?? "", definition.flags);
      return regex.test(value)
        ? null
        : validationIssue(
          "PATTERN",
          definition.message ?? `${context.path} does not match the required pattern.`,
          "error",
          context.path,
        );
    });
}
