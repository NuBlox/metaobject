import type { ConstraintDefinition } from "../metadata/definitions.js";
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

function issue(code: string, path: string, message: string): ValidationIssue {
  return { code, path, message, severity: "error" };
}

function validateConstraint(path: string, value: unknown, constraint: ConstraintDefinition): ValidationIssue | null {
  switch (constraint.type) {
    case "minLength": {
      if (typeof value !== "string" && !Array.isArray(value)) return null;
      const minimum = constraint.value ?? 0;
      return value.length < minimum
        ? issue("MIN_LENGTH", path, constraint.message ?? `${path} must contain at least ${minimum} item(s)/character(s).`)
        : null;
    }
    case "maxLength": {
      if (typeof value !== "string" && !Array.isArray(value)) return null;
      const maximum = constraint.value ?? Number.MAX_SAFE_INTEGER;
      return value.length > maximum
        ? issue("MAX_LENGTH", path, constraint.message ?? `${path} must contain no more than ${maximum} item(s)/character(s).`)
        : null;
    }
    case "range": {
      if (typeof value !== "number") return null;
      if (constraint.minimum !== undefined && value < constraint.minimum) {
        return issue("MINIMUM", path, constraint.message ?? `${path} must be at least ${constraint.minimum}.`);
      }
      if (constraint.maximum !== undefined && value > constraint.maximum) {
        return issue("MAXIMUM", path, constraint.message ?? `${path} must be no more than ${constraint.maximum}.`);
      }
      return null;
    }
    case "pattern": {
      if (typeof value !== "string") return null;
      const regex = new RegExp(constraint.pattern ?? "", constraint.flags);
      return regex.test(value)
        ? null
        : issue("PATTERN", path, constraint.message ?? `${path} does not match the required pattern.`);
    }
  }
}

export class Validator {
  validate(object: MetaObject): ValidationResult {
    const issues: ValidationIssue[] = [];
    for (const [name, attribute] of Object.entries(object.objectType.attributes)) {
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
            const result = validateConstraint(`${name}[${index}]`, value[index], constraint);
            if (result) issues.push(result);
          }
        } else {
          const result = validateConstraint(name, value, constraint);
          if (result) issues.push(result);
        }
      }
    }

    for (const [name, relationship] of Object.entries(object.objectType.relationships ?? {})) {
      const raw = object.getRelationship(name);
      const refs = object.relationshipReferences(name);
      const empty = refs.length === 0;
      if (relationship.required && empty) {
        issues.push(issue("RELATIONSHIP_REQUIRED", name, `${name} relationship is required.`));
      }
      const many = relationship.cardinality === "one-to-many" || relationship.cardinality === "many-to-many";
      if (raw !== undefined && many !== Array.isArray(raw)) {
        issues.push(issue(
          "RELATIONSHIP_CARDINALITY",
          name,
          `${name} relationship does not match cardinality '${relationship.cardinality}'.`,
        ));
      }
      for (let index = 0; index < refs.length; index += 1) {
        const ref = refs[index]!;
        if (ref.type !== relationship.target) {
          issues.push(issue(
            "RELATIONSHIP_TARGET_TYPE",
            `${name}[${index}]`,
            `${name} requires target type '${relationship.target}', received '${ref.type}'.`,
          ));
        }
        if (refs.slice(0, index).some((other) => sameObjectIdentity(other, ref))) {
          issues.push(issue(
            "RELATIONSHIP_DUPLICATE_TARGET",
            `${name}[${index}]`,
            `${name} contains duplicate target '${ref.type}:${ref.id}'.`,
          ));
        }
      }
    }
    return { valid: issues.length === 0, issues };
  }
}
