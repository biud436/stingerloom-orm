/**
 * @Column 기반 FK 자동 감지를 검증합니다.
 *
 * @ManyToOne의 joinColumn이 명시되지 않은 경우,
 * 같은 엔티티에 @Column으로 선언된 {propertyName}Id 프로퍼티의
 * 실제 DB 컬럼명을 FK 컬럼으로 자동 해석합니다.
 *
 * 시나리오:
 * 1. @Column({ name: "custom_fk" }) ownerId → FK = "custom_fk"
 * 2. @Column() ownerId (name 생략) → FK = "ownerId"
 * 3. joinColumn 명시 → @Column 무시, joinColumn 우선
 * 4. {propertyName}Id 패턴의 @Column 없음 → joinColumn 미설정
 * 5. OneToOne 관계에서도 동일 동작
 */
import "reflect-metadata";

jest.mock("../../src/DatabaseClient", () => {
  return {
    DatabaseClient: {
      getInstance: jest.fn().mockReturnValue({
        type: "mysql",
        getType: jest.fn().mockReturnValue("mysql"),
        getConnection: jest.fn(),
        getOptions: jest.fn().mockReturnValue({ synchronize: false }),
        connect: jest.fn(),
      }),
    },
  };
});

const mockQuery = jest.fn();
jest.mock("../../src/dialects/TransactionSessionManager", () => {
  return {
    TransactionSessionManager: jest.fn().mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      query: mockQuery,
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    })),
  };
});

import { EntityManager } from "../../src/core/EntityManager";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../src/decorators/ManyToOne";
import { OneToOne } from "../../src/decorators/OneToOne";
import { OneToMany } from "../../src/decorators/OneToMany";

// --- 테스트 엔티티 ---

@Entity()
class Owner {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  name!: string;
}

// 시나리오 1: @Column에 커스텀 name이 있는 경우
@Entity()
class PetWithCustomFk {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  name!: string;

  @Column({ name: "custom_owner_fk", type: "int" })
  ownerId!: number;

  @ManyToOne(() => Owner, (o) => o.name)
  owner!: Owner;
}

// 시나리오 2: @Column에 name 생략 (propertyKey가 그대로 DB 컬럼명)
@Entity()
class PetWithDefaultFk {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "int" })
  ownerId!: number;

  @ManyToOne(() => Owner, (o) => o.name)
  owner!: Owner;
}

// 시나리오 3: joinColumn이 명시된 경우 → @Column 무시
@Entity()
class PetWithExplicitJoinColumn {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: "should_be_ignored", type: "int" })
  ownerId!: number;

  @ManyToOne(() => Owner, (o) => o.name, { joinColumn: "explicit_fk" })
  owner!: Owner;
}

// 시나리오 4: {propertyName}Id 패턴의 @Column이 없는 경우
@Entity()
class PetWithoutFkColumn {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Owner, (o) => o.name)
  owner!: Owner;
}

// 시나리오 5: OneToOne에서도 동일
@Entity()
class Profile {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: "user_fk", type: "int" })
  userId!: number;

  @OneToOne(() => Owner)
  user!: Owner;
}

function createTestEntityManager() {
  const em = new EntityManager();
  (em as any).driver = {
    wrap: (name: string) => `\`${name}\``,
    supportsExplain: () => false,
  };
  (em as any).dbType = "mysql";
  return em;
}

describe("@Column 기반 FK 자동 감지 (ManyToOne)", () => {
  let em: EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    em = createTestEntityManager();
  });

  it("@Column({ name: 'custom_owner_fk' }) ownerId → joinColumn이 'custom_owner_fk'로 해석된다", () => {
    const relations = (em as any).resolveManyToOneMetadata(PetWithCustomFk);
    expect(relations).toHaveLength(1);
    expect(relations[0].joinColumn).toBe("custom_owner_fk");
  });

  it("@Column() ownerId (name 생략) → joinColumn이 'ownerId'로 해석된다", () => {
    const relations = (em as any).resolveManyToOneMetadata(PetWithDefaultFk);
    expect(relations).toHaveLength(1);
    expect(relations[0].joinColumn).toBe("ownerId");
  });

  it("joinColumn이 명시되면 @Column 무시 → 'explicit_fk' 유지", () => {
    const relations = (em as any).resolveManyToOneMetadata(
      PetWithExplicitJoinColumn,
    );
    expect(relations).toHaveLength(1);
    expect(relations[0].joinColumn).toBe("explicit_fk");
  });

  it("{propertyName}Id 패턴의 @Column이 없으면 joinColumn은 undefined", () => {
    const relations = (em as any).resolveManyToOneMetadata(PetWithoutFkColumn);
    expect(relations).toHaveLength(1);
    expect(relations[0].joinColumn).toBeUndefined();
  });
});

describe("@Column 기반 FK 자동 감지 (OneToOne)", () => {
  let em: EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    em = createTestEntityManager();
  });

  it("@Column({ name: 'user_fk' }) userId → joinColumn이 'user_fk'로 해석된다", () => {
    const relations = (em as any).resolveOneToOneMetadata(Profile);
    expect(relations).toHaveLength(1);
    expect(relations[0].joinColumn).toBe("user_fk");
  });
});

describe("@Column FK 자동 감지 + save() 통합", () => {
  let em: EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    em = createTestEntityManager();

    const ownerMeta = {
      name: "owner",
      target: Owner,
      columns: [
        { name: "id", propertyKey: "id", options: { primary: true, autoIncrement: true } },
        { name: "name", propertyKey: "name", options: {} },
      ],
    };
    const petMeta = {
      name: "pet_with_custom_fk",
      target: PetWithCustomFk,
      columns: [
        { name: "id", propertyKey: "id", options: { primary: true, autoIncrement: true } },
        { name: "custom_owner_fk", propertyKey: "ownerId", options: {} },
      ],
    };

    jest
      .spyOn(em as any, "resolveEntityMetadata")
      .mockImplementation((entity: any) => {
        if (entity === PetWithCustomFk) return petMeta;
        if (entity === Owner) return ownerMeta;
        return null;
      });
    jest.spyOn(em as any, "resolveOneToOneMetadata").mockReturnValue([]);
    jest.spyOn(em as any, "resolveOneToManyMetadata").mockReturnValue([]);
    jest.spyOn(em as any, "resolveManyToManyMetadata").mockReturnValue([]);
    jest.spyOn(em as any, "getDeletedAtColumn").mockReturnValue(null);
  });

  it("@Column({ name: 'custom_owner_fk' })가 INSERT에 반영된다", async () => {
    const owner = new Owner();
    owner.id = 5;

    const pet = new PetWithCustomFk();
    pet.name = "Kitty";
    pet.owner = owner;

    mockQuery.mockResolvedValue({ results: { insertId: 1 }, fields: [] });
    jest
      .spyOn(em, "findOne")
      .mockResolvedValue({ id: 1, name: "Kitty", owner } as any);

    await em.save(PetWithCustomFk, pet);

    const insertCall = mockQuery.mock.calls.find((call: any[]) => {
      const text = call[0].text ?? String(call[0]);
      return text.includes("INSERT");
    });

    expect(insertCall).toBeDefined();
    const insertSql = insertCall![0].text ?? String(insertCall![0]);
    expect(insertSql).toContain("`custom_owner_fk`");
    expect(insertCall![0].values).toContain(5);
  });
});
