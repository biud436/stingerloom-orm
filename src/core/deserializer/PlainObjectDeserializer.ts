/* eslint-disable @typescript-eslint/no-explicit-any */
import { DeserializeOptions } from "./DeserializeOptions";
import { Deserializer } from "./Deserializer";
import { MyClassConstructor } from "../MyClassConstructor";

/**
 * Zero-dependency default deserializer implementation.
 *
 * Works without class-transformer by converting a plain object into a class
 * instance via Object.assign.
 */
export class PlainObjectDeserializer implements Deserializer {
  deserialize<T, V extends object>(
    cls: MyClassConstructor<T>,
    plain: V | V[],
    _options?: DeserializeOptions,
  ): T {
    return Object.assign(new cls() as object, plain) as T;
  }
}
