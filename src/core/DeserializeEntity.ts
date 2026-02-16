/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClassTransformerDeserializer } from "./ClassTransformerDeserializer";
import { DeserializeOptions } from "./DeserializeOptions";
import { Deserializer } from "./Deserializer";
import { MyClassConstructor } from "./MyClassConstructor";

/**
 * 현재 활성화된 역직렬화 전략입니다.
 * 기본값은 class-transformer 기반이며, setDeserializer()로 교체할 수 있습니다.
 */
let currentDeserializer: Deserializer = new ClassTransformerDeserializer();

/**
 * 역직렬화 전략을 교체합니다.
 *
 * @example
 * ```ts
 * // typia 기반으로 교체
 * setDeserializer(new TypiaDeserializer());
 *
 * // 간단한 커스텀 구현
 * setDeserializer({
 *   deserialize(cls, plain) {
 *     return Object.assign(new cls(), plain);
 *   },
 * });
 * ```
 */
export function setDeserializer(deserializer: Deserializer): void {
  currentDeserializer = deserializer;
}

/**
 * 현재 활성화된 역직렬화 전략을 반환합니다.
 */
export function getDeserializer(): Deserializer {
  return currentDeserializer;
}

/**
 * plain 객체를 클래스 인스턴스로 역직렬화합니다.
 *
 * 내부적으로 현재 설정된 Deserializer 전략을 사용하며,
 * setDeserializer()로 전략을 교체할 수 있습니다.
 */
export function deserializeEntity<T, V extends object>(
  cls: MyClassConstructor<T>,
  plain: V | V[],
  options?: DeserializeOptions,
): T {
  return currentDeserializer.deserialize(cls, plain, options);
}
