/**
 * @RelationColumn 데코레이터 테스트.
 *
 * @ManyToOne/@OneToOne 프로퍼티에 FK 컬럼을 선언적으로 지정하는 데코레이터.
 *
 * 시나리오:
 * 1. @RelationColumn({ name: "author_id" }) → joinColumn이 "author_id"로 resolve
 * 2. @RelationColumn() → {propertyName}Id 자동 추론 + warn 로그
 * 3. @RelationColumn + @Column 동일 이름 병행 → DDL에 중복 컬럼 생성 안 함
 * 4. @RelationColumn + option.joinColumn → @RelationColumn 우선
 * 5. @RelationColumn({ type: "bigint" }) → SchemaGenerator에서 해당 타입으로 컬럼 생성
 * 6. @RelationColumn만 있고 @Column 없을 때 → 가상 컬럼으로 DDL 생성
 * 7. OneToOne 소유측에서 @RelationColumn 동작
 * 8. SchemaDiff에서 @RelationColumn 컬럼 인식
 * 9. 대상 PK 타입 추론
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

jest.mock("../../src/dialects/TransactionSessionManager", () => {
  return {
    TransactionSessionManager: jest.fn().mockImplementation(() => ({
      connect: jest.fn().mockResolvedValue(undefined),
      startTransaction: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(),
      commit: jest.fn().mockResolvedValue(undefined),
      rollback: jest.fn().mockResolvedValue(undefined),
      close: jest.fn().mockResolvedValue(undefined),
    })),
  };
});

import { EntityManager } from "../../src/core/EntityManager";
import { SchemaGenerator } from "../../src/core/generators/SchemaGenerator";
import { Entity } from "../../src/decorators/Entity";
import { Column } from "../../src/decorators/Column";
import { PrimaryGeneratedColumn } from "../../src/decorators/PrimaryGeneratedColumn";
import { ManyToOne } from "../../src/decorators/ManyToOne";
import { OneToOne } from "../../src/decorators/OneToOne";
import { OneToMany } from "../../src/decorators/OneToMany";
import { RelationColumn } from "../../src/decorators/RelationColumn";

// --- 테스트 엔티티 ---

@Entity()
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  name!: string;
}

@Entity()
class UserWithBigintPk {
  @Column({ type: "bigint", primary: true, autoIncrement: true })
  id!: number;
}

// 시나리오 1: @RelationColumn({ name: "author_id" }) 명시적 FK 컬럼명
@Entity()
class PostWithExplicitName {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  title!: string;

  @ManyToOne(() => User, (u: any) => u.posts)
  @RelationColumn({ name: "author_id" })
  author!: User;
}

// 시나리오 2: @RelationColumn() 이름 생략 → 자동 추론
@Entity()
class PostWithAutoInfer {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => User, (u: any) => u.posts)
  @RelationColumn()
  author!: User;
}

// 시나리오 3: @RelationColumn + @Column 동일 이름 병행
@Entity()
class PostWithBothColumnAndRelation {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "int", name: "author_id" })
  authorId!: number;

  @ManyToOne(() => User, (u: any) => u.posts)
  @RelationColumn({ name: "author_id" })
  author!: User;
}

// 시나리오 4: @RelationColumn + option.joinColumn → @RelationColumn 우선
@Entity()
class PostWithConflictingJoinColumn {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => User, (u: any) => u.posts, { joinColumn: "old_fk" })
  @RelationColumn({ name: "new_fk" })
  author!: User;
}

// 시나리오 5: @RelationColumn({ type: "bigint" }) 커스텀 타입
@Entity()
class PostWithCustomType {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => User, (u: any) => u.posts)
  @RelationColumn({ name: "author_id", type: "bigint" })
  author!: User;
}

// 시나리오 6: @RelationColumn만 있고 @Column 없을 때 (가상 컬럼)
// = PostWithExplicitName (시나리오 1과 동일)

// 시나리오 7: OneToOne 소유측
@Entity()
class ProfileWithRelationColumn {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar" })
  bio!: string;

  @OneToOne(() => User)
  @RelationColumn({ name: "user_id" })
  user!: User;
}

// 시나리오 8: OneToOne 자동 추론
@Entity()
class ProfileAutoInfer {
  @PrimaryGeneratedColumn()
  id!: number;

  @OneToOne(() => User)
  @RelationColumn()
  user!: User;
}

// 시나리오 9: 대상 PK 타입 추론 (bigint PK)
@Entity()
class PostWithBigintRef {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => UserWithBigintPk, (u: any) => u.posts)
  @RelationColumn({ name: "author_id" })
  author!: UserWithBigintPk;
}

// 시나리오 10: nullable 옵션 false
@Entity()
class PostRequiredFk {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => User, (u: any) => u.posts)
  @RelationColumn({ name: "author_id", nullable: false })
  author!: User;
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

// ─────────────────────────────────────────────────
// RelationMetadataResolver 테스트
// ─────────────────────────────────────────────────

describe("@RelationColumn — ManyToOne joinColumn 해석", () => {
  let em: EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    em = createTestEntityManager();
  });

  it("@RelationColumn({ name: 'author_id' }) → joinColumn이 'author_id'로 해석된다", () => {
    const relations = (em as any).resolver.resolveManyToOneMetadata(
      PostWithExplicitName,
    );
    expect(relations).toHaveLength(1);
    expect(relations[0].joinColumn).toBe("author_id");
  });

  it("@RelationColumn() → {propertyName}Id 자동 추론 + warn 로그", () => {
    const warnSpy = jest.spyOn((em as any).resolver.logger, "warn");
    const relations = (em as any).resolver.resolveManyToOneMetadata(
      PostWithAutoInfer,
    );
    expect(relations).toHaveLength(1);
    expect(relations[0].joinColumn).toBe("authorId");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("inferred 'authorId'"),
    );
  });

  it("@RelationColumn + @Column 동일 이름 병행 → @RelationColumn 우선", () => {
    const relations = (em as any).resolver.resolveManyToOneMetadata(
      PostWithBothColumnAndRelation,
    );
    expect(relations).toHaveLength(1);
    expect(relations[0].joinColumn).toBe("author_id");
  });

  it("@RelationColumn + option.joinColumn → @RelationColumn 우선", () => {
    const relations = (em as any).resolver.resolveManyToOneMetadata(
      PostWithConflictingJoinColumn,
    );
    expect(relations).toHaveLength(1);
    expect(relations[0].joinColumn).toBe("new_fk");
  });
});

describe("@RelationColumn — OneToOne joinColumn 해석", () => {
  let em: EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    em = createTestEntityManager();
  });

  it("@RelationColumn({ name: 'user_id' }) → OneToOne joinColumn 해석", () => {
    const relations = (em as any).resolver.resolveOneToOneMetadata(
      ProfileWithRelationColumn,
    );
    expect(relations).toHaveLength(1);
    expect(relations[0].joinColumn).toBe("user_id");
  });

  it("@RelationColumn() → OneToOne 자동 추론 + warn", () => {
    const warnSpy = jest.spyOn((em as any).resolver.logger, "warn");
    const relations = (em as any).resolver.resolveOneToOneMetadata(
      ProfileAutoInfer,
    );
    expect(relations).toHaveLength(1);
    expect(relations[0].joinColumn).toBe("userId");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("inferred 'userId'"),
    );
  });
});

// ─────────────────────────────────────────────────
// SchemaGenerator DDL 테스트
// ─────────────────────────────────────────────────

describe("@RelationColumn — SchemaGenerator DDL", () => {
  it("@RelationColumn만 있고 @Column 없을 때 → 가상 컬럼이 DDL에 포함", () => {
    const gen = new SchemaGenerator({ dialect: "mysql" });
    const ddl = gen.generateCreateTableDDL(PostWithExplicitName);
    expect(ddl).toContain("author_id");
  });

  it("@RelationColumn + @Column 동일 이름 → DDL에 중복 컬럼 없음", () => {
    const gen = new SchemaGenerator({ dialect: "mysql" });
    const ddl = gen.generateCreateTableDDL(PostWithBothColumnAndRelation);
    expect(ddl).toContain("author_id");
    // DDL 전체에서 `author_id` 등장 횟수 — 컬럼 정의 1회만 (중복 없음)
    const allMatches = ddl.match(/`author_id`/g) ?? [];
    expect(allMatches.length).toBe(1);
  });

  it("@RelationColumn({ type: 'bigint' }) → 가상 컬럼 타입이 BIGINT", () => {
    const gen = new SchemaGenerator({ dialect: "mysql" });
    const ddl = gen.generateCreateTableDDL(PostWithCustomType);
    expect(ddl).toMatch(/author_id.*BIGINT/i);
  });

  it("@RelationColumn({ nullable: false }) → NOT NULL 제약", () => {
    const gen = new SchemaGenerator({ dialect: "mysql" });
    const ddl = gen.generateCreateTableDDL(PostRequiredFk);
    expect(ddl).toMatch(/author_id.*NOT NULL/i);
  });

  it("@RelationColumn 기본값 → NULL 허용", () => {
    const gen = new SchemaGenerator({ dialect: "mysql" });
    const ddl = gen.generateCreateTableDDL(PostWithExplicitName);
    expect(ddl).toContain("author_id");
    // nullable: true 기본이므로 "author_id ... NULL" (NOT NULL이 아닌)
    expect(ddl).toMatch(/author_id.*\bNULL\b/i);
    // NOT NULL이 아닌 것을 확인 — DDL에서 author_id 뒤에 NOT NULL이 없어야 함
    expect(ddl).not.toMatch(/author_id[^,)]*NOT NULL/i);
  });

  it("대상 PK 타입 추론 — bigint PK 엔티티 참조 시 bigint FK 컬럼 생성", () => {
    const gen = new SchemaGenerator({ dialect: "mysql" });
    const ddl = gen.generateCreateTableDDL(PostWithBigintRef);
    expect(ddl).toMatch(/author_id.*BIGINT/i);
  });

  it("PostgreSQL dialect에서도 가상 컬럼 생성", () => {
    const gen = new SchemaGenerator({ dialect: "postgres" });
    const ddl = gen.generateCreateTableDDL(PostWithExplicitName);
    expect(ddl).toContain("author_id");
  });

  it("SQLite dialect에서도 가상 컬럼 생성", () => {
    const gen = new SchemaGenerator({ dialect: "sqlite" });
    const ddl = gen.generateCreateTableDDL(PostWithExplicitName);
    expect(ddl).toContain("author_id");
  });
});

// ─────────────────────────────────────────────────
// 메타데이터 저장/조회 테스트
// ─────────────────────────────────────────────────

describe("@RelationColumn — 메타데이터 저장", () => {
  it("RELATION_COLUMN_TOKEN으로 메타데이터가 저장된다", () => {
    const { RELATION_COLUMN_TOKEN } = require("../../src/decorators/RelationColumn");
    const metadata = Reflect.getMetadata(
      RELATION_COLUMN_TOKEN,
      PostWithExplicitName,
    );
    expect(metadata).toBeDefined();
    expect(metadata).toHaveLength(1);
    expect(metadata[0].propertyKey).toBe("author");
    expect(metadata[0].name).toBe("author_id");
  });

  it("name 생략 시 메타데이터에 name이 undefined", () => {
    const { RELATION_COLUMN_TOKEN } = require("../../src/decorators/RelationColumn");
    const metadata = Reflect.getMetadata(
      RELATION_COLUMN_TOKEN,
      PostWithAutoInfer,
    );
    expect(metadata).toBeDefined();
    expect(metadata[0].name).toBeUndefined();
  });

  it("referencedColumn 옵션이 메타데이터에 저장된다", () => {
    @Entity()
    class PostWithRef {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToOne(() => User, (u: any) => u.posts)
      @RelationColumn({ name: "author_uuid", referencedColumn: "uuid" })
      author!: User;
    }

    const { RELATION_COLUMN_TOKEN } = require("../../src/decorators/RelationColumn");
    const metadata = Reflect.getMetadata(RELATION_COLUMN_TOKEN, PostWithRef);
    expect(metadata[0].referencedColumn).toBe("uuid");
  });
});

// ─────────────────────────────────────────────────
// @RelationColumn의 referencedColumn → ManyToOne.references 전파 테스트
// ─────────────────────────────────────────────────

describe("@RelationColumn — referencedColumn 전파", () => {
  let em: EntityManager;

  beforeEach(() => {
    jest.clearAllMocks();
    em = createTestEntityManager();
  });

  it("@RelationColumn({ referencedColumn: 'uuid' }) → rel.references에 전파", () => {
    @Entity()
    class PostRefCol {
      @PrimaryGeneratedColumn()
      id!: number;

      @ManyToOne(() => User, (u: any) => u.posts)
      @RelationColumn({ name: "author_uuid", referencedColumn: "uuid" })
      author!: User;
    }

    const relations = (em as any).resolver.resolveManyToOneMetadata(PostRefCol);
    expect(relations[0].references).toBe("uuid");
  });
});
