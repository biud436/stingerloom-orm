/* eslint-disable @typescript-eslint/no-explicit-any */
import { DeserializeOptions } from "./DeserializeOptions";
import { Deserializer } from "./Deserializer";
import { MyClassConstructor } from "../MyClassConstructor";

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

  constructor(deserializer?: Deserializer) {
    this.deserializer = deserializer ?? DeserializerRegistry.createDefaultDeserializer();
  }

  /**
   * Returns ClassTransformerDeserializer when class-transformer is installed,
   * and PlainObjectDeserializer otherwise.
   */
  private static createDefaultDeserializer(): Deserializer {
    try {
      require.resolve("class-transformer");
      const { ClassTransformerDeserializer } = require("./ClassTransformerDeserializer");
      return new ClassTransformerDeserializer();
    } catch {
      const { PlainObjectDeserializer } = require("./PlainObjectDeserializer");
      return new PlainObjectDeserializer();
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
