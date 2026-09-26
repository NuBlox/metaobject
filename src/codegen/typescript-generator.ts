import type { AttributeDefinition, ObjectTypeDefinition } from "../metadata/definitions.js";

const builtins: Record<string, string> = {
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

function tsType(attribute: AttributeDefinition): string {
  let result = builtins[attribute.type] ?? "unknown";
  if (attribute.multiple) result = `readonly ${result}[]`;
  if (attribute.nullable) result = `${result} | null`;
  return result;
}

export function generateTypeScriptInterface(definition: ObjectTypeDefinition): string {
  const lines = [`export interface ${definition.name} {`];
  for (const [name, attribute] of Object.entries(definition.attributes)) {
    lines.push(`  ${name}${attribute.required ? "" : "?"}: ${tsType(attribute)};`);
  }
  lines.push("}");
  return lines.join("\n");
}
