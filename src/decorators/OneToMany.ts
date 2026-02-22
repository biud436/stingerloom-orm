import "reflect-metadata";
import { ClazzType } from "../utils";
import Container from "typedi";
import { OneToManyScanner } from "../scanner";
import { CascadeType } from "../types/CascadeType";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const ONE_TO_MANY_TOKEN = Symbol.for("STG_ONE_TO_MANY");

export type OneToManyOption = {
  /**
   * 연관관계 소유자(ManyToOne 측)의 프로퍼티 이름입니다.
   */
  mappedBy: string;
  /**
   * Cascade 작업 유형 배열입니다.
   * 부모 엔티티 저장/삭제 시 자식 엔티티도 함께 처리합니다.
   */
  cascade?: CascadeType[];
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
   * Cascade 작업 유형
   */
  cascade?: CascadeType[];
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
  option: OneToManyOption,
): PropertyDecorator {
  return (target, propertyKey) => {
    const cls = target.constructor;

    const scanner = Container.get(OneToManyScanner);

    const metadata = <OneToManyMetadata<T>>{
      target: cls,
      propertyKey: propertyKey.toString(),
      getRelatedEntity,
      mappedBy: option.mappedBy,
      cascade: option.cascade,
    };

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
