import type { AttributeDefinition, ConstraintDefinition, ObjectRuleDefinition } from "../metadata/definitions.js";
import type { MetaObject } from "../runtime/meta-object.js";

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

export interface ConstraintValidationContext {
  readonly object: MetaObject;
  readonly attribute: string;
  readonly attributeDefinition: AttributeDefinition;
  readonly constraint: ConstraintDefinition;
  readonly path: string;
}

export interface RuleValidationContext {
  readonly object: MetaObject;
  readonly rule: ObjectRuleDefinition;
}

export function validationIssue(
  code: string,
  message: string,
  severity: ValidationSeverity = "error",
  path?: string,
): ValidationIssue {
  return path === undefined
    ? { code, message, severity }
    : { code, path, message, severity };
}
