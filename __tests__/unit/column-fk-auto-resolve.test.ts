/**
 * Verifies @Column-based FK auto-detection.
 *
 * When @ManyToOne's joinColumn is not specified,
 * the FK column is auto-resolved from the actual DB column name of the
 * {propertyName}Id property declared via @Column on the same entity.
 *
 * Scenarios:
 * 1. @Column({ name: "custom_fk" }) ownerId → FK = "custom_fk"
 * 2. @Column() ownerId (name omitted) → FK = "ownerId"
 * 3. joinColumn specified → @Column ignored, joinColumn wins
 * 4. No @Column matching the {propertyName}Id pattern → joinColumn unset
 * 5. Same behavior applies to OneToOne relations
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

// --- Test entities ---

@Entity()
class Owner {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  name!: string;
}

// Scenario 1: @Column has a custom name
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

// Scenario 2: @Column omits name (propertyKey is used as the DB column name)
@Entity()
class PetWithDefaultFk {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "int" })
  ownerId!: number;

  @ManyToOne(() => Owner, (o) => o.name)
  owner!: Owner;
}

// Scenario 3: joinColumn is specified → @Column is ignored
@Entity()
class PetWithExplicitJoinColumn {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: "should_be_ignored", type: "int" })
  ownerId!: number;

  @ManyToOne(() => Owner, (o) => o.name, { joinColumn: "explicit_fk" })
  owner!: Owner;
}

// Scenario 4: No @Column matching the {propertyName}Id pattern
@Entity()
class PetWithoutFkColumn {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Owner, (o) => o.name)
  owner!: Owner;
}

// Scenario 5: Same behavior for OneToOne
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
    const relations = (em as any).resolver.resolveManyToOneMetadata(PetWithCustomFk);
    expect(relations).toHaveLength(1);
    expect(relations[0].joinColumn).toBe("custom_owner_fk");
  });

  it("@Column() ownerId (name 생략) → joinColumn이 'ownerId'로 해석된다", () => {
    const relations = (em as any).resolver.resolveManyToOneMetadata(PetWithDefaultFk);
    expect(relations).toHaveLength(1);
    expect(relations[0].joinColumn).toBe("ownerId");
  });

  it("joinColumn이 명시되면 @Column 무시 → 'explicit_fk' 유지", () => {
    const relations = (em as any).resolver.resolveManyToOneMetadata(
      PetWithExplicitJoinColumn,
    );
    expect(relations).toHaveLength(1);
    expect(relations[0].joinColumn).toBe("explicit_fk");
  });

  it("{propertyName}Id 패턴의 @Column이 없으면 joinColumn은 undefined", () => {
    const relations = (em as any).resolver.resolveManyToOneMetadata(PetWithoutFkColumn);
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
    const relations = (em as any).resolver.resolveOneToOneMetadata(Profile);
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
      .spyOn((em as any).resolver, "resolveEntityMetadata")
      .mockImplementation((entity: any) => {
        if (entity === PetWithCustomFk) return petMeta;
        if (entity === Owner) return ownerMeta;
        return null;
      });
    jest.spyOn((em as any).resolver, "resolveOneToOneMetadata").mockReturnValue([]);
    jest.spyOn((em as any).resolver, "resolveOneToManyMetadata").mockReturnValue([]);
    jest.spyOn((em as any).resolver, "resolveManyToManyMetadata").mockReturnValue([]);
    jest.spyOn((em as any).resolver, "getDeletedAtColumn").mockReturnValue(null);
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
