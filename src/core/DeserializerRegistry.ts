/* eslint-disable @typescript-eslint/no-explicit-any */
import { ClassTransformerDeserializer } from "./ClassTransformerDeserializer";
import { DeserializeOptions } from "./DeserializeOptions";
import { Deserializer } from "./Deserializer";
import { MyClassConstructor } from "./MyClassConstructor";

/**
 * 역직렬화 전략을 관리하는 레지스트리 클래스입니다.
 *
 * 싱글톤 인스턴스를 통해 전역적으로 역직렬화 전략을 설정하고 사용할 수 있으며,
 * 필요 시 별도의 인스턴스를 생성하여 독립적인 전략을 운용할 수도 있습니다.
 *
 * @example
 * ```ts
 * // 전역 싱글톤 사용
 * const registry = DeserializerRegistry.getInstance();
 * registry.setDeserializer(new TypiaDeserializer());
 * const user = registry.deserialize(User, plainObject);
 *
 * // 독립 인스턴스 생성
 * const custom = new DeserializerRegistry(new CustomDeserializer());
 * const result = custom.deserialize(Post, plainPost);
 * ```
 */
export class DeserializerRegistry {
  private static instance: DeserializerRegistry;

  private deserializer: Deserializer;

  constructor(deserializer?: Deserializer) {
    this.deserializer = deserializer ?? new ClassTransformerDeserializer();
  }

  /**
   * 전역 싱글톤 인스턴스를 반환합니다.
   */
  static getInstance(): DeserializerRegistry {
    if (!DeserializerRegistry.instance) {
      DeserializerRegistry.instance = new DeserializerRegistry();
    }
    return DeserializerRegistry.instance;
  }

  /**
   * 역직렬화 전략을 교체합니다.
   *
   * @example
   * ```ts
   * registry.setDeserializer(new TypiaDeserializer());
   *
   * registry.setDeserializer({
   *   deserialize(cls, plain) {
   *     return Object.assign(new cls(), plain);
   *   },
   * });
   * ```
   */
  setDeserializer(deserializer: Deserializer): void {
    this.deserializer = deserializer;
  }

  /**
   * 현재 활성화된 역직렬화 전략을 반환합니다.
   */
  getDeserializer(): Deserializer {
    return this.deserializer;
  }

  /**
   * plain 객체를 클래스 인스턴스로 역직렬화합니다.
   *
   * @param cls 대상 클래스 생성자
   * @param plain 변환할 plain 객체 또는 배열
   * @param options 역직렬화 옵션
   */
  deserialize<T, V extends object>(
    cls: MyClassConstructor<T>,
    plain: V | V[],
    options?: DeserializeOptions,
  ): T {
    return this.deserializer.deserialize(cls, plain, options);
  }
}
