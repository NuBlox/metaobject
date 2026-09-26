export class MetaObjectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class MetadataError extends MetaObjectError {}
export class ValidationError extends MetaObjectError {}
export class ConcurrencyError extends MetaObjectError {}
export class ObjectTypeNotFoundError extends MetaObjectError {}
export class AttributeTypeNotFoundError extends MetaObjectError {}
