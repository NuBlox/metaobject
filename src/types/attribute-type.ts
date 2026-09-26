export interface AttributeType<T = unknown> {
  readonly name: string;
  validate(value: unknown): value is T;
  serialize(value: T): unknown;
  deserialize(value: unknown): T;
  equals?(left: T, right: T): boolean;
}
