/* eslint-disable @typescript-eslint/no-explicit-any */
import { plainToClass } from "class-transformer";
import { DeserializeOptions } from "./DeserializeOptions";
import { Deserializer } from "./Deserializer";
import { MyClassConstructor } from "./MyClassConstructor";

/**
 * class-transformer 기반 역직렬화 구현체입니다.
 *
 * 기본 전략으로 사용되며, 필요 시 다른 Deserializer 구현체로 교체할 수 있습니다.
 */
export class ClassTransformerDeserializer implements Deserializer {
  deserialize<T, V extends object>(
    cls: MyClassConstructor<T>,
    plain: V | V[],
    options?: DeserializeOptions,
  ): T {
    return plainToClass(cls, plain, {
      excludeExtraneousValues: false,
      ...options,
    });
  }
}
