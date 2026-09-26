import { MetadataError } from "../errors/errors.js";
import type { ConstraintDefinition, ObjectRuleDefinition } from "../metadata/definitions.js";
import type { BehaviorRegistry } from "../runtime/behavior-registry.js";
import type { MetaObject } from "../runtime/meta-object.js";
import { sameObjectIdentity } from "../runtime/model.js";

export type ValidationSeverity = "error" | "warning" | "info";

export interface ValidationIssue {
  readonly code: string;
  readonly path?: string;
  readonly message: string;
  readonly severity: ValidationSeverity;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly issues: readonly ValidationIssue[];
}

export interface ConstraintContext {
  readonly object: MetaObject;
  readonly path: string;
  readonly definition: ConstraintDefinition | ObjectRuleDefinition;
}

/** Return true/undefined when valid, false for default failure text, or a string for custom failure text. */
export type ConstraintEvaluator = (value: unknown, context: ConstraintContext) => boolean | string | undefined;

function issue(code: string, path: string, message: string, severity: ValidationSeverity = "error"): ValidationIssue {
  return { code, path, message, severity };
}

function codeFor(type: string): string {
  return type.replace(/([a-z])([A-Z])/g, "$1_$2").replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase();
}

function compatibilityCode(value: unknown, definition: ConstraintDefinition | ObjectRuleDefinition): string {
  if (definition.type === "range" && typeof value === "number") {
    const constraint = definition as ConstraintDefinition;
    if (constraint.minimum !== undefined && value < constraint.minimum) return "MINIMUM";
    if (constraint.maximum !== undefined && value > constraint.maximum) return "MAXIMUM";
  }
  return codeFor(definition.type);
}

export class ConstraintRegistry {
  readonly #evaluators = new Map<string, ConstraintEvaluator>();

  constructor(options: { builtins?: boolean } = {}) {
    if (options.builtins !== false) this.registerBuiltins();
  }

  register(name: string, evaluator: ConstraintEvaluator): this {
    if (!name.trim()) throw new MetadataError("Constraint name is required.");
    if (this.#evaluators.has(name)) throw new MetadataError(`Constraint '${name}' is already registered.`);
    this.#evaluators.set(name, evaluator);
    return this;
  }

  has(name: string): boolean { return this.#evaluators.has(name); }

  evaluate(value: unknown, context: ConstraintContext, severity: ValidationSeverity = "error"): ValidationIssue | null {
    const evaluator = this.#evaluators.get(context.definition.type);
    if (!evaluator) throw new MetadataError(`Unknown constraint '${context.definition.type}'.`);
    const result = evaluator(value, context);
    if (result === undefined || result === true) return null;
    const message = typeof result === "string"
      ? result
      : context.definition.message ?? `${context.path} failed constraint '${context.definition.type}'.`;
    return issue(compatibilityCode(value, context.definition), context.path, context.definition.message ?? message, severity);
  }

  private registerBuiltins(): void {
    this.register("minLength", (value, { definition }) => {
      if (typeof value !== "string" && !Array.isArray(value)) return true;
      const minimum = (definition as ConstraintDefinition).value ?? 0;
      return value.length >= minimum || `Value must contain at least ${minimum} item(s)/character(s).`;
    });
    this.register("maxLength", (value, { definition }) => {
      if (typeof value !== "string" && !Array.isArray(value)) return true;
      const maximum = (definition as ConstraintDefinition).value ?? Number.MAX_SAFE_INTEGER;
      return value.length <= maximum || `Value must contain no more than ${maximum} item(s)/character(s).`;
    });
    this.register("range", (value, { definition }) => {
      if (typeof value !== "number") return true;
      const constraint = definition as ConstraintDefinition;
      if (constraint.minimum !== undefined && value < constraint.minimum) return `Value must be at least ${constraint.minimum}.`;
      if (constraint.maximum !== undefined && value > constraint.maximum) return `Value must be no more than ${constraint.maximum}.`;
      return true;
    });
    this.register("pattern", (value, { definition }) => {
      if (typeof value !== "string") return true;
      const constraint = definition as ConstraintDefinition;
      return new RegExp(constraint.pattern ?? "", constraint.flags).test(value) || "Value does not match the required pattern.";
    });
  }
}

export class Validator {
  constructor(
    private readonly constraints = new ConstraintRegistry(),
    private readonly behaviors?: BehaviorRegistry,
  ) {}

  validate(object: MetaObject): ValidationResult {
    this.behaviors?.runObjectHooks(object, "beforeValidate");
    const issues: ValidationIssue[] = [];

    for (const [name, attribute] of Object.entries(object.objectType.attributes)) {
      if (attribute.computed) continue;
      const value = object.get(name);
      if (value === undefined) {
        if (attribute.required) issues.push(issue("REQUIRED", name, `${name} is required.`));
        continue;
      }
      if (value === null) {
        if (!attribute.nullable) issues.push(issue("NULL_NOT_ALLOWED", name, `${name} cannot be null.`));
        continue;
      }
      for (const constraint of attribute.constraints ?? []) {
        if (attribute.multiple && Array.isArray(value)) {
          for (let index = 0; index < value.length; index += 1) {
            const path = `${name}[${index}]`;
            const result = this.constraints.evaluate(value[index], { object, path, definition: constraint });
            if (result) issues.push(result);
          }
        } else {
          const result = this.constraints.evaluate(value, { object, path: name, definition: constraint });
          if (result) issues.push(result);
        }
      }
    }

    for (const rule of object.objectType.rules ?? []) {
      const result = this.constraints.evaluate(object.values(), { object, path: rule.id, definition: rule }, rule.severity ?? "error");
      if (result) issues.push(result);
    }

    for (const [name, relationship] of Object.entries(object.objectType.relationships ?? {})) {
      const raw = object.getRelationship(name);
      const refs = object.relationshipReferences(name);
      if (relationship.required && refs.length === 0) {
        issues.push(issue("RELATIONSHIP_REQUIRED", name, `${name} relationship is required.`));
      }
      const many = relationship.cardinality === "one-to-many" || relationship.cardinality === "many-to-many";
      if (raw !== undefined && many !== Array.isArray(raw)) {
        issues.push(issue("RELATIONSHIP_CARDINALITY", name, `${name} relationship does not match cardinality '${relationship.cardinality}'.`));
      }
      for (let index = 0; index < refs.length; index += 1) {
        const ref = refs[index]!;
        if (!object.acceptsRelationshipTarget(name, ref.type)) {
          issues.push(issue("RELATIONSHIP_TARGET_TYPE", `${name}[${index}]`, `${name} requires target type assignable to '${relationship.target}', received '${ref.type}'.`));
        }
        if (refs.slice(0, index).some((other) => sameObjectIdentity(other, ref))) {
          issues.push(issue("RELATIONSHIP_DUPLICATE_TARGET", `${name}[${index}]`, `${name} contains duplicate target '${ref.type}:${ref.id}'.`));
        }
      }
    }

    const result = { valid: !issues.some((entry) => entry.severity === "error"), issues } as const;
    this.behaviors?.runObjectHooks(object, "afterValidate");
    return result;
  }
}
