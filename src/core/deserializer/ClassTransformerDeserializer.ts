/* eslint-disable @typescript-eslint/no-explicit-any */
import { DeserializeOptions } from "./DeserializeOptions";
import { Deserializer } from "./Deserializer";
import { MyClassConstructor } from "../MyClassConstructor";

/**
 * Deserializer implementation backed by class-transformer.
 *
 * class-transformer must be installed:
 * ```bash
 * npm install class-transformer
 * ```
 *
 * For entity classes that carry NO class-transformer metadata anywhere in
 * their prototype chain (no `@Expose` / `@Exclude` / `@Transform` / `@Type`),
 * `plainToClass` degenerates to "new instance + copy keys with Date/Buffer
 * cloning". That case is detected once per class and served by a direct
 * hydrator instead, skipping class-transformer's per-key metadata scans —
 * the dominant CPU cost of result hydration on large result sets. Classes
 * with any class-transformer metadata always take the real `plainToClass`
 * path, so decorator semantics (e.g. `@Exclude` stripping a column on load)
 * are unchanged.
 */
export class ClassTransformerDeserializer implements Deserializer {
  private _plainToClass: Function | undefined;

  /**
   * class-transformer's internal metadata storage.
   * `undefined` = not yet resolved, `null` = unavailable (fast path disabled).
   */
  private _ctStorage: any = undefined;

  private readonly fastPathEnabled: boolean;

  /** Per-class decision: true when the class has no class-transformer metadata. */
  private readonly fastPathCache = new WeakMap<Function, boolean>();

  /** Per-class own property descriptors of `cls.prototype` (getter/method guard). */
  private readonly protoDescriptorCache = new WeakMap<
    Function,
    Record<string, PropertyDescriptor>
  >();

  constructor(options?: { fastPath?: boolean }) {
    this.fastPathEnabled = options?.fastPath !== false;
  }

  /**
   * Pre-loads class-transformer via dynamic import and fills the lazy caches.
   *
   * The lazy getters below load class-transformer with require(), which only
   * exists in the CJS build. ESM runtimes must await this once before the
   * first deserialize call — `DeserializerRegistry.ensureDefaultDetected()`
   * (run during `EntityManager.register()`) does it automatically.
   *
   * @throws when class-transformer is not installed.
   */
  async warmup(): Promise<void> {
    if (this._plainToClass && this._ctStorage !== undefined) return;

    const ctModule: any = await import("class-transformer");
    const ct = ctModule.default?.plainToClass ? ctModule.default : ctModule;
    this._plainToClass = ct.plainToClass;

    try {
      const storageModule: any = await import("class-transformer/cjs/storage");
      this._ctStorage = this.validateCtStorage(
        (storageModule.default ?? storageModule)?.defaultMetadataStorage,
      );
    } catch {
      this._ctStorage = null;
    }
  }

  private getPlainToClass(): Function {
    if (!this._plainToClass) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const ct = require("class-transformer");
        this._plainToClass = ct.plainToClass;
      } catch {
        throw new Error(
          "class-transformer is required for ClassTransformerDeserializer. " +
            "Install it with: npm install class-transformer. " +
            "In ESM runtimes (no require) call `await warmup()` once before use.",
        );
      }
    }
    return this._plainToClass!;
  }

  /**
   * Resolves class-transformer's `defaultMetadataStorage`. Reaches into the
   * package's internal `cjs/storage` module (same approach as
   * `@nestjs/swagger`); when the internal shape ever changes, this resolves
   * to `null` and every class falls back to the regular plainToClass path.
   */
  private getCtStorage(): any {
    if (this._ctStorage !== undefined) return this._ctStorage;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const storageModule = require("class-transformer/cjs/storage");
      this._ctStorage = this.validateCtStorage(
        storageModule?.defaultMetadataStorage,
      );
    } catch {
      this._ctStorage = null;
    }
    return this._ctStorage;
  }

  /** Returns the storage only when its internal shape is the expected one. */
  private validateCtStorage(storage: any): any {
    return storage &&
      storage._typeMetadatas instanceof Map &&
      storage._transformMetadatas instanceof Map &&
      storage._exposeMetadatas instanceof Map &&
      storage._excludeMetadatas instanceof Map
      ? storage
      : null;
  }

  /**
   * True when `cls` (including every ancestor in its prototype chain) has no
   * class-transformer metadata, so direct hydration is behavior-equivalent
   * to `plainToClass`.
   */
  private canFastPath(cls: Function): boolean {
    const cached = this.fastPathCache.get(cls);
    if (cached !== undefined) return cached;

    const storage = this.getCtStorage();
    let result = false;
    if (storage) {
      result = true;
      let target: any = cls;
      while (typeof target === "function" && target.prototype) {
        if (
          storage._typeMetadatas.has(target) ||
          storage._transformMetadatas.has(target) ||
          storage._exposeMetadatas.has(target) ||
          storage._excludeMetadatas.has(target)
        ) {
          result = false;
          break;
        }
        target = Object.getPrototypeOf(target);
      }
    }

    this.fastPathCache.set(cls, result);
    return result;
  }

  /**
   * Fast path only serves the exact call shape the ORM uses internally:
   * no options, or the explicit default `{ excludeExtraneousValues: false }`.
   */
  private isDefaultOptions(options?: DeserializeOptions): boolean {
    if (!options) return true;
    for (const key of Object.keys(options)) {
      const value = (options as any)[key];
      if (value === undefined) continue;
      if (key === "excludeExtraneousValues" && value === false) continue;
      return false;
    }
    return true;
  }

  private getProtoDescriptors(cls: Function): Record<string, PropertyDescriptor> {
    let descriptors = this.protoDescriptorCache.get(cls);
    if (!descriptors) {
      descriptors = Object.getOwnPropertyDescriptors(cls.prototype);
      this.protoDescriptorCache.set(cls, descriptors);
    }
    return descriptors;
  }

  /**
   * Clones a row value the way plainToClass does for untyped properties:
   * primitives pass through, Date/Buffer are copied, arrays and plain objects
   * are deep-copied, and nested class instances re-enter deserialization so
   * their own class-transformer metadata (if any) still applies.
   */
  private cloneValue(value: any): any {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value) || value instanceof Set) {
      const out: any[] = [];
      for (const item of value) out.push(this.cloneValue(item));
      return out;
    }
    if (value instanceof Date) return new Date(value.valueOf());
    if (typeof Buffer !== "undefined" && value instanceof Buffer) {
      return Buffer.from(value);
    }
    if (typeof value.then === "function") return value;

    const ctor = value.constructor;
    if (ctor === Object || ctor === undefined || ctor === null) {
      const out: any = {};
      for (const key of Object.keys(value)) {
        if (key === "__proto__" || key === "constructor") continue;
        out[key] = this.cloneValue(value[key]);
      }
      return out;
    }
    if (value instanceof Map) return {};

    // Class instance (e.g. an already-hydrated related entity): clone through
    // its own deserialization path so decorator metadata is respected.
    if (this.canFastPath(ctor)) return this.hydrateOne(ctor, value);
    return this.getPlainToClass()(ctor, value, {
      excludeExtraneousValues: false,
    });
  }

  private hydrateOne(cls: Function, row: any): any {
    const instance = new (cls as any)();
    const protoDescriptors = this.getProtoDescriptors(cls);
    for (const key of Object.keys(row)) {
      if (key === "__proto__" || key === "constructor") continue;
      // Same guard as plainToClass: never overwrite prototype getters
      // (no setter) or methods, and skip keys whose current value is a
      // function (e.g. arrow-function instance fields).
      const descriptor = protoDescriptors[key];
      if (
        (descriptor && !descriptor.set) ||
        typeof instance[key] === "function"
      ) {
        continue;
      }
      instance[key] = this.cloneValue(row[key]);
    }
    return instance;
  }

  private fastDeserialize<T>(cls: MyClassConstructor<T>, plain: any): any {
    if (plain === null || typeof plain !== "object") return plain;
    if (Array.isArray(plain)) {
      const out = new Array(plain.length);
      for (let i = 0; i < plain.length; i++) {
        const item = plain[i];
        out[i] =
          item === null || typeof item !== "object"
            ? item
            : item instanceof Date
              ? new Date(item.valueOf())
              : this.hydrateOne(cls as any, item);
      }
      return out;
    }
    return this.hydrateOne(cls as any, plain);
  }

  deserialize<T, V extends object>(
    cls: MyClassConstructor<T>,
    plain: V | V[],
    options?: DeserializeOptions,
  ): T {
    if (
      this.fastPathEnabled &&
      typeof cls === "function" &&
      this.isDefaultOptions(options) &&
      !(plain instanceof Date) &&
      !(plain instanceof Set) &&
      !(plain instanceof Map) &&
      !(typeof Buffer !== "undefined" && plain instanceof Buffer) &&
      this.canFastPath(cls)
    ) {
      return this.fastDeserialize(cls, plain);
    }
    return this.getPlainToClass()(cls, plain, {
      excludeExtraneousValues: false,
      ...options,
    });
  }
}
