/* eslint-disable @typescript-eslint/no-explicit-any */
import { DeserializeOptions } from "./DeserializeOptions";
import { Deserializer } from "./Deserializer";
import { DeserializerRegistry } from "./DeserializerRegistry";
import { MyClassConstructor } from "../MyClassConstructor";

/**
 * Global DeserializerRegistry singleton instance.
 *
 * To use the class-based API directly:
 * ```ts
 * import { DeserializerRegistry } from "./DeserializerRegistry";
 * const registry = DeserializerRegistry.getInstance();
 * ```
 */
const registry = DeserializerRegistry.getInstance();

/**
 * Deserialize a plain object into a class instance.
 *
 * Internally delegates to the DeserializerRegistry singleton's strategy.
 *
 * @deprecated Use DeserializerRegistry.getInstance().deserialize() instead.
 */
export function deserializeEntity<T, V extends object>(
  cls: MyClassConstructor<T>,
  plain: V | V[],
  options?: DeserializeOptions,
): T {
  return registry.deserialize(cls, plain, options);
}
