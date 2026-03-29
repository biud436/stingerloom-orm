/* eslint-disable @typescript-eslint/no-explicit-any */
import { DeserializeOptions } from "./DeserializeOptions";
import { Deserializer } from "./Deserializer";
import { MyClassConstructor } from "../MyClassConstructor";

/**
 * 의존성 없는 기본 역직렬화 구현체입니다.
 *
 * class-transformer 없이도 동작하며, Object.assign으로 plain 객체를
 * 클래스 인스턴스로 변환합니다.
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
