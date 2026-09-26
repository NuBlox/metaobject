import { MetadataError } from "../errors/errors.js";
import type { ObjectTypeDefinition } from "../metadata/definitions.js";
import { normalizeObjectType } from "../metadata/persistence-model.js";
import { generateJsonSchemaText } from "./json-schema-generator.js";
import {
  generateTypeScriptClass,
  generateTypeScriptCreateInput,
  generateTypeScriptInterface,
  generateTypeScriptModule,
} from "./typescript-generator.js";
import { generateTypeScriptValidator } from "./validator-generator.js";

export interface GeneratedArtifact {
  readonly name: string;
  readonly kind: string;
  readonly mediaType: string;
  readonly content: string;
  readonly objectTypeId: string;
  readonly objectTypeVersion: number;
}

export interface ArtifactGenerationContext {
  readonly definitions: readonly ObjectTypeDefinition[];
  readonly options?: Readonly<Record<string, unknown>>;
}

export type ArtifactGenerator = (context: ArtifactGenerationContext) => readonly GeneratedArtifact[];

function fileStem(definition: ObjectTypeDefinition): string {
  return definition.id.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "object-type";
}

function textArtifact(
  definition: ObjectTypeDefinition,
  kind: string,
  extension: string,
  mediaType: string,
  content: string,
): GeneratedArtifact {
  return {
    name: `${fileStem(definition)}.${extension}`,
    kind,
    mediaType,
    content,
    objectTypeId: definition.id,
    objectTypeVersion: definition.version,
  };
}

/**
 * Registry for first-party and adapter-specific code/artifact generators. SQL
 * adapter packages can register their own DDL/mapping generators without the
 * core package taking a dependency on a database dialect.
 */
export class ArtifactGeneratorRegistry {
  readonly #generators = new Map<string, ArtifactGenerator>();

  register(name: string, generator: ArtifactGenerator): this {
    if (!name.trim()) throw new MetadataError("Artifact generator name is required.");
    if (this.#generators.has(name)) throw new MetadataError(`Artifact generator '${name}' is already registered.`);
    this.#generators.set(name, generator);
    return this;
  }

  has(name: string): boolean { return this.#generators.has(name); }

  names(): readonly string[] { return [...this.#generators.keys()].sort(); }

  generate(
    name: string,
    definitions: readonly ObjectTypeDefinition[],
    options?: Readonly<Record<string, unknown>>,
  ): readonly GeneratedArtifact[] {
    const generator = this.#generators.get(name);
    if (!generator) throw new MetadataError(`Unknown artifact generator '${name}'.`);
    return generator({ definitions, ...(options === undefined ? {} : { options }) });
  }

  generateMany(
    names: readonly string[],
    definitions: readonly ObjectTypeDefinition[],
    options?: Readonly<Record<string, unknown>>,
  ): readonly GeneratedArtifact[] {
    return names.flatMap((name) => this.generate(name, definitions, options));
  }
}

export function createDefaultArtifactGeneratorRegistry(): ArtifactGeneratorRegistry {
  const registry = new ArtifactGeneratorRegistry();

  registry.register("typescript", ({ definitions }) => definitions.map((definition) =>
    textArtifact(definition, "typescript", "ts", "text/typescript", generateTypeScriptModule(definition)),
  ));
  registry.register("typescript-interface", ({ definitions }) => definitions.map((definition) =>
    textArtifact(definition, "typescript-interface", "interface.ts", "text/typescript", generateTypeScriptInterface(definition)),
  ));
  registry.register("typescript-create-input", ({ definitions }) => definitions.map((definition) =>
    textArtifact(definition, "typescript-create-input", "create-input.ts", "text/typescript", generateTypeScriptCreateInput(definition)),
  ));
  registry.register("typescript-class", ({ definitions }) => definitions.map((definition) =>
    textArtifact(definition, "typescript-class", "model.ts", "text/typescript", generateTypeScriptClass(definition)),
  ));
  registry.register("typescript-validator", ({ definitions }) => definitions.map((definition) =>
    textArtifact(definition, "typescript-validator", "validator.ts", "text/typescript", generateTypeScriptValidator(definition)),
  ));
  registry.register("json-schema", ({ definitions }) => definitions.map((definition) =>
    textArtifact(definition, "json-schema", "schema.json", "application/schema+json", generateJsonSchemaText(definition)),
  ));
  registry.register("metadata-snapshot", ({ definitions }) => definitions.map((definition) =>
    textArtifact(
      definition,
      "metadata-snapshot",
      "metadata.json",
      "application/json",
      JSON.stringify(normalizeObjectType(definition), null, 2),
    ),
  ));

  return registry;
}
