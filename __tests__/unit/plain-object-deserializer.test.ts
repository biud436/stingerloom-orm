/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { PlainObjectDeserializer } from "../../src/core/deserializer/PlainObjectDeserializer";
import { DeserializerRegistry } from "../../src/core/deserializer/DeserializerRegistry";
import { Deserializer } from "../../src/core/deserializer/Deserializer";
import { Column, Entity } from "../../src/decorators";
import { ResultTransformerFactory } from "../../src/core/ResultTransformerFactory";

class TestUser {
  id!: number;
  name!: string;
}

describe("PlainObjectDeserializer", () => {
  let deserializer: PlainObjectDeserializer;

  beforeEach(() => {
    deserializer = new PlainObjectDeserializer();
  });

  it("단일 plain 객체를 클래스 인스턴스로 변환해야 함", () => {
    const result = deserializer.deserialize(TestUser, { id: 1, name: "a" });

    expect(result).toBeInstanceOf(TestUser);
    expect(result.id).toBe(1);
    expect(result.name).toBe("a");
  });

  it("배열 입력 시 인스턴스 배열을 반환해야 함 (issue #424)", () => {
    const rows = [
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ];

    const result = deserializer.deserialize(TestUser, rows) as any;

    // 회귀 지점: Object.assign(new cls(), [row1, row2])가
    // { 0: row1, 1: row2 } 숫자 키 객체를 만들던 버그
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0]).toBeInstanceOf(TestUser);
    expect(result[1]).toBeInstanceOf(TestUser);
    expect(result[0].name).toBe("a");
    expect(result[1].name).toBe("b");
    expect((result as any)["0"].id).toBe(1);
  });

  it("빈 배열 입력 시 빈 배열을 반환해야 함", () => {
    const result = deserializer.deserialize(TestUser, []) as any;

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });

  it("ClassTransformerDeserializer와 동일한 배치 계약을 지켜야 함", () => {
    // toEntities()는 rows 배열 전체를 한 번에 넘긴다 — 어떤 Deserializer
    // 구현이든 배열 입력 → 배열 출력이어야 read path가 T[]를 반환한다.
    const rows = [{ id: 1, name: "x" }];
    const result = deserializer.deserialize(TestUser, rows) as any;

    expect(JSON.stringify(result)).toBe('[{"id":1,"name":"x"}]');
  });
});

describe("read path with PlainObjectDeserializer (no class-transformer install, issue #424)", () => {
  @Entity()
  class Simple {
    @Column()
    id!: number;

    @Column()
    name!: string;
  }

  @Entity()
  class SnakeMapped {
    @Column({ name: "user_id" })
    userId!: number;

    @Column({ name: "full_name" })
    fullName!: string;
  }

  let originalDeserializer: Deserializer;

  beforeAll(() => {
    // class-transformer 미설치 환경 시뮬레이션: 전역 레지스트리를
    // PlainObjectDeserializer로 강제 교체
    const registry = DeserializerRegistry.getInstance();
    originalDeserializer = registry.getDeserializer();
    registry.setDeserializer(new PlainObjectDeserializer());
  });

  afterAll(() => {
    DeserializerRegistry.getInstance().setDeserializer(originalDeserializer);
  });

  it("toEntities fast path가 flat T[]를 반환해야 함", () => {
    const rt = ResultTransformerFactory.create();
    const rows = [
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ];

    const result = rt.toEntities(Simple, { results: rows, fields: [] } as any);

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0]).toBeInstanceOf(Simple);
    expect(result[1]).toBeInstanceOf(Simple);
    expect(JSON.stringify(result)).toBe(
      '[{"id":1,"name":"a"},{"id":2,"name":"b"}]',
    );
  });

  it("toEntities remap path (snake_case 컬럼)가 flat T[]를 반환해야 함", () => {
    const rt = ResultTransformerFactory.create();
    const rows = [
      { user_id: 10, full_name: "Alice" },
      { user_id: 20, full_name: "Bob" },
    ];

    const result = rt.toEntities(SnakeMapped, {
      results: rows,
      fields: [],
    } as any);

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0]).toBeInstanceOf(SnakeMapped);
    expect(result[0].userId).toBe(10);
    expect(result[0].fullName).toBe("Alice");
    expect(result[1].userId).toBe(20);
    expect(result[1].fullName).toBe("Bob");
  });

  it("toEntity (단일 행)는 기존과 동일하게 동작해야 함", () => {
    const rt = ResultTransformerFactory.create();

    const result = rt.toEntity(Simple, {
      results: [{ id: 1, name: "solo" }],
      fields: [],
    } as any);

    expect(result).toBeInstanceOf(Simple);
    expect(result?.id).toBe(1);
    expect(result?.name).toBe("solo");
  });
});
