import { ClazzType } from "../utils";
import { getScannerInstance } from "../scanner/ScannerContainer";
import { OneToManyScanner } from "../scanner";
import { CascadeOption, normalizeCascade } from "../types/CascadeType";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const ONE_TO_MANY_TOKEN = Symbol.for("STG_ONE_TO_MANY");

export type OneToManyOption<T = any> = {
  /**
   * 연관관계 소유자(ManyToOne 측)의 프로퍼티 이름입니다.
   * 타입 추론을 통해 대상 엔티티의 프로퍼티 이름만 허용됩니다.
   */
  mappedBy: Extract<keyof T, string> | (string & {});
  /**
   * Cascade 작업 유형입니다.
   * true이면 모든 cascade(insert, update, delete) 적용.
   * 배열이면 선택적 적용. 예: ["insert", "delete"]
   */
  cascade?: CascadeOption;
};

export type OneToManyMetadata<T> = {
  target: ClazzType<unknown>;
  propertyKey: string;

  /**
   * 연관 엔티티를 반환하는 함수입니다.
   */
  getRelatedEntity: () => ClazzType<T>;

  /**
   * mappedBy: ManyToOne 측 프로퍼티 이름
   */
  mappedBy: string;

  /**
   * 정규화된 Cascade 작업 유형 배열
   */
  cascade?: CascadeOption;
};

/**
 * OneToMany 관계를 설정합니다.
 * 연관관계에서 역방향(비소유) 엔티티에 설정해야 합니다.
 *
 * @example
 *
 * @OneToMany(() => Post, { mappedBy: "user" })
 * posts: Post[];
 */
export function OneToMany<T>(
  getRelatedEntity: () => ClazzType<T>,
  option: OneToManyOption<T>,
): PropertyDecorator {
  return (target, propertyKey) => {
    const cls = target.constructor;

    const scanner = getScannerInstance(OneToManyScanner);

    const metadata = {
      target: cls as ClazzType<unknown>,
      propertyKey: propertyKey.toString(),
      getRelatedEntity,
      mappedBy: option.mappedBy as string,
      cascade: option.cascade,
    } as OneToManyMetadata<T>;

    const columns = Reflect.getMetadata(ONE_TO_MANY_TOKEN, cls);

    Reflect.defineMetadata(
      ONE_TO_MANY_TOKEN,
      [...(columns || []), metadata],
      cls,
    );

    const uniqueKey = scanner.createUniqueKey();
    scanner.set<OneToManyMetadata<T>>(uniqueKey, metadata);
  };
}
