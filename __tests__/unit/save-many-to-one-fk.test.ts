/**
 * save()에서 ManyToOne FK 컬럼이 INSERT/UPDATE SQL에 포함되는지 검증합니다.
 *
 * 3단계 시나리오:
 * - Junior: 관계 객체 할당 후 save() → FK가 SQL에 포함되는가?
 * - Middle: 관계 변경·해제(null)·미할당(undefined) 구분
 * - Senior: 관계 재할당, INSERT null FK, findOne 결과 수정 후 재저장
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
const mockConnect = jest.fn().mockResolvedValue(undefined);
const mockStartTransaction = jest.fn().mockResolvedValue(undefined);
const mockCommit = jest.fn().mockResolvedValue(undefined);
const mockRollback = jest.fn().mockResolvedValue(undefined);
const mockClose = jest.fn().mockResolvedValue(undefined);

jest.mock("../../src/dialects/TransactionSessionManager", () => {
  return {
    TransactionSessionManager: jest.fn().mockImplementation(() => ({
      connect: mockConnect,
      startTransaction: mockStartTransaction,
      query: mockQuery,
      commit: mockCommit,
      rollback: mockRollback,
      close: mockClose,
    })),
  };
});

import { EntityManager } from "../../src/core/EntityManager";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";

@Entity()
class TestOwner {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  name!: string;
}

@Entity()
class TestPet {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  name!: string;

  // In a real entity this would have @ManyToOne, but we mock the metadata
  owner!: TestOwner;
}

const ownerMetadata = {
  name: "test_owner",
  target: TestOwner,
  columns: [
    { name: "id", options: { primary: true, autoIncrement: true } },
    { name: "name", options: {} },
  ],
};

const petMetadata = {
  name: "test_pet",
  target: TestPet,
  columns: [
    { name: "id", options: { primary: true, autoIncrement: true } },
    { name: "name", options: {} },
  ],
};

const manyToOneRelations = [
  {
    target: TestPet,
    columnName: "owner",
    joinColumn: "owner_id",
    getMappingEntity: () => TestOwner,
    getMappingProperty: () => {},
    option: {},
  },
];

function createTestEntityManager() {
  const em = new EntityManager();
  (em as any).driver = {
    wrap: (name: string) => `\`${name}\``,
    supportsExplain: () => false,
  };
  (em as any).dbType = "mysql";
  return em;
}

function setupMocks(em: EntityManager) {
  jest.spyOn((em as any).resolver, "resolveEntityMetadata").mockImplementation(
    (entity: any) => {
      if (entity === TestPet) return petMetadata;
      if (entity === TestOwner) return ownerMetadata;
      return null;
    },
  );
  jest
    .spyOn((em as any).resolver, "resolveManyToOneMetadata")
    .mockImplementation((entity: any) => {
      if (entity === TestPet) return manyToOneRelations;
      return [];
    });
  jest.spyOn((em as any).resolver, "resolveOneToOneMetadata").mockReturnValue([]);
  jest.spyOn((em as any).resolver, "resolveOneToManyMetadata").mockReturnValue([]);
  jest.spyOn((em as any).resolver, "resolveManyToManyMetadata").mockReturnValue([]);
  jest.spyOn((em as any).resolver, "getDeletedAtColumn").mockReturnValue(null);
}

function getSqlText(call: any[]): string {
  const sqlObj = call[0];
  return sqlObj.text ?? sqlObj.sql ?? String(sqlObj);
}

describe("save() ManyToOne FK — Junior (기본 관계 할당)", () => {
  let em: EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    em = createTestEntityManager();
    setupMocks(em);
  });

  it("관계 객체를 할당하고 save()하면 UPDATE에 FK 컬럼이 포함되어야 한다", async () => {
    const owner = new TestOwner();
    owner.id = 7;
    owner.name = "TestOwner";

    const pet = new TestPet();
    pet.id = 1;
    pet.name = "Whiskers";
    pet.owner = owner;

    // save() on an entity with existing PK → UPDATE path
    mockQuery.mockResolvedValue({ results: [], fields: [] });

    await em.save(TestPet, pet);

    // Find the UPDATE query (not SET autocommit, not START TRANSACTION)
    const updateCall = mockQuery.mock.calls.find((call: any[]) => {
      const text = getSqlText(call);
      return text.includes("UPDATE");
    });

    expect(updateCall).toBeDefined();
    const updateSql = getSqlText(updateCall!);
    expect(updateSql).toContain("`owner_id`");
    // FK value should be parameterized (owner.id = 7)
    expect(updateCall![0].values).toContain(7);
  });

  it("관계 객체를 할당하고 save()하면 INSERT에 FK 컬럼이 포함되어야 한다", async () => {
    const owner = new TestOwner();
    owner.id = 3;
    owner.name = "InsertOwner";

    const pet = new TestPet();
    // No id → INSERT path (auto-increment)
    pet.name = "NewCat";
    pet.owner = owner;

    mockQuery.mockResolvedValue({
      results: { insertId: 99 },
      fields: [],
    });

    // findOne after INSERT
    jest
      .spyOn(em, "findOne")
      .mockResolvedValue({ id: 99, name: "NewCat", owner } as any);

    await em.save(TestPet, pet);

    // Find the INSERT query
    const insertCall = mockQuery.mock.calls.find((call: any[]) => {
      const text = getSqlText(call);
      return text.includes("INSERT");
    });

    expect(insertCall).toBeDefined();
    const insertSql = getSqlText(insertCall!);
    expect(insertSql).toContain("`owner_id`");
    expect(insertCall![0].values).toContain(3);
  });

  it("부모 없이 save()하면 FK 컬럼이 SQL에 빠져야 한다 (undefined)", async () => {
    const pet = new TestPet();
    pet.id = 2;
    pet.name = "Solo";
    // owner 미할당 (undefined)

    mockQuery.mockResolvedValue({ results: [], fields: [] });

    await em.save(TestPet, pet);

    const updateCall = mockQuery.mock.calls.find((call: any[]) => {
      const text = getSqlText(call);
      return text.includes("UPDATE");
    });

    expect(updateCall).toBeDefined();
    const updateSql = getSqlText(updateCall!);
    expect(updateSql).not.toContain("`owner_id`");
  });
});

describe("save() ManyToOne FK — Middle (관계 변경·해제)", () => {
  let em: EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    em = createTestEntityManager();
    setupMocks(em);
  });

  it("관계를 null로 설정하면 UPDATE에 FK = NULL이 포함되어야 한다", async () => {
    const pet = new TestPet();
    pet.id = 1;
    pet.name = "Whiskers";
    (pet as any).owner = null;

    mockQuery.mockResolvedValue({ results: [], fields: [] });

    await em.save(TestPet, pet);

    const updateCall = mockQuery.mock.calls.find((call: any[]) => {
      const text = getSqlText(call);
      return text.includes("UPDATE");
    });

    expect(updateCall).toBeDefined();
    const updateSql = getSqlText(updateCall!);
    expect(updateSql).toContain("`owner_id`");
    expect(updateCall![0].values).toContain(null);
  });

  it("관계를 다른 부모로 바꾸면 UPDATE에 새 FK 값이 포함되어야 한다", async () => {
    const newOwner = new TestOwner();
    newOwner.id = 42;
    newOwner.name = "NewOwner";

    const pet = new TestPet();
    pet.id = 1;
    pet.name = "Whiskers";
    pet.owner = newOwner;

    mockQuery.mockResolvedValue({ results: [], fields: [] });

    await em.save(TestPet, pet);

    const updateCall = mockQuery.mock.calls.find((call: any[]) => {
      const text = getSqlText(call);
      return text.includes("UPDATE");
    });

    expect(updateCall).toBeDefined();
    expect(updateCall![0].values).toContain(42);
    expect(updateCall![0].values).not.toContain(7); // 이전 owner가 아님
  });

  it("INSERT 시 관계가 null이면 FK 컬럼에 null이 포함되어야 한다", async () => {
    const pet = new TestPet();
    pet.name = "NullInsert";
    (pet as any).owner = null;

    mockQuery.mockResolvedValue({
      results: { insertId: 50 },
      fields: [],
    });
    jest
      .spyOn(em, "findOne")
      .mockResolvedValue({ id: 50, name: "NullInsert" } as any);

    await em.save(TestPet, pet);

    const insertCall = mockQuery.mock.calls.find((call: any[]) => {
      const text = getSqlText(call);
      return text.includes("INSERT");
    });

    expect(insertCall).toBeDefined();
    const insertSql = getSqlText(insertCall!);
    expect(insertSql).toContain("`owner_id`");
    expect(insertCall![0].values).toContain(null);
  });
});

describe("save() ManyToOne FK — Senior (엣지 케이스)", () => {
  let em: EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    em = createTestEntityManager();
    setupMocks(em);
  });

  it("관계 객체의 PK가 0이어도 FK에 0이 포함되어야 한다 (falsy 값)", async () => {
    const owner = new TestOwner();
    owner.id = 0; // falsy but valid
    owner.name = "ZeroId";

    const pet = new TestPet();
    pet.id = 1;
    pet.name = "FalsyTest";
    pet.owner = owner;

    mockQuery.mockResolvedValue({ results: [], fields: [] });

    await em.save(TestPet, pet);

    const updateCall = mockQuery.mock.calls.find((call: any[]) => {
      const text = getSqlText(call);
      return text.includes("UPDATE");
    });

    // id=0은 falsy지만 유효한 값이므로 포함되어야 한다
    // 현재 코드는 `fkValue !== undefined && fkValue !== null` 체크
    expect(updateCall).toBeDefined();
    expect(updateCall![0].values).toContain(0);
  });

  it("연속 save() 호출에서 각각 올바른 FK가 생성되어야 한다", async () => {
    const owner1 = new TestOwner();
    owner1.id = 10;
    owner1.name = "First";

    const owner2 = new TestOwner();
    owner2.id = 20;
    owner2.name = "Second";

    const pet = new TestPet();
    pet.id = 1;
    pet.name = "Bouncing";

    mockQuery.mockResolvedValue({ results: [], fields: [] });

    // 첫 번째 save: owner1
    pet.owner = owner1;
    await em.save(TestPet, pet);

    let updateCalls = mockQuery.mock.calls.filter((call: any[]) => {
      const text = getSqlText(call);
      return text.includes("UPDATE");
    });
    expect(updateCalls[updateCalls.length - 1]![0].values).toContain(10);

    // 두 번째 save: null
    (pet as any).owner = null;
    await em.save(TestPet, pet);

    updateCalls = mockQuery.mock.calls.filter((call: any[]) => {
      const text = getSqlText(call);
      return text.includes("UPDATE");
    });
    expect(updateCalls[updateCalls.length - 1]![0].values).toContain(null);

    // 세 번째 save: owner2
    pet.owner = owner2;
    await em.save(TestPet, pet);

    updateCalls = mockQuery.mock.calls.filter((call: any[]) => {
      const text = getSqlText(call);
      return text.includes("UPDATE");
    });
    expect(updateCalls[updateCalls.length - 1]![0].values).toContain(20);
  });

  it("관계 객체에 PK가 undefined면 FK 컬럼이 SQL에 빠져야 한다", async () => {
    const brokenOwner = new TestOwner();
    // id 미설정 (undefined)
    brokenOwner.name = "NoPK";

    const pet = new TestPet();
    pet.id = 1;
    pet.name = "BrokenRelation";
    pet.owner = brokenOwner;

    mockQuery.mockResolvedValue({ results: [], fields: [] });

    await em.save(TestPet, pet);

    const updateCall = mockQuery.mock.calls.find((call: any[]) => {
      const text = getSqlText(call);
      return text.includes("UPDATE");
    });

    expect(updateCall).toBeDefined();
    const updateSql = getSqlText(updateCall!);
    // PK가 undefined인 관계 객체는 FK에 포함하면 안 됨
    expect(updateSql).not.toContain("`owner_id`");
  });
});
