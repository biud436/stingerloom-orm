# 데이터베이스 인트로스펙션

## 인트로스펙션이 필요한 이유

새 팀에 합류했다고 가정해 봅시다. 프로젝트에는 47개의 테이블, 수백 개의 컬럼, 그리고 모든 것을 연결하는 외래 키가 있는 데이터베이스가 있습니다. 이전 개발자는 ORM을 쓰지 않았고 — 모든 SQL은 직접 작성된 상태죠. 이 프로젝트를 Stingerloom ORM으로 마이그레이션하는 것이 당신의 일입니다.

인트로스펙션이 없다면 pgAdmin이나 DBeaver를 열어 테이블 정의를 하나씩 살피며 47개의 엔티티 파일을 직접 작성해야 합니다. 컬럼마다 타입, null 허용 여부, 길이, 기본값을 확인합니다. 외래 키마다 관계를 파악해 `@ManyToOne` 데코레이터를 추가합니다. 몇 시간이 걸리고 거의 확실히 실수가 나옵니다.

인트로스펙션을 사용하면 제너레이터를 데이터베이스에 연결하기만 해도 47개의 엔티티 파일이 자동으로 생성됩니다. 외래 키는 `@ManyToOne` + `@RelationColumn`이 됩니다. UNIQUE 제약은 `@UniqueIndex`가 됩니다. `created_at` / `updated_at` / `deleted_at` 컬럼은 `@CreateTimestamp` / `@UpdateTimestamp` / `@DeletedAt`로 인식됩니다. snake_case 컬럼명은 명시적 `name:` 옵션을 통해 보존되어 — 생성된 엔티티는 **라운드 트립이 안정적**입니다. 즉 그 결과를 다시 빈 DB에 적용하면 동일한 스키마가 만들어집니다.

인트로스펙션은 스키마 동기화의 반대 동작입니다. `synchronize: true`가 엔티티를 읽어 테이블을 만든다면, 인트로스펙션은 테이블을 읽어 엔티티를 만듭니다.

---

## 동작 방식

인트로스펙션 시스템은 핵심 컴포넌트 3개와 런타임 헬퍼로 구성됩니다:

```
┌─────────────────────────┐
│  IntrospectionGenerator │   오케스트레이터 — DB 카탈로그를 쿼리하고
│                         │   하위 컴포넌트를 조율
└───────────┬─────────────┘
            │
     ┌──────┴──────┐
     │             │
     v             v
┌──────────┐  ┌──────────────────┐
│TypeMapper│  │EntityCodeBuilder │
│          │  │                  │
│ DB 타입  │  │ 컬럼/PK/FK/인덱스 │
│ → ORM    │  │ → .ts 코드 생성  │
│ ColumnType│  │                  │
└──────────┘  └──────────────────┘
            │
            v
   ┌──────────────────┐
   │  runIntrospect() │   DatabaseClient로 접속, 파일 디스크 기록,
   │  + stingerloom   │   CLI 명령까지 한 번에 처리하는
   │   introspect CLI │   편의 래퍼
   └──────────────────┘
```

단계별 흐름:

1. **테이블 발견.** PostgreSQL은 `pg_tables`, MySQL은 `information_schema.TABLES`, SQLite는 `sqlite_master`.
2. **컬럼 메타데이터 수집.** 테이블별로 이름, 타입, 길이, 정밀도/스케일, 널 허용, 기본값에 더해 다이얼렉트 별 추가 정보 — MySQL의 `COLUMN_TYPE`(TINYINT(1) 식별용), PostgreSQL의 `is_identity`(`GENERATED AS IDENTITY` 식별용) 등.
3. **기본 키 수집.** 복합 PK, SQLite의 `INTEGER PRIMARY KEY` rowid-alias 패턴 모두 처리.
4. **외래 키 수집.** FK 컬럼의 ordinal position 순으로 정렬해 출력이 결정론적이 되도록 보장.
5. **인덱스 수집.** PK가 아닌 인덱스만. FK가 암묵적으로 만든 단일 컬럼 인덱스는 대부분의 엔진이 자동 생성하므로 제외.
6. **ENUM 라벨 해석.** PostgreSQL은 `pg_type` + `pg_enum`, MySQL은 `COLUMN_TYPE`의 `ENUM('a','b',…)` 값 목록 파싱.
7. **타입 매핑.** `IntrospectionTypeMapper`가 DB 네이티브 타입을 ORM `ColumnType`으로 변환.
8. **코드 생성.** `EntityCodeBuilder`가 import, 데코레이터, 프로퍼티를 조립. 다중 컬럼·UNIQUE 인덱스는 클래스 레벨 `@Index`/`@UniqueIndex`, 단일 컬럼 비-UNIQUE 인덱스는 프로퍼티 레벨 `@Index()`, 휴리스틱에 부합하는 컬럼명은 타임스탬프 데코레이터로 출력.

---

## 세 가지 사용 방식

### 1. CLI — `npx stingerloom introspect`

가장 간단한 경로. CLI는 기존 `stingerloom.config.ts`(또는 `ormconfig.ts`)의 DB 옵션을 재사용합니다:

```bash
# 자동 감지된 설정으로 ./entities/에 엔티티 생성
npx stingerloom introspect

# 출력 디렉터리, 스키마, 제외 테이블 지정
npx stingerloom introspect \
  --output ./src/entities \
  --schema reporting \
  --exclude __migrations,sessions

# 일부 테이블만 화이트리스트
npx stingerloom introspect --include users,posts,comments

# 파일을 쓰지 않고 미리 보기만
npx stingerloom introspect --dry-run
```

| 플래그 | 설명 |
|-------|------|
| `--output <dir>` | 생성된 엔티티를 쓸 경로. 기본값: `./entities` |
| `--schema <name>` | PostgreSQL 스키마. 기본값: `public` |
| `--include <list>` | 생성할 테이블의 콤마 구분 화이트리스트 |
| `--exclude <list>` | 건너뛸 테이블의 콤마 구분 블랙리스트 |
| `--import-path <p>` | ORM 데코레이터 import 경로. 기본값: `@stingerloom/orm` |
| `--dry-run` | 파일을 쓰지 않고 생성 대상만 보고 |
| `--config <path>` | 명시적 설정 파일 경로(기본값: 자동 감지) |

### 2. `runIntrospect()` — 프로그램 헬퍼

완전한 제어가 필요할 때 사용하는 스크립트용 헬퍼. `runIntrospect`는 `DatabaseClient`로 접속하고, 제너레이터를 실행하고, 파일을 한 번에 기록합니다:

```typescript
import { runIntrospect } from "@stingerloom/orm";

const result = await runIntrospect(
  {
    type: "mysql",
    host: "localhost",
    port: 3306,
    username: "root",
    password: process.env.DB_PASSWORD,
    database: "blog",
  },
  {
    outputDir: "./src/entities",
    excludeTables: ["__migrations", "session_db"],
    codeBuilderOptions: { importPath: "@stingerloom/orm" },
  },
);

console.log(`${result.writtenFiles.length}개의 엔티티 파일을 작성했습니다`);
for (const e of result.entities) {
  console.log(`  - ${e.fileName}  (${e.tableName} → ${e.className})`);
}
```

`IntrospectionCliOptions`:

| 옵션 | 타입 | 기본값 |
|------|------|--------|
| `outputDir` | `string` | `./entities` |
| `schema` | `string` | `"public"` (PostgreSQL 전용) |
| `includeTables` | `string[]` | — |
| `excludeTables` | `string[]` | — |
| `codeBuilderOptions` | `EntityCodeBuilderOptions` | — |
| `dryRun` | `boolean` | `false` — true일 때 파일을 쓰지 않고 엔티티만 반환 |

### 3. `IntrospectionGenerator` — 저수준 빌딩 블록

커스텀 쿼리 함수로 제너레이터를 직접 구동하는 등 고급 사용:

```typescript
import { IntrospectionGenerator } from "@stingerloom/orm";

const generator = new IntrospectionGenerator(
  (q) => driver.query(q),         // 문자열 또는 `sql` 템플릿 태그 수용
  "postgres",                      // "postgres" | "mysql" | "sqlite"
  { schema: "public", excludeTables: ["__migrations"] },
);

const entities = await generator.generate();
// 또는 개별 메타데이터 조회:
const tables = await generator.discoverTables();
const columns = await generator.getColumns("users");
const fks = await generator.getForeignKeys("posts");
const indexes = await generator.getIndexes("users");
```

---

## 생성되는 코드 모습

다음 MariaDB 스키마가 있을 때:

```sql
CREATE TABLE user (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(255) NOT NULL,
  access_key VARCHAR(191) NOT NULL,
  is_valid TINYINT(1) DEFAULT 1,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  profile_id INT,
  CONSTRAINT fk_user_profile FOREIGN KEY (profile_id) REFERENCES profile(id),
  UNIQUE KEY uq_user_username (username)
);
```

인트로스펙션은 다음을 생성합니다:

```typescript
import {
  Column,
  CreateTimestamp,
  Entity,
  ManyToOne,
  PrimaryGeneratedColumn,
  RelationColumn,
  UniqueIndex,
  UpdateTimestamp,
} from "@stingerloom/orm";
import { Profile } from "./profile.entity";

@Entity({ name: "user" })
@UniqueIndex(["username"], "uq_user_username")
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 255 })
  username!: string;

  @Column({ type: "varchar", name: "access_key", length: 191 })
  accessKey!: string;

  @Column({ type: "boolean", name: "is_valid", nullable: true, default: true })
  isValid!: boolean;

  @CreateTimestamp({ name: "created_at" })
  createdAt!: Date;

  @UpdateTimestamp({ name: "updated_at" })
  updatedAt!: Date;

  @ManyToOne(() => Profile, (entity: any) => entity.profile)
  @RelationColumn({ name: "profile_id" })
  profile!: Profile;
}
```

눈여겨볼 점:

- **`name:` 옵션이 DB 컬럼명을 보존**합니다 (`access_key`, `is_valid`). 기본 identity NamingStrategy에서도 동일한 컬럼명으로 라운드 트립됩니다. 이게 없으면 재적용 시 DB에 `accessKey` 컬럼이 만들어져 깨집니다.
- **TINYINT(1)은 `boolean`으로 인식**되고, 더 넓은 TINYINT(예: `TINYINT(4)`, `TINYINT UNSIGNED`)는 `int`로 매핑됩니다.
- **`created_at` / `updated_at`은 타임스탬프 데코레이터**로 출력되고 컬럼명이 옵션으로 전달됩니다.
- **FK 컬럼 `profile_id`는 `@Column`이 아니라** `@ManyToOne` + `@RelationColumn({ name })` 한 쌍으로 표현됩니다. deprecated된 `joinColumn` 옵션은 사용하지 않습니다.
- **UNIQUE 인덱스는 클래스 레벨 `@UniqueIndex`로 승격**되며 원본 인덱스명을 유지합니다.

---

## 라운드 트립 안정성

인트로스펙션 출력은 결정론적입니다. 동일한 DB 스키마에 대해 두 번 실행하면 비트 단위로 동일한 파일이 나옵니다. 그 출력물을 스키마로 적용하고 다시 인트로스펙트해도 또 동일합니다. 이를 가능케 하는 메커니즘:

| 메커니즘 | 이유 |
|---------|------|
| `@Column`, `@PrimaryColumn`, `@PrimaryGeneratedColumn`, `@CreateTimestamp`, `@UpdateTimestamp`, `@DeletedAt`에 DB 컬럼명 ≠ 프로퍼티명일 때 명시적 `name:` emit | identity NamingStrategy에서 재적용 시 camelCase 컬럼이 만들어지는 것을 방지 |
| FK 관계는 컬럼 ordinal position 순으로 정렬 | INFORMATION_SCHEMA의 기본 정렬은 엔진별로 불안정 |
| camelCase 컬럼은 `columnNameToPropertyName`이 그대로 보존 | 없으면 `updatedAt` 컬럼이 `updatedat` 프로퍼티가 됨 |
| 클래스 레벨 `@Index`/`@UniqueIndex`는 **프로퍼티 키**로 emit (DB 컬럼명 아님) | ORM이 메타데이터로 다시 매핑하므로 DB 컬럼명을 그대로 넣으면 미스매치 |
| MariaDB의 `COLUMN_DEFAULT = 'NULL'` 노이즈는 필터링 | 그대로 두면 nullable 컬럼에 `default: "(NULL)"` 잡음이 끼임 |
| 자기참조 FK는 자기 자신을 import하지 않음 | 로컬 클래스 선언과 충돌 |
| 복합 PK + FK인 컬럼은 `@PrimaryColumn`과 관계 양쪽을 모두 출력 | 클로저 테이블에는 실제 PK가 필요 |

덕분에 레거시 DB를 인트로스펙트해 엔티티를 커밋한 뒤, CI/CD가 스테이징 DB에 재적용해도 동일한 결과를 얻을 수 있습니다.

---

## 타입 매핑

### PostgreSQL

| 데이터베이스 타입 | ORM `ColumnType` | TypeScript |
|----------------|-----------------|------------|
| `INTEGER`, `INT4`, `SMALLINT`, `SERIAL` | `int` | `number` |
| `BIGINT`, `INT8`, `BIGSERIAL` | `bigint` | `number` |
| `REAL`, `FLOAT4` | `float` | `number` |
| `DOUBLE PRECISION`, `FLOAT8`, `NUMERIC`, `DECIMAL` | `double` | `number` (precision/scale 보존) |
| `BOOLEAN`, `BOOL` | `boolean` | `boolean` |
| `CHARACTER VARYING`, `VARCHAR` | `varchar` | `string` (length 보존) |
| `TEXT` | `text` | `string` |
| `CHAR`, `CHARACTER`, `BPCHAR` | `char` | `string` (length 보존) |
| `TIMESTAMP`, `TIMESTAMP WITHOUT TIME ZONE` | `timestamp` | `Date` |
| `TIMESTAMPTZ`, `TIMESTAMP WITH TIME ZONE` | `timestamptz` | `Date` |
| `DATE` | `date` | `Date` |
| `JSON` | `json` | `any` |
| `JSONB` | `jsonb` | `any` |
| `BYTEA` | `blob` | `Buffer` |
| `ARRAY` | `array` | `any` |
| `USER-DEFINED` (`udt_name`이 `pg_type.typtype = 'e'`로 해석되는 경우) | `enum` (라벨 임베드) | `string` |

`GENERATED { ALWAYS \| BY DEFAULT } AS IDENTITY` 컬럼(PG 10+)은 `information_schema.columns.is_identity = 'YES'`로 인식되어 `@PrimaryGeneratedColumn`으로 출력됩니다.

### MySQL / MariaDB

| 데이터베이스 타입 | ORM `ColumnType` | TypeScript |
|----------------|-----------------|------------|
| `INT`, `INTEGER`, `MEDIUMINT`, `SMALLINT` | `int` | `number` |
| `TINYINT(1)` | `boolean` | `boolean` |
| `TINYINT(N)` (`N > 1`), `TINYINT UNSIGNED` | `int` | `number` |
| `BIGINT` | `bigint` | `number` |
| `FLOAT` | `float` | `number` |
| `DOUBLE`, `DECIMAL`, `NUMERIC` | `double` | `number` (precision/scale 보존) |
| `VARCHAR` | `varchar` | `string` (length 보존) |
| `CHAR` | `char` | `string` (length 보존) |
| `TEXT`, `MEDIUMTEXT`, `TINYTEXT` | `text` | `string` |
| `LONGTEXT` | `longtext` | `string` |
| `DATETIME`, `TIMESTAMP`, `DATE` | `datetime` / `timestamp` / `date` | `Date` |
| `JSON` | `json` | `any` |
| `BLOB`, `MEDIUMBLOB`, `LONGBLOB`, `TINYBLOB` | `blob` | `Buffer` |
| `ENUM('a','b',…)` | `enum` (값을 `COLUMN_TYPE`에서 파싱) | `string` |

인트로스펙터는 `INFORMATION_SCHEMA.COLUMNS.COLUMN_TYPE`(폭 정보 포함된 선언 타입)을 읽어 TINYINT(1)을 다른 폭과 구분합니다. `COLUMN_TYPE`을 받지 못한 경우 TINYINT는 후방 호환을 위해 `boolean`으로 폴백합니다.

### SQLite

| 선언 타입 | ORM `ColumnType` | TypeScript |
|---------|------------------|------------|
| `INTEGER`, `INT`, `INT2`, `INT4`, `MEDIUMINT`, `SMALLINT`, `TINYINT` | `int` | `number` |
| `INT8`, `BIGINT`, `UNSIGNED BIG INT` | `bigint` | `number` |
| `REAL`, `FLOAT` | `float` | `number` |
| `DOUBLE`, `DOUBLE PRECISION`, `NUMERIC`, `DECIMAL` | `double` | `number` (precision/scale 파싱) |
| `BOOLEAN`, `BOOL` | `boolean` | `boolean` |
| `TEXT` | `text` | `string` |
| `CLOB` | `longtext` | `string` |
| `CHARACTER`, `CHAR`, `NATIVE CHARACTER` | `char` | `string` (length 파싱) |
| `VARCHAR`, `VARYING CHARACTER`, `NVARCHAR` | `varchar` | `string` (length 파싱) |
| `DATETIME`, `TIMESTAMP`, `DATE` | `datetime` / `timestamp` / `date` | `Date` |
| `JSON` | `json` | `any` |
| `BLOB` | `blob` | `Buffer` |

SQLite는 `PRAGMA table_info()`, `PRAGMA foreign_key_list()`, `PRAGMA index_list()`, `PRAGMA index_info()`로 스키마를 추출합니다. 단일 컬럼 `INTEGER PRIMARY KEY`는 rowid alias로 인식되어 `@PrimaryGeneratedColumn`이 출력됩니다.

알 수 없는 타입은 `varchar`(TypeScript에서는 `string`)로 폴백됩니다.

---

## 외래 키 감지

제너레이터는 외래 키를 발견하면 다음을 수행합니다:

1. **FK 컬럼을 일반 `@Column` 출력에서 건너뜁니다.** 관계가 대체합니다.
2. **참조 테이블을 가리키는 `@ManyToOne` + `@RelationColumn` 한 쌍을 출력**합니다.
3. **FK 관계는 테이블 내 FK 컬럼 위치 순으로 정렬**해 결정론적인 출력을 보장합니다.

```typescript
@ManyToOne(() => User, (entity: any) => entity.author)
@RelationColumn({ name: "author_id" })
author!: User;
```

프로퍼티명은 FK 컬럼명으로부터 다음과 같이 도출됩니다:

- `_id` 접미사 제거: `author_id` → `author`
- `id_` 접두사 제거: `id_ancestor` → `ancestor`
- 그 외에는 컬럼명을 camelCase로 변환: `parentRef` → `parentRef`

이 이름이 다른 컬럼과 충돌하면(예: `user` 텍스트 컬럼이 존재하는데 FK 컬럼이 `user_id`인 경우) FK 컬럼명을 그대로 camelCase 한 이름(`userId`)으로 폴백합니다.

### 자기참조 FK

FK가 같은 테이블을 다시 가리키면 관계는 출력하되 **그 클래스를 import하지 않습니다**:

```typescript
@Entity({ name: "department" })
export class Department {
  @PrimaryGeneratedColumn()
  deptSq!: number;

  @ManyToOne(() => Department, (entity: any) => entity.upperDeptSq)
  @RelationColumn({ name: "UPPER_DEPT_SQ" })
  upperDeptSq!: Department;
}
```

### 복합 PK 클로저 테이블

FK 컬럼이 동시에 PK인 경우(클로저 테이블이나 복합 PK 조인 테이블에서 흔함), 제너레이터는 **`@PrimaryColumn` 선언과 관계를 모두** 출력합니다:

```typescript
@Entity({ name: "post_comment_closure" })
export class PostCommentClosure {
  @PrimaryColumn({ type: "int", name: "id_ancestor" })
  idAncestor!: number;

  @PrimaryColumn({ type: "int", name: "id_descendant" })
  idDescendant!: number;

  @ManyToOne(() => PostComment, (entity: any) => entity.ancestor)
  @RelationColumn({ name: "id_ancestor" })
  ancestor!: PostComment;

  @ManyToOne(() => PostComment, (entity: any) => entity.descendant)
  @RelationColumn({ name: "id_descendant" })
  descendant!: PostComment;
}
```

---

## 인덱스 감지

제너레이터는 `INFORMATION_SCHEMA.STATISTICS`(MySQL), `pg_index` + `pg_attribute`(PostgreSQL), `PRAGMA index_list` + `PRAGMA index_info`(SQLite)에서 PK가 아닌 인덱스를 가져와 분류합니다:

| 인덱스 종류 | 출력 형태 |
|----------|---------|
| 단일 컬럼 비-UNIQUE | 매칭 컬럼에 프로퍼티 레벨 `@Index()` |
| 단일 컬럼 UNIQUE | 클래스 레벨 `@UniqueIndex([col], name)` |
| 다중 컬럼 비-UNIQUE | 클래스 레벨 `@Index([col1, col2], name)` |
| 다중 컬럼 UNIQUE | 클래스 레벨 `@UniqueIndex([col1, col2], name)` |

PK를 정확히 덮는 인덱스는 제외됩니다(이미 `@PrimaryColumn` / `@PrimaryGeneratedColumn`이 처리). 외래 키 컬럼 하나만 덮는 단일 컬럼 인덱스도 대부분의 엔진이 암묵적으로 만들기 때문에 제외됩니다.

클래스 레벨 데코레이터는 **프로퍼티 키**를 인자로 받습니다(DB 컬럼명 아님). ORM이 엔티티 메타데이터로 다시 컬럼명을 매핑합니다.

---

## 타임스탬프 데코레이터 휴리스틱

다음 조합(프로퍼티명 + 컬럼 타입 + nullability)에 부합하는 컬럼은 일반 `@Column` 대신 타임스탬프 데코레이터로 출력됩니다:

| 프로퍼티명 | 컬럼 타입 | nullable | 데코레이터 |
|----------|---------|---------|-----------|
| `createdAt` | datetime/timestamp/timestamptz/date | No | `@CreateTimestamp({ name?, type? })` |
| `updatedAt` | datetime/timestamp/timestamptz/date | No | `@UpdateTimestamp({ name?, type? })` |
| `deletedAt` | datetime/timestamp/timestamptz/date | Yes | `@DeletedAt({ name?, type? })` |

데코레이터는 DB 컬럼명이 프로퍼티명과 다를 때 `name:`을, 타입이 기본값 `datetime`이 아닐 때 `type:`을 emit합니다. 휴리스틱에 부합하지 않는 컬럼(예: `upload_date`, `published_at`)은 일반 `@Column` 형태를 유지하고 원본 기본값도 보존합니다.

---

## 기본값 보존

`column_default` 값은 정규화되어 `@Column({ default: … })`로 출력됩니다:

| DB의 원본 default | 출력 |
|-----------------|------|
| `'active'` (문자열 리터럴) | `default: "active"` |
| `'active'::character varying` (PG cast) | `default: "active"` (cast 제거) |
| `0`, `42`, `-1` (숫자) | `default: 0` (숫자 타입 컬럼) |
| `true`, `false`, `'t'`, `'f'`, `0`, `1` (boolean 컬럼) | `default: true` / `default: false` |
| `CURRENT_TIMESTAMP`, `now()`, `uuid_generate_v4()` | `default: "(CURRENT_TIMESTAMP)"` (원본 표현식 wrap) |
| `nextval('seq'::regclass)` 또는 `auto_increment` | 출력 생략 (PK 자동 생성기에 위임) |
| MariaDB의 bare `NULL`(명시적 default 없는 경우) | 출력 생략 |

---

## 옵션 레퍼런스

### `IntrospectionGeneratorOptions`

| 옵션 | 타입 | 설명 |
|------|------|------|
| `schema` | `string` | PostgreSQL 스키마. 기본값: `"public"` |
| `includeTables` | `string[]` | 생성 화이트리스트 |
| `excludeTables` | `string[]` | 건너뛸 블랙리스트 |
| `codeBuilderOptions` | `EntityCodeBuilderOptions` | `EntityCodeBuilder`에 전달 |

### `EntityCodeBuilderOptions`

| 옵션 | 타입 | 기본값 |
|------|------|--------|
| `importPath` | `string` | `"@stingerloom/orm"` |

---

## API 레퍼런스

### `IntrospectionGenerator`

| 메서드 | 시그니처 | 설명 |
|-------|---------|------|
| `constructor` | `(queryFn, dialect, options?)` | 쿼리 함수, 다이얼렉트(`"postgres"` / `"mysql"` / `"sqlite"`), 옵션을 받아 생성 |
| `generate()` | `(): Promise<GeneratedEntity[]>` | 매칭되는 모든 테이블에 대한 엔티티 파일 생성 |
| `discoverTables()` | `(): Promise<string[]>` | 대상 스키마의 모든 사용자 테이블명 |
| `getColumns(table)` | `(table: string): Promise<DbColumn[]>` | 특정 테이블의 컬럼 메타데이터 |
| `getPrimaryKeys(table)` | `(table: string): Promise<string[]>` | 기본 키 컬럼명 |
| `getForeignKeys(table)` | `(table: string): Promise<DbForeignKey[]>` | 외래 키 관계 |
| `getIndexes(table)` | `(table: string): Promise<DbIndex[]>` | PK가 아닌 인덱스(UNIQUE 및 비-UNIQUE) |

### `runIntrospect(dbOptions, cliOptions?)`

`DatabaseClient`로 접속해 제너레이터를 실행하고 파일을 디스크에 기록(`dryRun: true`이면 기록 생략). `{ writtenFiles, entities }`를 반환합니다.

### `IntrospectionTypeMapper`

| 메서드 | 시그니처 | 설명 |
|-------|---------|------|
| `toColumnType(dbType, dialect, columnTypeFull?)` | `(...): ColumnType` | DB 타입을 매핑. MySQL `COLUMN_TYPE`을 세 번째 인자로 전달하면 TINYINT 폭 식별 |
| `toTsType(columnType)` | `(columnType: ColumnType): string` | ORM `ColumnType` → TypeScript 타입 문자열 |
| `parseSqliteWidth(declaredType)` | `(declaredType: string): number \| null` | `VARCHAR(N)` 같은 표기에서 `N` 추출 |
| `parseSqlitePrecisionScale(declaredType)` | `(declaredType: string): { precision, scale } \| null` | `DECIMAL(P, S)`에서 `(P, S)` 추출 |

### `EntityCodeBuilder`

| 메서드 | 시그니처 | 설명 |
|-------|---------|------|
| `constructor` | `(options?: EntityCodeBuilderOptions)` | import 경로를 선택 옵션으로 받는 빌더 생성 |
| `build(table, columns, pks, fks, dialect, indexes?)` | `(...): string` | TypeScript 엔티티 소스 코드 생성 |
| `tableNameToClassName(table)` | `(string): string` | snake_case 테이블명 → PascalCase 클래스명 |
| `classNameToFileName(className)` | `(string): string` | PascalCase 클래스명 → kebab-case 파일명 |

### `DbColumn`

| 속성 | 타입 | 설명 |
|------|------|------|
| `column_name` | `string` | 컬럼명 |
| `data_type` | `string` | DB 네이티브 타입명 |
| `is_nullable` | `string` | `"YES"` 또는 `"NO"` |
| `character_maximum_length` | `number \| null` | char/varchar 최대 길이 |
| `numeric_precision` | `number \| null` | decimal/numeric 정밀도 |
| `numeric_scale` | `number \| null` | decimal/numeric 소수 자리수 |
| `column_default` | `string \| null` | DB가 보고하는 기본값 표현식 |
| `column_type` | `string \| null` | MySQL `COLUMN_TYPE`(폭 포함, 예: `tinyint(1)`) |
| `is_identity` | `string \| null` | PG `"YES"` for `GENERATED AS IDENTITY` |
| `enum_values` | `string[] \| null` | enum 라벨(PG `pg_enum` 또는 MySQL `COLUMN_TYPE` 파싱) |
| `extra` | `string \| null` | MySQL `EXTRA`(예: `auto_increment`) |

### `DbForeignKey`

| 속성 | 타입 | 설명 |
|------|------|------|
| `column_name` | `string` | 현재 테이블의 FK 컬럼 |
| `referenced_table` | `string` | 참조 대상 테이블 |
| `referenced_column` | `string` | 참조 대상 컬럼 |
| `constraint_name` | `string \| undefined` | FK 제약명 |

### `DbIndex`

| 속성 | 타입 | 설명 |
|------|------|------|
| `name` | `string` | 인덱스명(`@Index`/`@UniqueIndex` 출력 시 보존) |
| `column_names` | `string[]` | 인덱스를 구성하는 컬럼(순서 유지) |
| `is_unique` | `boolean` | UNIQUE 인덱스 여부 |

---

## 알려진 한계

인트로스펙션은 DB 스키마에 명시된 정보만 추출합니다. 다음은 한 방향 FK 정보만으로는 도출 불가능하므로 생성 후 수동으로 보강해야 합니다:

- **`@OneToMany` 인버스 컬렉션** (예: `User`에 `posts: Post[]`). 제너레이터는 `posts.author_id` FK의 소유 측면만 볼 수 있어서, 인버스 측 프로퍼티는 직접 추가해야 합니다.
- **`@OneToOne` vs `@ManyToOne` 구분**. 모든 FK는 `@ManyToOne`으로 출력됩니다. FK 컬럼에 UNIQUE 제약이 있다면 수동으로 변환하는 것이 좋습니다.
- **캐스케이드 규칙(`onDelete`, `onUpdate`)**. `REFERENTIAL_CONSTRAINTS`에서 추출하지 않습니다. 필요 시 수동 추가.
- **친화적 프로퍼티 별칭**. `CTGR_GRP_SQ` 같은 컬럼은 `ctgrGrpSq`로 camelCase 변환됩니다. `groupId` 같은 더 친근한 이름을 원하면 프로퍼티명을 수정하고 `name:` 옵션이 `CTGR_GRP_SQ`를 가리키게 두세요.

`@ManyToOne(() => Entity, (entity: any) => entity.foo)`의 인버스 접근자는 `any`로 캐스팅된 placeholder입니다. 인버스 프로퍼티가 없어도 컴파일은 됩니다. `@OneToMany` 컬렉션을 추가한 후에 placeholder를 실제 이름으로 바꾸세요.

---

## 다음 단계

- [데이터베이스 시딩](./seeding.md) — 생성 후 테이블에 초기 데이터 채우기
- [마이그레이션](./migrations.md) — 버전 관리되는 스키마 변경
- [엔티티 & 컬럼](./entities.md) — 생성된 엔티티 파일 커스터마이즈
- [관계](./relations.md) — OneToMany, ManyToMany 등 관계 추가
