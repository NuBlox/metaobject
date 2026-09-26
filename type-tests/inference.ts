import { defineObjectType, type InferValues } from "../src/index.js";

const Person = defineObjectType({
  id: "example.person",
  name: "Person",
  version: 1,
  attributes: {
    firstName: { type: "string", required: true },
    age: { type: "integer" },
    aliases: { type: "string", multiple: true },
    deletedAt: { type: "datetime", nullable: true },
  },
} as const);

type PersonValues = InferValues<typeof Person>;

const valid: PersonValues = {
  firstName: "Stephen",
  age: 41,
  aliases: ["Steve"],
  deletedAt: null,
};
void valid;

// @ts-expect-error firstName is required.
const missing: PersonValues = { age: 41 };
void missing;

// @ts-expect-error age is numeric.
const wrong: PersonValues = { firstName: "Stephen", age: "41" };
void wrong;
