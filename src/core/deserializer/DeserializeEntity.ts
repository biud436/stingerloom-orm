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
 * @deprecated Removal target: 2.0. Use
 * `DeserializerRegistry.getInstance().deserialize()` instead. The function
 * remains the ORM's own hydration entry point, so only the public export is
 * scheduled to go.
 */
export function deserializeEntity<T, V extends object>(
  cls: MyClassConstructor<T>,
  plain: V | V[],
  options?: DeserializeOptions,
): T {
  return registry.deserialize(cls, plain, options);
}
