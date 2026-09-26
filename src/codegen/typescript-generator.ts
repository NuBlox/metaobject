import type {
  AttributeDefinition,
  ObjectTypeDefinition,
  RelationshipDefinition,
} from "../metadata/definitions.js";

const builtins: Readonly<Record<string, string>> = {
  string: "string",
  integer: "number",
  number: "number",
  decimal: "number",
  boolean: "boolean",
  date: "Date",
  datetime: "Date",
  uuid: "string",
  json: "unknown",
  binary: "Uint8Array",
};

export interface TypeScriptGenerationOptions {
  /** Override the generated type name. Defaults to definition.name. */
  readonly typeName?: string;
  /** Include relationships in the value interface. Defaults to true. */
  readonly relationships?: boolean;
  /** Include computed values in create-input types. Defaults to false. */
  readonly computedInputs?: boolean;
}

function identifier(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_$]/g, "_");
  const candidate = /^[A-Za-z_$]/.test(cleaned) ? cleaned : `_${cleaned}`;
  return candidate || "GeneratedType";
}

function propertyName(value: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : JSON.stringify(value);
}

function attributeType(attribute: AttributeDefinition): string {
  let result = builtins[attribute.type] ?? "unknown";
  if (attribute.multiple) result = `readonly ${result}[]`;
  if (attribute.nullable) result = `${result} | null`;
  return result;
}

function relationshipType(relationship: RelationshipDefinition): string {
  const reference = `ObjectReference<${JSON.stringify(relationship.target)}>`;
  return relationship.cardinality === "one-to-many" || relationship.cardinality === "many-to-many"
    ? `readonly ${reference}[]`
    : reference;
}

function interfaceLines(
  definition: ObjectTypeDefinition,
  typeName: string,
  includeRelationships: boolean,
): string[] {
  const lines = [`export interface ${typeName} {`];
  for (const [name, attribute] of Object.entries(definition.attributes)) {
    lines.push(`  ${propertyName(name)}${attribute.required ? "" : "?"}: ${attributeType(attribute)};`);
  }
  if (includeRelationships) {
    for (const [name, relationship] of Object.entries(definition.relationships ?? {})) {
      lines.push(`  ${propertyName(name)}${relationship.required ? "" : "?"}: ${relationshipType(relationship)};`);
    }
  }
  lines.push("}");
  return lines;
}

function createInputLines(
  definition: ObjectTypeDefinition,
  typeName: string,
  includeComputed: boolean,
): string[] {
  const lines = [`export interface ${typeName} {`];
  for (const [name, attribute] of Object.entries(definition.attributes)) {
    if (attribute.computed && !includeComputed) continue;
    const required = attribute.required && attribute.default === undefined;
    lines.push(`  ${propertyName(name)}${required ? "" : "?"}: ${attributeType(attribute)};`);
  }
  lines.push("}");
  return lines;
}

function modelClassLines(definition: ObjectTypeDefinition, typeName: string): string[] {
  return [
    `export class ${typeName}Model {`,
    `  static readonly objectTypeId = ${JSON.stringify(definition.id)} as const;`,
    `  static readonly schemaVersion = ${definition.version} as const;`,
    `  readonly values: Readonly<${typeName}>;`,
    "",
    `  constructor(values: ${typeName}) {`,
    "    this.values = Object.freeze({ ...values });",
    "    Object.freeze(this);",
    "  }",
    "}",
  ];
}

/** Generate the primary value interface for one metadata definition. */
export function generateTypeScriptInterface(
  definition: ObjectTypeDefinition,
  options: TypeScriptGenerationOptions = {},
): string {
  const typeName = identifier(options.typeName ?? definition.name);
  return [
    "export interface ObjectReference<TType extends string = string> {",
    "  readonly id: string;",
    "  readonly type: TType;",
    "}",
    "",
    ...interfaceLines(definition, typeName, options.relationships !== false),
  ].join("\n");
}

/** Generate a create-input interface excluding computed values by default. */
export function generateTypeScriptCreateInput(
  definition: ObjectTypeDefinition,
  options: TypeScriptGenerationOptions = {},
): string {
  return createInputLines(
    definition,
    `${identifier(options.typeName ?? definition.name)}CreateInput`,
    options.computedInputs === true,
  ).join("\n");
}

/** Generate a typed immutable wrapper class for a metadata-defined value. */
export function generateTypeScriptClass(
  definition: ObjectTypeDefinition,
  options: TypeScriptGenerationOptions = {},
): string {
  const typeName = identifier(options.typeName ?? definition.name);
  return [
    "export interface ObjectReference<TType extends string = string> {",
    "  readonly id: string;",
    "  readonly type: TType;",
    "}",
    "",
    ...interfaceLines(definition, typeName, options.relationships !== false),
    "",
    ...modelClassLines(definition, typeName),
  ].join("\n");
}

/** Generate interface, create input and immutable model class in one module. */
export function generateTypeScriptModule(
  definition: ObjectTypeDefinition,
  options: TypeScriptGenerationOptions = {},
): string {
  const typeName = identifier(options.typeName ?? definition.name);
  return [
    "export interface ObjectReference<TType extends string = string> {",
    "  readonly id: string;",
    "  readonly type: TType;",
    "}",
    "",
    ...interfaceLines(definition, typeName, options.relationships !== false),
    "",
    ...createInputLines(definition, `${typeName}CreateInput`, options.computedInputs === true),
    "",
    ...modelClassLines(definition, typeName),
  ].join("\n");
}
