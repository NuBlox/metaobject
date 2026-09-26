import { ValidationError } from "../errors/errors.js";
import type { ObjectQuery } from "../query/query.js";
import type { MetaObject } from "../runtime/meta-object.js";
import type { ObjectFactory } from "../runtime/object-factory.js";
import type { ObjectIdentity } from "../runtime/model.js";
import type { Validator } from "../validation/validation.js";
import type { StorageAdapter } from "./storage-adapter.js";

export class MetaObjectRepository {
  constructor(
    private readonly storage: StorageAdapter,
    private readonly factory: ObjectFactory,
    private readonly validator: Validator,
  ) {}

  async save<T extends Record<string, unknown>>(object: MetaObject<T>): Promise<MetaObject<T>> {
    const validation = this.validator.validate(object);
    if (!validation.valid) {
      const summary = validation.issues.map((item) => `${item.path ?? "$"}: ${item.message}`).join("; ");
      throw new ValidationError(`Object '${object.objectType.id}' is invalid: ${summary}`);
    }
    if (object.state === "deleted" || object.state === "detached") {
      throw new ValidationError(`Cannot save an object in '${object.state}' state.`);
    }
    if (object.state === "clean") return object;
    const snapshot = object.snapshot();
    const persisted = object.state === "new"
      ? await this.storage.insert(snapshot)
      : await this.storage.update(snapshot, object.version);
    object.markPersisted(persisted.version);
    return object;
  }

  async find(identity: ObjectIdentity): Promise<MetaObject | null> {
    const snapshot = await this.storage.get(identity);
    return snapshot ? this.factory.hydrate(snapshot) : null;
  }

  async query(query: ObjectQuery): Promise<readonly MetaObject[]> {
    const snapshots = await this.storage.query(query);
    return snapshots.map((snapshot) => this.factory.hydrate(snapshot));
  }

  async delete(object: MetaObject): Promise<void> {
    if (object.state === "new") {
      object.markDeleted();
      return;
    }
    await this.storage.delete({ id: object.id, type: object.objectType.id }, object.version);
    object.markDeleted();
  }
}
