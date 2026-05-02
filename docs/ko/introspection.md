# 데이터베이스 인트로스펙션

## 인트로스펙션이 필요한 이유

새 팀에 합류했다고 가정해 봅시다. 프로젝트에는 47개의 테이블, 수백 개의 컬럼, 그리고 모든 것을 연결하는 외래 키가 있는 PostgreSQL 데이터베이스가 있습니다. 이전 개발자는 ORM을 쓰지 않았습니다 -- 모든 SQL은 직접 작성된 상태죠. 이 프로젝트를 Stingerloom ORM으로 마이그레이션하는 것이 당신의 일입니다.

인트로스펙션이 없다면, pgAdmin을 열고 테이블 정의를 하나씩 살펴보면서 47개의 엔티티 파일을 직접 작성해야 합니다. 컬럼마다 타입, null 허용 여부, 길이를 확인합니다. 외래 키마다 관계를 파악해 `@ManyToOne` 데코레이터를 추가합니다. 몇 시간이 걸리고 거의 확실히 실수가 나옵니다.

인트로스펙션을 사용하면, 제너레이터를 데이터베이스에 가리키기만 해도 47개의 엔티티 파일이 자동으로 생성됩니다. 외래 키는 `@ManyToOne` 관계가 됩니다. 컬럼 타입은 적절한 ORM 타입으로 매핑됩니다. 결과를 검토하고, 필요한 부분만 손보면 끝입니다.

인트로스펙션은 스키마 동기화의 반대 동작입니다. `synchronize: true`가 엔티티를 읽어 테이블을 만든다면, 인트로스펙션은 테이블을 읽어 엔티티를 만듭니다.

---

## 동작 방식

인트로스펙션 시스템은 명확한 책임을 가진 세 개의 컴포넌트로 구성됩니다:

```
┌─────────────────────────┐
│  IntrospectionGenerator │   오케스트레이터 — 데이터베이스 쿼리 후
│                         │   다른 두 컴포넌트를 조율
└───────────┬─────────────┘
            │
     ┌──────┴──────┐
     │             │
     v             v
┌──────────┐  ┌──────────────────┐
│TypeMapper│  │EntityCodeBuilder │
│          │  │                  │
│ DB 타입  │  │ 컬럼/PK/FK를     │
│ → ORM    │  │ 받아 .ts 코드   │
│ ColumnType│  │ 생성              │
└──────────┘  └──────────────────┘
```

단계별 흐름은 다음과 같습니다:

**1단계: 테이블 발견.** 제너레이터는 데이터베이스 카탈로그를 쿼리해 사용자 테이블을 모두 찾습니다. PostgreSQL은 `pg_tables`를, MySQL은 `information_schema.TABLES`를 조회합니다.

**2단계: 컬럼 메타데이터 가져오기.** 각 테이블에 대해 `information_schema.columns`를 쿼리해 모든 컬럼의 이름, 데이터 타입, null 허용 여부, 길이를 가져옵니다.

**3단계: 기본 키 가져오기.** 각 테이블에 대해 데이터베이스 카탈로그를 쿼리해 어떤 컬럼이 기본 키를 구성하는지 식별합니다.

**4단계: 외래 키 가져오기.** 각 테이블에 대해 `information_schema.table_constraints`와 관련 테이블을 쿼리해 외래 키 관계를 발견합니다 -- 어떤 컬럼이 어떤 테이블을 참조하는지.

**5단계: 타입 매핑.** `IntrospectionTypeMapper`가 데이터베이스 네이티브 타입명(`CHARACTER VARYING`, `BIGINT` 등)을 ORM `ColumnType` 값(`"varchar"`, `"bigint"` 등)으로 변환합니다.

**6단계: 코드 생성.** `EntityCodeBuilder`가 모든 메타데이터를 받아 적절한 import, 데코레이터, 타입 어노테이션이 들어 있는 완전한 TypeScript 엔티티 파일을 생성합니다.

---

## 기존 데이터베이스에서 엔티티 생성하기

### 프로그램 방식 사용

```typescript
import { IntrospectionGenerator } from "@stingerloom/orm";

// 쿼리 함수가 필요합니다 — 보통 드라이버에서 가져옵니다
const generator = new IntrospectionGenerator(
  (q) => driver.query(q),  // 쿼리 함수
  "postgres",               // 다이얼렉트: "postgres" 또는 "mysql"
  {
    schema: "public",       // PostgreSQL 스키마 (기본값: "public")
  },
);

const entities = await generator.generate();

// 각 엔티티를 파일로 작성
import * as fs from "fs";

for (const entity of entities) {
  const path = `./src/entities/${entity.fileName}`;
  fs.writeFileSync(path, entity.code);
  console.log(`Generated: ${path} (${entity.className})`);
}
```

`users`와 `posts` 두 테이블이 있는 데이터베이스(여기서 `posts`는 `users`를 참조하는 외래 키를 갖는다고 가정)에서 무슨 일이 일어나는지 따라가 봅시다.

1. `generator.generate()`가 `discoverTables()`를 호출하면 `["posts", "users"]`를 반환합니다.
2. `posts`에 대해 `getColumns()`, `getPrimaryKeys()`, `getForeignKeys()`를 호출합니다.
3. `getColumns()`는 `id` (integer), `title` (varchar), `body` (text), `author_id` (integer) 같은 컬럼을 반환합니다.
4. `getPrimaryKeys()`는 `["id"]`를 반환합니다.
5. `getForeignKeys()`는 `[{ column_name: "author_id", referenced_table: "users", referenced_column: "id" }]`를 반환합니다.
6. `EntityCodeBuilder`가 이 모두를 받아 다음을 생성합니다:

```typescript
// 생성 파일: post.entity.ts
import { Column, Entity, ManyToOne, PrimaryGeneratedColumn } from "@stingerloom/orm";

@Entity()
export class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  title!: string;

  @Column({ type: "text", nullable: true })
  body!: string;

  @ManyToOne(() => User, { joinColumn: "author_id" })
  author!: User;
}
```

몇 가지 눈여겨볼 점:

- `author_id` 컬럼은 일반 `@Column`으로 출력되지 않습니다. 대신 외래 키가 감지되어 `joinColumn` 옵션이 원래 FK 컬럼을 가리키는 `@ManyToOne` 관계로 바뀝니다.
- 테이블명 `posts`(복수형)는 클래스명 `Post`(단수형, PascalCase)가 됩니다. 제너레이터는 일반적인 복수형을 처리합니다: `users`는 `User`, `categories`는 `Category`, `addresses`는 `Address`를 유지합니다.
- snake_case 컬럼명은 camelCase 속성명이 됩니다: `author_id`는 관계 속성 `author`가 됩니다.
- 파일명은 kebab-case를 사용합니다: `Post`는 `post.entity.ts`, `UserProfile`은 `user-profile.entity.ts`가 됩니다.

### GeneratedEntity 객체

생성된 각 엔티티는 객체로 반환됩니다:

| 속성 | 타입 | 설명 |
|------|------|------|
| `tableName` | `string` | 원래 데이터베이스 테이블명 (예: `"posts"`) |
| `className` | `string` | 생성된 PascalCase 클래스명 (예: `"Post"`) |
| `code` | `string` | 완전한 TypeScript 소스 코드 |
| `fileName` | `string` | 권장 파일명 (예: `"post.entity.ts"`) |

---

## 타입 매핑

`IntrospectionTypeMapper`는 데이터베이스 네이티브 타입을 ORM `ColumnType` 값으로 변환합니다. 다이얼렉트별 주요 매핑은 다음과 같습니다.

### PostgreSQL

| 데이터베이스 타입 | ORM ColumnType | TypeScript 타입 |
|------------------|----------------|-----------------|
| INTEGER, INT, SERIAL | `"int"` | `number` |
| BIGINT, BIGSERIAL | `"bigint"` | `number` |
| REAL, FLOAT4 | `"float"` | `number` |
| DOUBLE PRECISION, FLOAT8, NUMERIC, DECIMAL | `"double"` | `number` |
| BOOLEAN, BOOL | `"boolean"` | `boolean` |
| CHARACTER VARYING, VARCHAR | `"varchar"` | `string` |
| TEXT | `"text"` | `string` |
| CHAR, CHARACTER, BPCHAR | `"char"` | `string` |
| TIMESTAMP, TIMESTAMP WITHOUT TIME ZONE | `"timestamp"` | `Date` |
| TIMESTAMPTZ, TIMESTAMP WITH TIME ZONE | `"timestamptz"` | `Date` |
| DATE | `"date"` | `Date` |
| JSON | `"json"` | `any` |
| JSONB | `"jsonb"` | `any` |
| BYTEA | `"blob"` | `Buffer` |
| ARRAY | `"array"` | `any` |
| USER-DEFINED | `"enum"` | `string` |

### MySQL

| 데이터베이스 타입 | ORM ColumnType | TypeScript 타입 |
|------------------|----------------|-----------------|
| INT, INTEGER, MEDIUMINT, SMALLINT | `"int"` | `number` |
| TINYINT | `"boolean"` | `boolean` |
| BIGINT | `"bigint"` | `number` |
| FLOAT | `"float"` | `number` |
| DOUBLE, DECIMAL, NUMERIC | `"double"` | `number` |
| VARCHAR | `"varchar"` | `string` |
| CHAR | `"char"` | `string` |
| TEXT, MEDIUMTEXT, TINYTEXT | `"text"` | `string` |
| LONGTEXT | `"longtext"` | `string` |
| DATETIME | `"datetime"` | `Date` |
| TIMESTAMP | `"timestamp"` | `Date` |
| DATE | `"date"` | `Date` |
| JSON | `"json"` | `any` |
| BLOB, MEDIUMBLOB, LONGBLOB, TINYBLOB | `"blob"` | `Buffer` |
| ENUM | `"enum"` | `string` |

제너레이터가 인식하지 못하는 타입을 만나면 `"varchar"`(TypeScript에서는 `string`으로 매핑)로 폴백합니다. 이는 안전한 기본값입니다 -- 나중에 직접 타입을 다듬을 수 있습니다.

---

## 외래 키 감지

인트로스펙션 제너레이터가 외래 키를 발견하면 두 가지를 합니다:

1. **FK 컬럼을 일반 `@Column` 출력에서 건너뜁니다.** `@Column({ type: "int" }) authorId!: number`를 만들지 않고 컬럼 자체를 제거합니다.
2. **참조된 테이블을 가리키는 `@ManyToOne` 관계를 생성합니다.** 원래 FK 컬럼명이 `joinColumn`이 됩니다.

예를 들어 다음 데이터베이스 스키마가 있을 때:

```sql
CREATE TABLE "users" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(100) NOT NULL
);

CREATE TABLE "posts" (
  "id" SERIAL PRIMARY KEY,
  "title" VARCHAR(255) NOT NULL,
  "author_id" INT REFERENCES "users"("id")
);
```

제너레이터는 `posts`에 대한 엔티티에서 `author_id`를 다음과 같이 변환합니다:

```typescript
@ManyToOne(() => User, { joinColumn: "author_id" })
author!: User;
```

속성명은 FK 컬럼명에서 `_id` 접미사를 제거해 만듭니다: `author_id`는 `author`가 됩니다. FK 컬럼이 `_id`로 끝나지 않는다면 컬럼명 전체가 속성명으로 사용됩니다.

---

## 옵션

`IntrospectionGeneratorOptions`로 어떤 테이블을 생성할지, 코드를 어떻게 만들지 제어할 수 있습니다.

### schema

PostgreSQL 전용. 어느 스키마를 인트로스펙트할지 지정합니다. 기본값은 `"public"`입니다.

```typescript
const generator = new IntrospectionGenerator(queryFn, "postgres", {
  schema: "tenant_42",
});
```

### includeTables

설정 시, 이 테이블들만 생성됩니다. 그 외 테이블은 모두 무시됩니다.

```typescript
const generator = new IntrospectionGenerator(queryFn, "postgres", {
  includeTables: ["users", "posts", "comments"],
});
// 데이터베이스에 47개 테이블이 있더라도 이 3개만 엔티티가 생성됩니다.
```

### excludeTables

생성 시 건너뛸 테이블입니다. 시스템 테이블이나 직접 관리하고 싶은 테이블을 제외할 때 유용합니다.

```typescript
const generator = new IntrospectionGenerator(queryFn, "postgres", {
  excludeTables: ["__migrations", "__seeds", "spatial_ref_sys"],
});
```

`includeTables`와 `excludeTables`가 모두 설정되면, `includeTables`가 먼저 적용되어(포함된 테이블만 고려) 그 후 `excludeTables`로 일치하는 항목이 제거됩니다.

### codeBuilderOptions

`EntityCodeBuilder`로 전달되는 옵션입니다:

```typescript
const generator = new IntrospectionGenerator(queryFn, "postgres", {
  codeBuilderOptions: {
    importPath: "../orm",  // 사용자 정의 import 경로 (기본값: "@stingerloom/orm")
  },
});
```

이 옵션은 생성된 파일의 import 문을 변경합니다:

```typescript
// 기본
import { Column, Entity, PrimaryGeneratedColumn } from "@stingerloom/orm";

// 사용자 정의 importPath 적용
import { Column, Entity, PrimaryGeneratedColumn } from "../orm";
```

---

## API 레퍼런스

### IntrospectionGenerator

| 메서드 | 시그니처 | 설명 |
|-------|---------|------|
| `constructor` | `(queryFn, dialect, options?)` | 쿼리 함수, 다이얼렉트(`"postgres"` 또는 `"mysql"`), 선택적 옵션을 받아 제너레이터 생성 |
| `generate()` | `(): Promise<GeneratedEntity[]>` | 매칭되는 모든 테이블에 대한 엔티티 파일 생성 |
| `discoverTables()` | `(): Promise<string[]>` | 대상 스키마의 모든 테이블명 반환 |
| `getColumns(table)` | `(table: string): Promise<DbColumn[]>` | 특정 테이블의 컬럼 메타데이터 가져오기 |
| `getPrimaryKeys(table)` | `(table: string): Promise<string[]>` | 특정 테이블의 기본 키 컬럼명 가져오기 |
| `getForeignKeys(table)` | `(table: string): Promise<DbForeignKey[]>` | 특정 테이블의 외래 키 관계 가져오기 |

### IntrospectionTypeMapper

| 메서드 | 시그니처 | 설명 |
|-------|---------|------|
| `toColumnType(dbType, dialect)` | `(dbType: string, dialect): ColumnType` | 데이터베이스 타입 문자열을 ORM ColumnType으로 매핑 |
| `toTsType(columnType)` | `(columnType: ColumnType): string` | ORM ColumnType을 TypeScript 타입 문자열로 매핑 |

### EntityCodeBuilder

| 메서드 | 시그니처 | 설명 |
|-------|---------|------|
| `constructor` | `(options?: EntityCodeBuilderOptions)` | 선택적 import 경로로 빌더 생성 |
| `build(tableName, columns, pks, fks, dialect)` | `(...): string` | TypeScript 엔티티 소스 코드 생성 |
| `tableNameToClassName(tableName)` | `(tableName: string): string` | snake_case 테이블명을 PascalCase 클래스명으로 변환 |

### DbColumn

| 속성 | 타입 | 설명 |
|------|------|------|
| `column_name` | `string` | 컬럼명 |
| `data_type` | `string` | 데이터베이스 네이티브 타입명 |
| `is_nullable` | `string` | `"YES"` 또는 `"NO"` |
| `character_maximum_length` | `number \| null` | 문자열 타입의 최대 길이 |
| `numeric_precision` | `number \| null` | 숫자 타입의 정밀도 |
| `numeric_scale` | `number \| null` | 숫자 타입의 소수점 자리수 |
| `column_default` | `string \| null` | 기본값 표현식 |

### DbForeignKey

| 속성 | 타입 | 설명 |
|------|------|------|
| `column_name` | `string` | 현재 테이블의 FK 컬럼명 |
| `referenced_table` | `string` | 참조된 테이블명 |
| `referenced_column` | `string` | 참조된 컬럼명 |
| `constraint_name` | `string \| undefined` | FK 제약 이름 |

---

## 다음 단계

- [데이터베이스 시딩](./seeding.md) -- 생성 후 테이블에 초기 데이터 채우기
- [마이그레이션](./migrations.md) -- 버전 관리되는 스키마 변경
- [엔티티 & 컬럼](./entities.md) -- 생성된 엔티티 파일 커스터마이즈
- [관계](./relations.md) -- OneToMany, ManyToMany 등 관계 추가
