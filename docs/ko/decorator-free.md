# 데코레이터 없이 사용하기

Stingerloom의 모든 기능은 **데코레이터 없이** 사용할 수 있습니다. 이 페이지는 그 전체 지도입니다. 각 데코레이터에 대해 데코레이터를 쓰지 않는 대안과 실행 가능한 예제를 함께 보여줍니다. 만약 데코레이터로*만* 도달할 수 있는 기능을 발견했다면, 그것은 버그이므로 이슈로 등록해 주세요.

## 왜 필요한가

TypeScript 데코레이터는 `emitDecoratorMetadata` 컴파일러 옵션에 의존합니다. 일부 툴체인(esbuild, SWC, TypeScript 5의 *표준* 데코레이터, Vite 기본 트랜스포머)은 이 메타데이터를 방출하지 않으므로, 데코레이터 기반 엔티티는 컬럼 타입을 조용히 잃어버립니다. 툴링 문제를 떠나, 많은 팀이 도메인 클래스를 프레임워크 어노테이션으로부터 자유롭게 유지하는 "순수 클래스(plain class)" 철학을 선호하기도 합니다.

Stingerloom은 데코레이터와 **완전히 동일한 메타데이터**를 등록하는 두 개의 API로 이 두 가지를 모두 해결합니다.

| 관심사 | 데코레이터 | 데코레이터 없는 대안 |
| --- | --- | --- |
| 엔티티 / 컬럼 / 관계 / 인덱스 / 훅 / 상속 정의 | `@Entity`, `@Column`, `@ManyToOne`, … | [`EntitySchema`](#entityschema-엔티티-정의) |
| 작업 단위를 트랜잭션으로 감싸기 | `@Transactional` | [`em.transaction()`](#transactional-없이-트랜잭션) |
| NestJS 의존성 주입 | `@InjectRepository`, `@InjectEntityManager` | [순수 프로바이더 / `em.getRepository()`](#데코레이터-없이-nestjs-주입) |

데코레이터 기반 엔티티와 `EntitySchema` 기반 엔티티는 동일한 메타데이터를 생성하므로, 한 프로젝트에서 **둘을 섞어 써도** ORM의 나머지 부분(EntityManager, SchemaGenerator, QueryBuilder, WriteBuffer)은 차이를 구분하지 못합니다.

## 전체 매핑 표

### 엔티티 정의 데코레이터 → `EntitySchema`

| 데코레이터 | 범위 | `EntitySchema` 대응 |
| --- | --- | --- |
| `@Entity({ name })` | class | `{ target, tableName }` |
| `@Column(opts)` | property | `columns: { x: opts }` |
| `@Column({ transformer })` | property | `columns: { x: { transformer } }` |
| `@PrimaryColumn()` | property | `columns: { x: { primary: true } }` |
| `@PrimaryGeneratedColumn()` | property | `columns: { x: { primary: true, autoIncrement: true } }` |
| `@PrimaryGeneratedColumn("uuid"\|"uuid-v7")` | property | `columns: { x: { primary: true, type: "uuid", generationStrategy } }` |
| `@ManyToOne()` | property | `relations: { x: { kind: "manyToOne" } }` |
| `@OneToMany()` | property | `relations: { x: { kind: "oneToMany" } }` |
| `@OneToOne()` | property | `relations: { x: { kind: "oneToOne" } }` |
| `@ManyToMany()` | property | `relations: { x: { kind: "manyToMany" } }` |
| `@RelationColumn(opts)` | property | `relations: { x: { relationColumn: opts } }` |
| `@Index()` | property | `columns: { x: { index: true } }` |
| `@Index([cols], opts)` | class | `indexes: [{ columns, name, options }]` |
| `@UniqueIndex([cols])` | class | `uniqueIndexes: [{ columns, name }]` |
| `@FullTextIndex([cols], opts)` | class | `fullTextIndexes: [{ columns, name, language }]` |
| `@JsonIndex(opts)` | property | `columns: { x: { jsonIndex: opts } }` |
| `@ComputedColumn(opts)` | property | `computedColumns: { x: opts }` |
| `@Version()` | property | `columns: { x: { version: true } }` |
| `@CreateTimestamp()` | property | `columns: { x: { createTimestamp: true } }` |
| `@UpdateTimestamp()` | property | `columns: { x: { updateTimestamp: true } }` |
| `@DeletedAt()` | property | `columns: { x: { deletedAt: true } }` |
| `@BeforeInsert()` … `@AfterDelete()` | method | `hooks: { beforeInsert: "메서드명" }` |
| `@NotNull()`, `@MinLength()`, … | property | `columns: { x: { validation: [...] } }` |
| `@Inheritance(strategy)` | class | `inheritance: { strategy }` |
| `@DiscriminatorColumn(opts)` | class | `discriminatorColumn: opts` |
| `@DiscriminatorValue(v)` | class | `discriminatorValue: v` |
| `@TenantColumn(opts)` | property | `columns: { x: { tenant: true, … } }` |
| `@NonTenantEntity()` | class | `nonTenant: true` |

### 동작 데코레이터 → 프로그래밍 API

| 데코레이터 | 범위 | 데코레이터 없는 대응 |
| --- | --- | --- |
| `@Transactional(opts)` | method | `em.transaction(cb, { isolationLevel, propagation, connectionName })` |
| `@InjectRepository(Entity)` | 생성자 파라미터 | `em.getRepository(Entity)` |
| `@InjectEntityManager()` | 생성자 파라미터 | `EntityManager` 프로바이더를 직접 주입 |

## EntitySchema: 엔티티 정의

기본 사항(컬럼, 관계, 유니크 인덱스, 훅, 검증, 상속)은 [엔티티 & 컬럼 → 데코레이터 없이 엔티티 정의하기](./entities.md#데코레이터-없이-엔티티-정의하기-entityschema)에서 다룹니다. 아래 섹션은 과거에 전용 데코레이터가 필요했던 기능들을 다룹니다.

### 계산 컬럼 (`@ComputedColumn`)

데이터베이스 레벨의 생성 컬럼은 `columns`가 **아니라** `computedColumns`에 정의합니다. 이들은 INSERT/UPDATE에서 제외되고 `GENERATED ALWAYS AS (...)`로 렌더링됩니다. 리터럴 문자열 형식과 다이얼렉트 이식 가능한 빌더 형식 모두 지원합니다.

```typescript
import { EntitySchema } from "@stingerloom/orm";

class User {
  id!: number;
  firstName!: string;
  lastName!: string;
  fullName!: string;       // 계산 컬럼
  cycleTimeHours!: number; // 계산 컬럼
}

new EntitySchema<User>({
  target: User,
  columns: {
    id:        { type: "int", primary: true, autoIncrement: true },
    firstName: { type: "varchar", name: "first_name" },
    lastName:  { type: "varchar", name: "last_name" },
  },
  computedColumns: {
    // 리터럴 SQL — 대상 다이얼렉트에서 유효해야 합니다.
    fullName: {
      expression: "first_name || ' ' || last_name",
      stored: true,
      type: "varchar",
    },
    // 다이얼렉트 이식 가능 빌더 — 모든 드라이버에서 올바른 DDL을 생성합니다.
    cycleTimeHours: {
      expression: (e) =>
        e.dateDiff(e.col("completed_at"), e.col("created_at"), "hour"),
      type: "int",
    },
  },
});
```

### 전문 검색 인덱스 (`@FullTextIndex`)

```typescript
new EntitySchema<Post>({
  target: Post,
  columns: {
    id:      { type: "int", primary: true, autoIncrement: true },
    title:   { type: "varchar" },
    content: { type: "text" },
  },
  fullTextIndexes: [
    { columns: ["title", "content"], name: "ft_post", language: "english" },
  ],
});
```

PostgreSQL은 GIN `to_tsvector` 인덱스를, MySQL은 `FULLTEXT` 인덱스를 생성하며, SQLite에서는 아무 동작도 하지 않습니다.

### JSON 경로 인덱스 (`@JsonIndex`)

인덱싱할 JSON/JSONB 컬럼과 함께 컬럼별로 선언합니다.

```typescript
new EntitySchema<User>({
  target: User,
  columns: {
    id: { type: "int", primary: true, autoIncrement: true },
    profile: {
      type: "jsonb",
      jsonIndex: { path: "tags", using: "gin", opclass: "jsonb_path_ops" },
    },
  },
});
```

`path`는 데코레이터와 정확히 동일하게 세그먼트로 파싱됩니다(`"contact.email"` → `["contact", "email"]`). 전체 옵션은 [JSON 경로 인덱스](./entities.md#json-경로-인덱스-jsonindex)를 참고하세요.

### 외래 키 컬럼 (`@RelationColumn`)

`manyToOne` / `oneToOne` 관계에 명시적 FK 컬럼 메타데이터(이름, 타입, NULL 허용, 참조 컬럼)를 붙입니다.

```typescript
new EntitySchema<Post>({
  target: Post,
  columns: { id: { type: "int", primary: true, autoIncrement: true } },
  relations: {
    author: {
      kind: "manyToOne",
      target: () => User,
      relationColumn: {
        name: "author_id",
        type: "bigint",
        nullable: false,
        referencedColumn: "id",
      },
    },
  },
});
```

### 양방향 트랜스포머 (`@Column({ transformer })`)

```typescript
new EntitySchema<User>({
  target: User,
  columns: {
    id: { type: "int", primary: true, autoIncrement: true },
    email: {
      type: "varchar",
      transformer: {
        to:   (value: string) => value.toLowerCase(), // 엔티티 → DB (쓰기)
        from: (raw: string) => raw.trim(),            // DB → 엔티티 (읽기)
      },
    },
  },
});
```

### UUID 기본 키 (`@PrimaryGeneratedColumn("uuid-v7")`)

```typescript
new EntitySchema<Token>({
  target: Token,
  columns: {
    id: { type: "uuid", primary: true, generationStrategy: "uuid-v7" },
  },
});
```

`generationStrategy`는 `"increment"`(기본), `"uuid"`(UUIDv4), `"uuid-v7"`(시간 정렬 가능)을 받습니다.

### 고급 복합 인덱스 (`@Index([cols], options)`)

`options` 객체를 전달해 부분 / 표현식 / `USING` / `INCLUDE` 설정을 담습니다.

```typescript
new EntitySchema<Order>({
  target: Order,
  columns: {
    id:     { type: "int", primary: true, autoIncrement: true },
    email:  { type: "varchar" },
    active: { type: "boolean" },
  },
  indexes: [
    {
      columns: ["email"],
      options: {
        name: "idx_active_email",
        where: "active = true",   // 부분 인덱스 (PostgreSQL/SQLite)
        using: "btree",
        include: ["id"],          // 커버링 인덱스 (PostgreSQL)
      },
    },
  ],
});
```

### 테넌트 컬럼 (`@TenantColumn` / `@NonTenantEntity`)

전역 `tenantStrategy`가 `"tenant_column"`일 때, 구분 컬럼을 `tenant: true`로 표시하면 엔티티 인스턴스에서 값을 읽을 수 있고, 전역 테이블은 `nonTenant: true`로 제외할 수 있습니다.

```typescript
// 테넌트별 엔티티 — 테넌트 컬럼을 log.tenantId로 읽을 수 있음
new EntitySchema<AuditLog>({
  target: AuditLog,
  columns: {
    id:       { type: "int", primary: true, autoIncrement: true },
    action:   { type: "varchar" },
    tenantId: { type: "varchar", name: "tenant_id", length: 64, tenant: true },
  },
});

// 본질적으로 전역인 엔티티 — 테넌트 컬럼/WHERE 주입 없음
new EntitySchema<Tenant>({
  target: Tenant,
  nonTenant: true,
  columns: {
    id:   { type: "varchar", primary: true },
    name: { type: "varchar" },
  },
});
```

전체 전략은 [멀티테넌시](./multi-tenancy.md)를 참고하세요.

## `@Transactional` 없이 트랜잭션

`em.transaction(callback, options)`는 `@Transactional`의 데코레이터 없는 대응물입니다. 데코레이터가 받는 `isolationLevel`, `propagation`, `connectionName` 옵션을 **동일하게** 받으며, 데코레이터가 제공하지 않는 데드락 재시도까지 추가로 지원합니다.

```typescript
import { EntityManager, TransactionPropagation } from "@stingerloom/orm";

// @Transactional("SERIALIZABLE")
await em.transaction(async (txEm) => {
  /* ... */
}, { isolationLevel: "SERIALIZABLE" });

// @Transactional({ propagation: TransactionPropagation.REQUIRES_NEW })
await em.transaction(async (txEm) => {
  /* 항상 새롭고 독립적인 트랜잭션 */
}, { propagation: TransactionPropagation.REQUIRES_NEW });

// @Transactional({ propagation: TransactionPropagation.NESTED })
await em.transaction(async (txEm) => {
  /* 활성 트랜잭션 내부의 SAVEPOINT에서 실행 */
}, { propagation: TransactionPropagation.NESTED });

// @Transactional({ connectionName: "reporting" })
await em.transaction(async (txEm) => {
  /* ... */
}, { connectionName: "reporting" });

// 데드락 재시도 — 콜백 API에서만 사용 가능
await em.transaction(async (txEm) => {
  /* ... */
}, { retryOnDeadlock: true, maxRetries: 3 });
```

`TransactionOptions` 레퍼런스:

| 옵션 | 타입 | 기본값 | 대응 데코레이터 형식 |
| --- | --- | --- | --- |
| `isolationLevel` | `"READ UNCOMMITTED" \| "READ COMMITTED" \| "REPEATABLE READ" \| "SERIALIZABLE"` | 드라이버 기본값 | `@Transactional("SERIALIZABLE")` |
| `propagation` | `TransactionPropagation` | `REQUIRED` | `@Transactional({ propagation })` |
| `connectionName` | `string` | 기본 연결 | `@Transactional({ connectionName })` |
| `retryOnDeadlock` | `boolean` | `false` | — (콜백 전용) |
| `maxRetries` | `number` | `3` | — (콜백 전용) |
| `retryDelayMs` | `number` | `100` | — (콜백 전용) |

격리 수준, 전파, 세이브포인트에 대한 개념 가이드는 [트랜잭션](./transactions.md)을 참고하세요.

## 데코레이터 없이 NestJS 주입

`@InjectRepository`와 `@InjectEntityManager`는 엔티티 메타데이터가 아니라 NestJS DI 편의 기능입니다. 생성자 파라미터에 어노테이션을 붙이고 싶지 않다면, `EntityManager` 프로바이더를 주입받아 거기서 리포지토리를 얻으면 됩니다.

```typescript
import { Injectable } from "@nestjs/common";
import { EntityManager } from "@stingerloom/orm";

@Injectable()
export class UserService {
  // EntityManager는 일반 Nest 프로바이더이므로 위치 기반으로 주입합니다.
  constructor(private readonly em: EntityManager) {}

  private get users() {
    return this.em.getRepository(User);
  }

  findAll() {
    return this.users.find();
  }
}
```

`em.getRepository(Entity)`는 `@InjectRepository(Entity)`가 주입했을 것과 동일한 `BaseRepository` 인스턴스를 반환합니다.

## 정말 데코레이터가 없는지 검증하기

`emitDecoratorMetadata`를 완전히 제거하는 것이 목표라면, **모든** 엔티티를 `EntitySchema`로 정의하고 실제 툴체인(esbuild/SWC)으로 통과시켜 보세요. `EntitySchema`는 `design:type` 메타데이터를 스스로 설정하므로 컴파일러가 방출하는 메타데이터가 필요 없습니다. 빠른 스모크 테스트:

```typescript
await em.register({ entities: [User, AuditLog, /* ... */], synchronize: "dry-run" });
```

`synchronize: "dry-run"`은 데이터베이스를 건드리지 않고 실행할 DDL을 로그로 출력하므로, 모든 컬럼·인덱스·관계가 올바르게 해석되었는지 빠르게 확인할 수 있습니다.
