import { createMetaObject, defineObject, meta } from "../src/index.js";

const Person = defineObject({
  id: "Person",
  name: "Person",
  version: 1,
  attributes: {
    name: meta.string({ required: true }),
    age: meta.integer(),
  },
});

const runtime = createMetaObject();
runtime.define(Person);

const person = runtime.create(Person, {
  name: "Stephen",
  age: 41,
});

const name: string | undefined = person.get("name");
const age: number | undefined = person.get("age");
void name;
void age;

// @ts-expect-error name is required
runtime.create(Person, { age: 41 });

// @ts-expect-error age must be numeric
runtime.create(Person, { name: "Stephen", age: "41" });
