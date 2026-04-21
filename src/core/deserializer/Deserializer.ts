import { DeserializeOptions } from "./DeserializeOptions";
import { MyClassConstructor } from "../MyClassConstructor";

/**
 * Deserialization strategy interface.
 *
 * Abstracts over libraries such as class-transformer, typia, or superstruct
 * so they can be swapped in via a plugin-style API.
 *
 * @example
 * ```ts
 * // class-transformer-based (default)
 * const deserializer = new ClassTransformerDeserializer();
 *
 * // Custom implementation
 * const deserializer: Deserializer = {
 *   deserialize(cls, plain, options) {
 *     return Object.assign(new cls(), plain);
 *   },
 * };
 *
 * // Swap strategy via DeserializerRegistry
 * DeserializerRegistry.getInstance().setDeserializer(deserializer);
 * ```
 */
export interface Deserializer {
  /**
   * Convert a plain object into a class instance.
   *
   * @param cls target class constructor
   * @param plain plain object or array to convert
   * @param options deserialization options
   */
  deserialize<T, V extends object>(
    cls: MyClassConstructor<T>,
    plain: V | V[],
    options?: DeserializeOptions,
  ): T;
}
