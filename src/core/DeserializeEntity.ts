/* eslint-disable @typescript-eslint/no-explicit-any */
import { DeserializeOptions } from "./DeserializeOptions";
import { Deserializer } from "./Deserializer";
import { DeserializerRegistry } from "./DeserializerRegistry";
import { MyClassConstructor } from "./MyClassConstructor";

/**
 * 전역 DeserializerRegistry 싱글톤 인스턴스입니다.
 *
 * 클래스 기반 API를 직접 사용하려면:
 * ```ts
 * import { DeserializerRegistry } from "./DeserializerRegistry";
 * const registry = DeserializerRegistry.getInstance();
 * ```
 */
const registry = DeserializerRegistry.getInstance();

/**
 * 역직렬화 전략을 교체합니다.
 *
 * @deprecated DeserializerRegistry.getInstance().setDeserializer()를 사용하세요.
 */
export function setDeserializer(deserializer: Deserializer): void {
  registry.setDeserializer(deserializer);
}

/**
 * 현재 활성화된 역직렬화 전략을 반환합니다.
 *
 * @deprecated DeserializerRegistry.getInstance().getDeserializer()를 사용하세요.
 */
export function getDeserializer(): Deserializer {
  return registry.getDeserializer();
}

/**
 * plain 객체를 클래스 인스턴스로 역직렬화합니다.
 *
 * 내부적으로 DeserializerRegistry 싱글톤의 전략을 사용합니다.
 *
 * @deprecated DeserializerRegistry.getInstance().deserialize()를 사용하세요.
 */
export function deserializeEntity<T, V extends object>(
  cls: MyClassConstructor<T>,
  plain: V | V[],
  options?: DeserializeOptions,
): T {
  return registry.deserialize(cls, plain, options);
}
