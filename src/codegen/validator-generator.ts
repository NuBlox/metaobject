import type { AttributeDefinition, ConstraintDefinition, ObjectTypeDefinition } from "../metadata/definitions.js";

export interface ValidatorGenerationOptions {
  readonly functionName?: string;
}

function identifier(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_$]/g, "_");
  const candidate = /^[A-Za-z_$]/.test(cleaned) ? cleaned : `_${cleaned}`;
  return candidate || "Generated";
}

function literal(value: unknown): string {
  return JSON.stringify(value);
}

function typeExpression(attribute: AttributeDefinition, variable: string): string {
  const single = (() => {
    switch (attribute.type) {
      case "string":
      case "uuid": return `typeof ${variable} === "string"`;
      case "integer": return `typeof ${variable} === "number" && Number.isInteger(${variable})`;
      case "number":
      case "decimal": return `typeof ${variable} === "number" && Number.isFinite(${variable})`;
      case "boolean": return `typeof ${variable} === "boolean"`;
      case "date":
      case "datetime": return `${variable} instanceof Date || typeof ${variable} === "string"`;
      case "binary": return `${variable} instanceof Uint8Array || typeof ${variable} === "string"`;
      case "json": return "true";
      default: return "true";
    }
  })();
  return attribute.multiple
    ? `Array.isArray(${variable}) && ${variable}.every((item) => ${typeExpression({ ...attribute, multiple: false }, "item")})`
    : single;
}

function builtInConstraintLines(
  constraint: ConstraintDefinition,
  valueVariable: string,
  pathExpression: string,
): string[] | null {
  const message = constraint.message ? literal(constraint.message) : undefined;
  switch (constraint.type) {
    case "minLength": {
      const minimum = constraint.value ?? 0;
      return [
        `if ((typeof ${valueVariable} === "string" || Array.isArray(${valueVariable})) && ${valueVariable}.length < ${minimum}) {`,
        `  issues.push({ code: "MIN_LENGTH", path: ${pathExpression}, message: ${message ?? literal(`Value must contain at least ${minimum} item(s)/character(s).`)} });`,
        "}",
      ];
    }
    case "maxLength": {
      const maximum = constraint.value ?? Number.MAX_SAFE_INTEGER;
      return [
        `if ((typeof ${valueVariable} === "string" || Array.isArray(${valueVariable})) && ${valueVariable}.length > ${maximum}) {`,
        `  issues.push({ code: "MAX_LENGTH", path: ${pathExpression}, message: ${message ?? literal(`Value must contain no more than ${maximum} item(s)/character(s).`)} });`,
        "}",
      ];
    }
    case "range": {
      const lines: string[] = [];
      if (constraint.minimum !== undefined) {
        lines.push(
          `if (typeof ${valueVariable} === "number" && ${valueVariable} < ${constraint.minimum}) {`,
          `  issues.push({ code: "MINIMUM", path: ${pathExpression}, message: ${message ?? literal(`Value must be at least ${constraint.minimum}.`)} });`,
          "}",
        );
      }
      if (constraint.maximum !== undefined) {
        lines.push(
          `if (typeof ${valueVariable} === "number" && ${valueVariable} > ${constraint.maximum}) {`,
          `  issues.push({ code: "MAXIMUM", path: ${pathExpression}, message: ${message ?? literal(`Value must be no more than ${constraint.maximum}.`)} });`,
          "}",
        );
      }
      return lines;
    }
    case "pattern": {
      const pattern = literal(constraint.pattern ?? "");
      const flags = literal(constraint.flags ?? "");
      return [
        `if (typeof ${valueVariable} === "string" && !new RegExp(${pattern}, ${flags}).test(${valueVariable})) {`,
        `  issues.push({ code: "PATTERN", path: ${pathExpression}, message: ${message ?? literal("Value does not match the required pattern.")} });`,
        "}",
      ];
    }
    default: return null;
  }
}

function indent(lines: readonly string[], spaces: number): string[] {
  const prefix = " ".repeat(spaces);
  return lines.map((line) => line.length === 0 ? line : `${prefix}${line}`);
}

/**
 * Generate a dependency-free validator module for plain data objects. Built-in
 * constraints are emitted directly; custom constraints are delegated through a
 * runtime callback map keyed by metadata constraint type.
 */
export function generateTypeScriptValidator(
  definition: ObjectTypeDefinition,
  options: ValidatorGenerationOptions = {},
): string {
  const name = identifier(options.functionName ?? `validate${definition.name}`);
  const lines: string[] = [
    "export interface GeneratedValidationIssue {",
    "  readonly code: string;",
    "  readonly path: string;",
    "  readonly message: string;",
    "}",
    "",
    "export type GeneratedConstraint = (value: unknown, context: { readonly object: Record<string, unknown>; readonly path: string; readonly parameters?: Readonly<Record<string, unknown>> }) => boolean | string | undefined;",
    "",
    `export function ${name}(`,
    "  value: unknown,",
    "  customConstraints: Readonly<Record<string, GeneratedConstraint>> = {},",
    "): readonly GeneratedValidationIssue[] {",
    "  const issues: GeneratedValidationIssue[] = [];",
    "  if (typeof value !== \"object\" || value === null || Array.isArray(value)) {",
    "    return [{ code: \"OBJECT_REQUIRED\", path: \"$\", message: \"Value must be an object.\" }];",
    "  }",
    "  const object = value as Record<string, unknown>;",
  ];

  for (const [attributeName, attribute] of Object.entries(definition.attributes)) {
    if (attribute.computed) continue;
    const key = literal(attributeName);
    const path = literal(attributeName);
    const variable = `object[${key}]`;
    lines.push(`  if (${variable} === undefined) {`);
    if (attribute.required && attribute.default === undefined) {
      lines.push(`    issues.push({ code: "REQUIRED", path: ${path}, message: ${literal(`${attributeName} is required.`)} });`);
    }
    lines.push("  } else if (" + variable + " === null) {");
    if (!attribute.nullable) {
      lines.push(`    issues.push({ code: "NULL_NOT_ALLOWED", path: ${path}, message: ${literal(`${attributeName} cannot be null.`)} });`);
    }
    lines.push("  } else {");
    lines.push(`    if (!(${typeExpression(attribute, variable)})) {`);
    lines.push(`      issues.push({ code: "TYPE", path: ${path}, message: ${literal(`${attributeName} has an invalid type.`)} });`);
    lines.push("    } else {");

    for (const constraint of attribute.constraints ?? []) {
      const emitted = builtInConstraintLines(constraint, variable, path);
      if (emitted) {
        lines.push(...indent(emitted, 6));
      } else {
        const type = literal(constraint.type);
        const parameters = literal(constraint.parameters ?? {});
        const fallbackMessage = literal(constraint.message ?? `${attributeName} failed constraint '${constraint.type}'.`);
        lines.push(
          `      if (customConstraints[${type}]) {`,
          `        const result = customConstraints[${type}]!(${variable}, { object, path: ${path}, parameters: ${parameters} });`,
          "        if (result !== true && result !== undefined) {",
          `          issues.push({ code: ${literal(constraint.type.replace(/([a-z])([A-Z])/g, "$1_$2").replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase())}, path: ${path}, message: typeof result === "string" ? result : ${fallbackMessage} });`,
          "        }",
          "      } else {",
          `        issues.push({ code: "UNKNOWN_CONSTRAINT", path: ${path}, message: ${literal(`No generated validator was supplied for custom constraint '${constraint.type}'.`)} });`,
          "      }",
        );
      }
    }

    lines.push("    }");
    lines.push("  }");
  }

  lines.push("  return issues;", "}");
  return lines.join("\n");
}
