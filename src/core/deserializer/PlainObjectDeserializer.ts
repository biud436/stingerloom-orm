/* eslint-disable @typescript-eslint/no-explicit-any */
import { DeserializeOptions } from "./DeserializeOptions";
import { Deserializer } from "./Deserializer";
import { MyClassConstructor } from "../MyClassConstructor";

/**
 * Zero-dependency default deserializer implementation.
 *
 * Works without class-transformer by converting a plain object into a class
 * instance via Object.assign. Array inputs map to an array of instances,
 * matching the batch contract every Deserializer must honor (callers such as
 * ResultTransformer.toEntities() pass whole row arrays in one call).
 */
export class PlainObjectDeserializer implements Deserializer {
  deserialize<T, V extends object>(
    cls: MyClassConstructor<T>,
    plain: V | V[],
    _options?: DeserializeOptions,
  ): T {
    if (Array.isArray(plain)) {
      return plain.map((item) =>
        Object.assign(new cls() as object, item),
      ) as unknown as T;
    }
    return Object.assign(new cls() as object, plain) as unknown as T;
  }
}
