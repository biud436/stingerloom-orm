/* eslint-disable @typescript-eslint/no-explicit-any */
import { DeserializeOptions } from "./DeserializeOptions";
import { Deserializer } from "./Deserializer";
import { MyClassConstructor } from "../MyClassConstructor";
import { ClassTransformerDeserializer } from "./ClassTransformerDeserializer";
import { PlainObjectDeserializer } from "./PlainObjectDeserializer";

/**
 * Registry that manages the deserialization strategy.
 *
 * A singleton instance exposes the strategy globally, and additional independent
 * instances can be created when a separate strategy is needed.
 *
 * @example
 * ```ts
 * // Use the global singleton
 * const registry = DeserializerRegistry.getInstance();
 * registry.setDeserializer(new TypiaDeserializer());
 * const user = registry.deserialize(User, plainObject);
 *
 * // Create an independent instance
 * const custom = new DeserializerRegistry(new CustomDeserializer());
 * const result = custom.deserialize(Post, plainPost);
 * ```
 */
export class DeserializerRegistry {
  private static instance: DeserializerRegistry;

  private deserializer: Deserializer;

  /** True once a deserializer was chosen explicitly (constructor arg or setDeserializer). */
  private explicitlySet = false;

  constructor(deserializer?: Deserializer) {
    if (deserializer) {
      this.deserializer = deserializer;
      this.explicitlySet = true;
    } else {
      this.deserializer = DeserializerRegistry.createDefaultDeserializer();
    }
  }

  /**
   * Returns ClassTransformerDeserializer when class-transformer is installed,
   * and PlainObjectDeserializer otherwise.
   *
   * The synchronous probe needs require(), which only exists in the CJS
   * build. The ESM build starts on PlainObjectDeserializer;
   * `ensureDefaultDetected()` (awaited during `EntityManager.register()`)
   * upgrades it asynchronously when class-transformer is installed.
   */
  private static createDefaultDeserializer(): Deserializer {
    try {
      require.resolve("class-transformer");
      return new ClassTransformerDeserializer();
    } catch {
      return new PlainObjectDeserializer();
    }
  }

  /**
   * Async counterpart of the constructor's class-transformer auto-detection
   * for runtimes without require() (the ESM build). No-op when the CJS
   * detection already ran, or when a deserializer was set explicitly.
   */
  static async ensureDefaultDetected(): Promise<void> {
    if (typeof require === "function") return;

    const registry = DeserializerRegistry.getInstance();
    if (registry.explicitlySet) return;
    if (registry.deserializer instanceof ClassTransformerDeserializer) return;

    try {
      const ct = new ClassTransformerDeserializer();
      await ct.warmup();
      registry.deserializer = ct;
    } catch {
      // class-transformer is not installed — keep PlainObjectDeserializer
    }
  }

  /**
   * Returns the global singleton instance.
   */
  static getInstance(): DeserializerRegistry {
    if (!DeserializerRegistry.instance) {
      DeserializerRegistry.instance = new DeserializerRegistry();
    }
    return DeserializerRegistry.instance;
  }

  /**
   * Swap the deserialization strategy.
   *
   * @example
   * ```ts
   * registry.setDeserializer(new TypiaDeserializer());
   *
   * registry.setDeserializer({
   *   deserialize(cls, plain) {
   *     return Object.assign(new cls(), plain);
   *   },
   * });
   * ```
   */
  setDeserializer(deserializer: Deserializer): void {
    this.deserializer = deserializer;
    this.explicitlySet = true;
  }

  /**
   * Return the currently active deserialization strategy.
   */
  getDeserializer(): Deserializer {
    return this.deserializer;
  }

  /**
   * Deserialize a plain object into a class instance.
   *
   * @param cls target class constructor
   * @param plain plain object or array to convert
   * @param options deserialization options
   */
  deserialize<T, V extends object>(
    cls: MyClassConstructor<T>,
    plain: V | V[],
    options?: DeserializeOptions,
  ): T {
    return this.deserializer.deserialize(cls, plain, options);
  }
}
