import { DeserializeOptions } from "./DeserializeOptions";
import { MyClassConstructor } from "./MyClassConstructor";

/**
 * 역직렬화 전략 인터페이스입니다.
 *
 * class-transformer, typia, superstruct 등 다양한 라이브러리를
 * 플러그인 방식으로 교체할 수 있도록 추상화합니다.
 *
 * @example
 * ```ts
 * // class-transformer 기반 (기본값)
 * const deserializer = new ClassTransformerDeserializer();
 *
 * // 커스텀 구현
 * const deserializer: Deserializer = {
 *   deserialize(cls, plain, options) {
 *     return Object.assign(new cls(), plain);
 *   },
 * };
 *
 * setDeserializer(deserializer);
 * ```
 */
export interface Deserializer {
  /**
   * plain 객체를 클래스 인스턴스로 변환합니다.
   *
   * @param cls 대상 클래스 생성자
   * @param plain 변환할 plain 객체 또는 배열
   * @param options 역직렬화 옵션
   */
  deserialize<T, V extends object>(
    cls: MyClassConstructor<T>,
    plain: V | V[],
    options?: DeserializeOptions,
  ): T;
}
