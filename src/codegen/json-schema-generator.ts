import type {
  AttributeDefinition,
  ConstraintDefinition,
  ObjectTypeDefinition,
  RelationshipDefinition,
} from "../metadata/definitions.js";

export type JsonSchema = Readonly<Record<string, unknown>>;

function constraintKeywords(constraints: readonly ConstraintDefinition[] | undefined): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const constraint of constraints ?? []) {
    switch (constraint.type) {
      case "minLength": output.minLength = constraint.value; break;
      case "maxLength": output.maxLength = constraint.value; break;
      case "range": {
        if (constraint.minimum !== undefined) output.minimum = constraint.minimum;
        if (constraint.maximum !== undefined) output.maximum = constraint.maximum;
        break;
      }
      case "pattern": if (constraint.pattern !== undefined) output.pattern = constraint.pattern; break;
      default: {
        const extensions = (output["x-nublox-constraints"] as unknown[] | undefined) ?? [];
        extensions.push(structuredClone(constraint));
        output["x-nublox-constraints"] = extensions;
      }
    }
  }
  return output;
}

function scalarSchema(attribute: AttributeDefinition): Record<string, unknown> {
  const schema: Record<string, unknown> = {};
  switch (attribute.type) {
    case "string": schema.type = "string"; break;
    case "integer": schema.type = "integer"; break;
    case "number":
    case "decimal": schema.type = "number"; break;
    case "boolean": schema.type = "boolean"; break;
    case "date": Object.assign(schema, { type: "string", format: "date" }); break;
    case "datetime": Object.assign(schema, { type: "string", format: "date-time" }); break;
    case "uuid": Object.assign(schema, { type: "string", format: "uuid" }); break;
    case "binary": Object.assign(schema, { type: "string", contentEncoding: "base64" }); break;
    case "json": break;
    default: schema["x-nublox-attribute-type"] = attribute.type;
  }
  Object.assign(schema, constraintKeywords(attribute.constraints));
  if (attribute.readOnly || attribute.computed) schema.readOnly = true;
  if (attribute.unique) schema["x-nublox-unique"] = true;
  if (attribute.default !== undefined) schema.default = structuredClone(attribute.default);
  return schema;
}

function attributeSchema(attribute: AttributeDefinition): Record<string, unknown> {
  let schema: Record<string, unknown> = scalarSchema(attribute);
  if (attribute.multiple) schema = { type: "array", items: schema };
  if (attribute.nullable) {
    schema = { anyOf: [schema, { type: "null" }] };
  }
  return schema;
}

function referenceSchema(target: string): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      id: { type: "string", minLength: 1 },
      type: { const: target },
    },
    required: ["id", "type"],
    "x-nublox-object-reference": true,
  };
}

function relationshipSchema(relationship: RelationshipDefinition): Record<string, unknown> {
  const reference = referenceSchema(relationship.target);
  const many = relationship.cardinality === "one-to-many" || relationship.cardinality === "many-to-many";
  const schema: Record<string, unknown> = many
    ? { type: "array", items: reference, uniqueItems: true }
    : reference;
  schema["x-nublox-relationship"] = {
    target: relationship.target,
    cardinality: relationship.cardinality,
    ...(relationship.inverse !== undefined ? { inverse: relationship.inverse } : {}),
    ...(relationship.ownership !== undefined ? { ownership: relationship.ownership } : {}),
    ...(relationship.kind !== undefined ? { kind: relationship.kind } : {}),
    ...(relationship.ordered !== undefined ? { ordered: relationship.ordered } : {}),
    ...(relationship.onSourceDelete !== undefined ? { onSourceDelete: relationship.onSourceDelete } : {}),
    ...(relationship.onTargetDelete !== undefined ? { onTargetDelete: relationship.onTargetDelete } : {}),
  };
  return schema;
}

/** Generate JSON Schema draft 2020-12 for one metadata-defined object type. */
export function generateJsonSchema(definition: ObjectTypeDefinition): JsonSchema {
  const properties: Record<string, unknown> = {
    $id: { type: "string" },
    $type: { const: definition.id },
    $schemaVersion: { const: definition.version },
  };
  const required = ["$id", "$type", "$schemaVersion"];

  for (const [name, attribute] of Object.entries(definition.attributes)) {
    properties[name] = attributeSchema(attribute);
    if (attribute.required && !attribute.computed) required.push(name);
  }
  for (const [name, relationship] of Object.entries(definition.relationships ?? {})) {
    properties[name] = relationshipSchema(relationship);
    if (relationship.required) required.push(name);
  }

  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `urn:nublox:metaobject:${definition.id}:v${definition.version}`,
    title: definition.name,
    type: "object",
    properties,
    required,
    additionalProperties: definition.extensible === true,
    "x-nublox-object-type": {
      id: definition.id,
      version: definition.version,
      ...(definition.namespace !== undefined ? { namespace: definition.namespace } : {}),
      ...(definition.baseType !== undefined ? { baseType: definition.baseType } : {}),
      ...(definition.abstract !== undefined ? { abstract: definition.abstract } : {}),
      ...(definition.sealed !== undefined ? { sealed: definition.sealed } : {}),
    },
  };
}

export function generateJsonSchemaText(definition: ObjectTypeDefinition, space = 2): string {
  return JSON.stringify(generateJsonSchema(definition), null, space);
}
