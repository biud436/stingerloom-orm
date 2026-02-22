import "reflect-metadata";
import { ClazzType } from "../utils";
import Container from "typedi";
import { ManyToManyScanner } from "../scanner";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const MANY_TO_MANY_TOKEN = Symbol.for("STG_MANY_TO_MANY");

export type JoinTableOption = {
  /**
   * 중간 테이블(조인 테이블)의 이름입니다.
   */
  name: string;

  /**
   * 현재 엔티티의 PK를 참조하는 중간 테이블의 FK 컬럼입니다.
   */
  joinColumn: string;

  /**
   * 대상 엔티티의 PK를 참조하는 중간 테이블의 FK 컬럼입니다.
   */
  inverseJoinColumn: string;
};

export type ManyToManyOption = {
  /**
   * 중간 테이블 정보입니다.
   * 관계의 소유측(owning side)에서 설정해야 합니다.
   */
  joinTable?: JoinTableOption;

  /**
   * 역방향(inverse side)에서 소유측의 프로퍼티 이름을 가리킵니다.
   */
  mappedBy?: string;
};

export type ManyToManyMetadata<T> = {
  target: ClazzType<unknown>;
  propertyKey: string;

  /**
   * 대상 엔티티를 반환하는 함수입니다.
   */
  getRelatedEntity: () => ClazzType<T>;

  /**
   * 중간 테이블 정보 (소유측에서만 설정)
   */
  joinTable?: JoinTableOption;

  /**
   * 역방향 참조 시 소유측 프로퍼티 이름
   */
  mappedBy?: string;
};

/**
 * ManyToMany 관계를 설정합니다.
 * 중간 테이블을 통해 두 엔티티 간의 다대다 관계를 표현합니다.
 *
 * @example
 * // 소유측 (joinTable 설정)
 * @ManyToMany(() => Tag, {
 *   joinTable: {
 *     name: "post_tags",
 *     joinColumn: "post_id",
 *     inverseJoinColumn: "tag_id",
 *   },
 * })
 * tags: Tag[];
 *
 * @example
 * // 역방향 (mappedBy 설정)
 * @ManyToMany(() => Post, { mappedBy: "tags" })
 * posts: Post[];
 */
export function ManyToMany<T>(
  getRelatedEntity: () => ClazzType<T>,
  option?: ManyToManyOption,
): PropertyDecorator {
  return (target, propertyKey) => {
    const cls = target.constructor;

    const scanner = Container.get(ManyToManyScanner);

    const metadata = <ManyToManyMetadata<T>>{
      target: cls,
      propertyKey: propertyKey.toString(),
      getRelatedEntity,
      joinTable: option?.joinTable,
      mappedBy: option?.mappedBy,
    };

    const existing = Reflect.getMetadata(MANY_TO_MANY_TOKEN, cls);

    Reflect.defineMetadata(
      MANY_TO_MANY_TOKEN,
      [...(existing || []), metadata],
      cls,
    );

    const uniqueKey = scanner.createUniqueKey();
    scanner.set<ManyToManyMetadata<T>>(uniqueKey, metadata);
  };
}
