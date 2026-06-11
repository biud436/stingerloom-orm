/**
 * Issue #371: SelectQueryBuilder의 getMany/getOne 엔티티 결과에서
 * EntitySubscriber.afterLoad가 find/findOne과 동일하게 발화하는지 검증합니다.
 *
 * - getMany/getOne/getManyAndCount: 엔티티당 1회 발화
 * - getRawMany/getPartialMany: 발화하지 않음 (raw는 raw로 유지)
 * - *AndSelect 중첩 경로에서도 루트 엔티티에 발화
 */
import "reflect-metadata";
import { EntityManager } from "../../src/core/EntityManager";
import { SelectQueryBuilder } from "../../src/core/SelectQueryBuilder";
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
} from "../../src/decorators";
import type { EntitySubscriber } from "../../src/core/EntitySubscriber";

@Entity()
class AlUser371 {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  username!: string;
}

@Entity()
class AlPost371 {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "text" })
  content!: string;

  previewContent?: string;

  @ManyToOne(
    () => AlUser371,
    (e: any) => e.user,
  )
  user!: AlUser371 | null;
}

function createEm(rows: any[]) {
  const em = new EntityManager();
  (em as any).driver = {
    wrap: (name: string) => `\`${name}\``,
    supportsExplain: () => false,
  };
  (em as any).dbType = "mysql";
  jest.spyOn(em, "query").mockResolvedValue(rows as any);
  return em;
}

describe("SelectQueryBuilder afterLoad 발화 (#371)", () => {
  let afterLoadCalls: any[];
  let subscriber: EntitySubscriber<AlPost371>;

  beforeEach(() => {
    afterLoadCalls = [];
    subscriber = {
      listenTo: () => AlPost371,
      afterLoad: (entity: AlPost371) => {
        afterLoadCalls.push(entity);
        entity.previewContent = entity.content?.slice(0, 3);
      },
    };
  });

  it("getMany()는 엔티티당 한 번 afterLoad를 발화해야 한다", async () => {
    const em = createEm([
      { id: 1, content: "first post" },
      { id: 2, content: "second post" },
    ]);
    em.addSubscriber(subscriber);

    const qb = new SelectQueryBuilder<AlPost371>(AlPost371, "p", em);
    const result = await qb.getMany();

    expect(afterLoadCalls).toHaveLength(2);
    expect(result[0].previewContent).toBe("fir");
    expect(result[1].previewContent).toBe("sec");
  });

  it("getOne()도 afterLoad를 발화해야 한다", async () => {
    const em = createEm([{ id: 1, content: "only post" }]);
    em.addSubscriber(subscriber);

    const qb = new SelectQueryBuilder<AlPost371>(AlPost371, "p", em);
    const one = await qb.getOne();

    expect(afterLoadCalls).toHaveLength(1);
    expect(one!.previewContent).toBe("onl");
  });

  it("다른 엔티티의 subscriber는 발화하지 않아야 한다", async () => {
    const em = createEm([{ id: 1, content: "post" }]);
    em.addSubscriber(subscriber);

    const qb = new SelectQueryBuilder<AlUser371>(AlUser371, "u", em);
    await qb.getMany();

    expect(afterLoadCalls).toHaveLength(0);
  });

  it("getRawMany()는 afterLoad를 발화하지 않아야 한다", async () => {
    const em = createEm([{ id: 1, content: "post" }]);
    em.addSubscriber(subscriber);

    const qb = new SelectQueryBuilder<AlPost371>(AlPost371, "p", em);
    const raw = await qb.getRawMany();

    expect(raw).toHaveLength(1);
    expect(afterLoadCalls).toHaveLength(0);
  });

  it("getPartialMany()는 afterLoad를 발화하지 않아야 한다", async () => {
    const em = createEm([{ id: 1, content: "post" }]);
    em.addSubscriber(subscriber);

    const qb = new SelectQueryBuilder<AlPost371>(AlPost371, "p", em);
    await qb.getPartialMany();

    expect(afterLoadCalls).toHaveLength(0);
  });

  it("*AndSelect 중첩 경로에서도 루트 엔티티에 afterLoad가 발화해야 한다", async () => {
    const em = createEm([
      { p_id: 1, p_content: "joined post", u_id: 7, u_username: "alice" },
    ]);
    em.addSubscriber(subscriber);

    const qb = new SelectQueryBuilder<AlPost371>(AlPost371, "p", em);
    qb.leftJoinRelationAndSelect("user", "u");
    const result = await qb.getMany();

    expect(afterLoadCalls).toHaveLength(1);
    expect(result[0].previewContent).toBe("joi");
    expect(result[0].user).toBeInstanceOf(AlUser371);
  });

  it("빈 결과에서는 afterLoad가 발화하지 않아야 한다", async () => {
    const em = createEm([]);
    em.addSubscriber(subscriber);

    const qb = new SelectQueryBuilder<AlPost371>(AlPost371, "p", em);
    const result = await qb.getMany();

    expect(result).toEqual([]);
    expect(afterLoadCalls).toHaveLength(0);
  });
});
