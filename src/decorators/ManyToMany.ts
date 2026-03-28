import "reflect-metadata";
import { ClazzType } from "../utils";
import Container from "typedi";
import { ManyToManyScanner } from "../scanner";
import { CascadeOption } from "../types/CascadeType";

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

export type ManyToManyOption<T = any> = {
  /**
   * 중간 테이블 정보입니다.
   * 관계의 소유측(owning side)에서 설정해야 합니다.
   */
  joinTable?: JoinTableOption;

  /**
   * 역방향(inverse side)에서 소유측의 프로퍼티 이름을 가리킵니다.
   * 타입 추론을 통해 대상 엔티티의 프로퍼티 이름만 허용됩니다.
   */
  mappedBy?: Extract<keyof T, string> | (string & {});

  /**
   * 캐스케이드 옵션 (insert, update, delete 또는 true/false)
   */
  cascade?: CascadeOption;
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

  /**
   * 캐스케이드 옵션
   */
  cascade?: CascadeOption;
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
  option?: ManyToManyOption<T>,
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
      cascade: option?.cascade,
    };

    const existing: ManyToManyMetadata<T>[] = Reflect.getMetadata(MANY_TO_MANY_TOKEN, cls) || [];
    const filtered = existing.filter((c) => c.propertyKey !== metadata.propertyKey);

    Reflect.defineMetadata(
      MANY_TO_MANY_TOKEN,
      [...filtered, metadata],
      cls,
    );

    const uniqueKey = scanner.createUniqueKey();
    scanner.set<ManyToManyMetadata<T>>(uniqueKey, metadata);
  };
}
