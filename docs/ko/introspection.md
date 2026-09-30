# 데이터베이스 인트로스펙션

## 인트로스펙션이 필요한 이유

새 팀에 합류했다고 가정해 봅시다. 프로젝트에는 47개의 테이블, 수백 개의 컬럼, 그리고 모든 것을 연결하는 외래 키가 있는 데이터베이스가 있습니다. 이전 개발자는 ORM을 쓰지 않았고 — 모든 SQL은 직접 작성된 상태죠. 이 프로젝트를 Stingerloom ORM으로 옮기는 게 이번 일입니다.

인트로스펙션이 없다면 pgAdmin이나 DBeaver를 열어 테이블 정의를 하나씩 살피며 47개의 엔티티 파일을 직접 작성해야 합니다. 컬럼마다 타입, null 허용 여부, 길이, 기본값을 확인합니다. 외래 키마다 관계를 파악해 `@ManyToOne` 데코레이터를 추가합니다. 몇 시간이 걸리고 거의 확실히 실수가 나옵니다.

인트로스펙션을 사용하면 제너레이터를 데이터베이스에 연결하기만 해도 47개의 엔티티 파일이 자동으로 생성됩니다. 이 ORM이 지원하는 두 가지 엔티티 표기법(데코레이터, 그리고 데코레이터 없는 `defineEntity` 빌더) 중 어느 쪽으로 생성할지도 고를 수 있습니다([출력 스타일 선택](#출력-스타일-선택) 참고). 외래 키는 `ON DELETE` / `ON UPDATE` 동작까지 포함해 `@ManyToOne` + `@RelationColumn`이 됩니다. UNIQUE 제약은 `@UniqueIndex`가 됩니다. `created_at` / `updated_at` / `deleted_at` 컬럼은 `@CreateTimestamp` / `@UpdateTimestamp` / `@DeletedAt`로 인식됩니다. snake_case 컬럼명은 명시적 `name:` 옵션을 통해 보존되어 — 생성된 엔티티는 **라운드 트립이 안정적**입니다. 즉 그 결과를 다시 빈 DB에 적용하면 같은 스키마가 만들어집니다.

엔티티로 표현할 수 *없는* 부분 — ORM에 대응 타입이 없는 컬럼, 복합 외래 키, 부분 인덱스 같은 것 — 은 조용히 다른 것으로 바꾸지 않고, 생성된 파일의 해당 위치에 `// NOTE:` 주석으로 알려 줍니다.

인트로스펙션은 스키마 동기화의 반대 동작입니다. `synchronize: true`가 엔티티를 읽어 테이블을 만든다면, 인트로스펙션은 테이블을 읽어 엔티티를 만듭니다.

---

## 동작 방식

데이터베이스마다 자기 자신을 설명하는 방식이 다릅니다. PostgreSQL은 타입을 `character varying(80)`, 기본값을 `'active'::character varying`으로 적습니다. 같은 기본값을 MySQL은 따옴표 없이 `active`로, MariaDB는 `'active'`로 보여 주고, SQLite는 `CREATE TABLE`에 적힌 그대로를 돌려줍니다. 이 설명을 곧장 TypeScript로 옮기는 코드는 모든 단계에서 모든 표기를 알아야 하고, 어느 한 단계가 표기 하나를 놓치면 미묘하게 틀린 엔티티가 나옵니다.

그래서 인트로스펙션은 가운데에 방언 중립적인 **스키마 IR**을 둔 작은 컴파일러처럼 동작합니다.

```
                      읽기                        낮추기                        출력
 PostgreSQL 카탈로그 ─┐                ┌───────────────────────────┐
 MySQL 카탈로그  ─────┼──▶  스키마 IR ─┤ 이름, 관계, 인덱스           ├─▶ EntityModel ─┬─▶ @Entity 클래스
 SQLite 카탈로그 ─────┘   (의미 기준)  │ 컬럼별 ORM 타입               │               └─▶ defineEntity(...)
                                      └────────────┬──────────────┘
                                                   │ 검증
                          그 타입에 대해 ORM이 실제로 만드는 DDL을 같은 방언 리더로
                          다시 읽어 IR과 비교
```

1. **읽기.** 방언마다 하나씩 있는 카탈로그 리더가 데이터베이스의 테이블 설명을 IR로 옮깁니다. 컬럼은 *정규 타입*(표기가 아니라 의미 기준 — MySQL `TIMESTAMP`와 PostgreSQL `timestamptz`는 둘 다 시점(instant), MySQL `DATETIME`과 PostgreSQL `timestamp`는 둘 다 벽시계 시각)과 해석된 기본값, identity 여부를 가집니다. 기본 키, 외래 키(복합 키는 통째로, 참조 동작 포함), 인덱스(일반 컬럼 목록 이상의 무언가가 있다면 그 내용까지)도 함께 담깁니다. 방언별 특이점은 모두 여기서만 처리합니다.
2. **낮추기(lowering).** 각 테이블이 `EntityModel`이 됩니다. 유효하고 서로 겹치지 않는 클래스·프로퍼티 이름, 단일 컬럼 외래 키마다의 관계, 인덱스, 타임스탬프 마커가 정해집니다. ORM 컬럼 타입은 손으로 관리하는 역방향 표에서 찾지 **않습니다**. 후보 ORM 타입을 `synchronize`가 테이블을 만들 때 쓰는 바로 그 컬럼 정의 빌더로 렌더링하고, 그 DDL을 같은 리더로 다시 읽습니다. 컬럼 타입을 그대로 재현하는 첫 후보를 고르고, 재현하지 못하는 부분은 기록해 둡니다.
3. **출력.** 모델을 데코레이터 클래스나 `defineEntity` 빌더로 적습니다. 두 emitter 모두 모델이 정한 옵션을 빠짐없이 출력하므로, 두 표기법은 항상 같은 스키마를 선언합니다.

매핑을 ORM이 실제로 만드는 DDL과 대조해 검증하기 때문에 둘이 어긋날 수 없습니다. ORM이 어떤 타입을 선언하는 방식이 바뀌면, 타입 선택과 NOTE도 그에 맞춰 따라갑니다.

---

## 세 가지 사용 방식

### 1. CLI — `npx stingerloom introspect`

가장 간단한 경로입니다. CLI는 `stingerloom.config.ts`(또는 `ormconfig.ts`)의 DB 설정을 그대로 재사용합니다.

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

# 데코레이터 대신 `defineEntity` 기반 코드 우선 엔티티로 생성
npx stingerloom introspect --style code-first
```

| 플래그 | 설명 |
|--------|------|
| `--output <dir>` | 생성된 엔티티를 쓸 위치. 기본값: `./entities` |
| `--schema <name>` | PostgreSQL 스키마. 기본값: `public` |
| `--include <list>` | 생성할 테이블 화이트리스트(쉼표 구분) |
| `--exclude <list>` | 건너뛸 테이블 블랙리스트(쉼표 구분) |
| `--import-path <p>` | ORM 패키지 import 경로. 기본값: `@stingerloom/orm` |
| `--style <style>` | 출력할 엔티티 표기법: `decorator`(기본값) 또는 `code-first` |
| `--dry-run` | 파일을 쓰지 않고 생성될 내용만 보고 |
| `--config <path>` | 설정 파일 경로 명시(기본값: 자동 감지) |

생성된 파일 중 `// NOTE:`가 달린 파일이 있으면, CLI가 그 개수와 파일 이름을 로그로 알려 줍니다. 스키마가 커도 놓치지 않도록요.

### 2. `runIntrospect()` — 프로그램 헬퍼

모든 과정을 직접 제어하고 싶은 스크립트용입니다. `runIntrospect`는 `DatabaseClient`로 접속하고, 제너레이터를 실행하고, 파일까지 한 번에 씁니다.

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

console.log(`Wrote ${result.writtenFiles.length} entity files`);
for (const e of result.entities) {
  console.log(`  - ${e.fileName}  (${e.tableName} → ${e.className})`);
  for (const note of e.notes) console.log(`      NOTE ${note}`);
}
```

`IntrospectionCliOptions`:

| 옵션 | 타입 | 기본값 |
|------|------|--------|
| `outputDir` | `string` | `./entities` |
| `schema` | `string` | `"public"`(PostgreSQL 전용) |
| `includeTables` | `string[]` | — |
| `excludeTables` | `string[]` | — |
| `codeBuilderOptions` | `EntityCodeBuilderOptions` | — |
| `dryRun` | `boolean` | `false` — true면 파일을 쓰지 않고 엔티티만 반환 |

### 3. `IntrospectionGenerator` — 저수준 빌딩 블록

커스텀 쿼리 함수로 제너레이터를 돌리거나, 코드 생성 없이 스키마만 읽고 싶을 때 씁니다.

```typescript
import { IntrospectionGenerator } from "@stingerloom/orm/introspection";

const generator = new IntrospectionGenerator(
  (q) => driver.query(q),         // 문자열과 `sql` 템플릿 태그 모두 허용
  "postgres",                      // "postgres" | "mysql" | "sqlite"
  { schema: "public", excludeTables: ["__migrations"] },
);

const entities = await generator.generate();

// 스키마 IR만 따로 — 방언 중립적인 구조적 스키마 설명입니다:
const schema = await generator.readSchema();   // 선택된 테이블 전체
const users = await generator.readTable("users");
users.columns[0];
// { name: "id", type: { kind: "integer", bytes: 4, unsigned: false },
//   nullable: false, identity: true, nativeType: "integer", ... }
```

---

## 생성되는 코드 모습

다음 MariaDB 스키마가 있다면:

```sql
CREATE TABLE user (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(255) NOT NULL,
  access_key VARCHAR(191) NOT NULL,
  is_valid TINYINT(1) DEFAULT 1,
  login_count INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  profile_id INT,
  CONSTRAINT fk_user_profile FOREIGN KEY (profile_id) REFERENCES profile(id) ON DELETE SET NULL,
  UNIQUE KEY uq_user_username (username)
);
```

인트로스펙션 결과는 이렇습니다.

```typescript
import { Column, CreateTimestamp, Entity, ManyToOne, PrimaryGeneratedColumn, RelationColumn, UniqueIndex, UpdateTimestamp, type Relation } from "@stingerloom/orm";
import { Profile } from "./profile.entity.js";

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
  isValid!: boolean | null;

  // NOTE: The database declares "int(10) unsigned", but this entity creates "INT" — synchronizing it would change the column.
  @Column({ type: "int", name: "login_count", default: 0 })
  loginCount!: number;

  @CreateTimestamp({ name: "created_at" })
  createdAt!: Date;

  // NOTE: DEFAULT current_timestamp() is not declared: as an update timestamp the column is filled in by the ORM instead.
  // NOTE: ON UPDATE CURRENT_TIMESTAMP is not declared: as an update timestamp the column is set by the ORM on every save instead.
  @UpdateTimestamp({ name: "updated_at" })
  updatedAt!: Date;

  @ManyToOne(() => Profile, (entity: any) => entity.profile, { onDelete: "SET NULL" })
  @RelationColumn({ name: "profile_id", type: "int", nullable: true, referencedColumn: "id" })
  profile!: Relation<Profile>;
}
```

눈여겨볼 점:

- **`name:` 옵션이 DB 컬럼명을 보존합니다**(`access_key`, `is_valid`). 그래서 기본 identity NamingStrategy에서도 라운드 트립이 됩니다. 이 옵션이 없으면 엔티티를 적용했을 때 `access_key` 대신 `accessKey` 컬럼이 만들어집니다.
- **TINYINT(1)은 `boolean`으로 인식합니다.** 다른 폭의 TINYINT는 작은 정수입니다.
- **`INT UNSIGNED`에는 NOTE가 붙습니다.** ORM에는 부호 없는 정수 타입이 없어서 엔티티는 부호 있는 `INT`를 만들게 되는데, NOTE가 두 표기를 나란히 적어 그 사실을 그대로 알려 줍니다.
- **`created_at` / `updated_at`은 타임스탬프 데코레이터로 출력됩니다.** 그 데코레이터가 대신 맡게 되는 DB 기본값과 `ON UPDATE`는 말없이 사라지지 않고 NOTE로 남습니다.
- **FK 컬럼 `profile_id`는 `@Column`이 아닙니다.** `@ManyToOne` + `@RelationColumn`으로 표현되며, FK 컬럼 자신의 이름·타입·null 허용 여부와 제약의 `ON DELETE SET NULL`까지 담깁니다.
- **UNIQUE 인덱스는 클래스 레벨 `@UniqueIndex`로 올라갑니다.** 원래 인덱스 이름도 보존됩니다. 외래 키 때문에 InnoDB가 스스로 만든 인덱스는 선언하지 않습니다. ORM이 외래 키를 만들 때 다시 생기기 때문입니다.

---

## 출력 스타일 선택

이 ORM은 엔티티를 선언하는 방법이 두 가지이고, 인트로스펙션은 둘 중 어느 쪽으로든 출력할 수 있습니다. 두 방식 모두 같은 메타데이터 브리지를 거치므로 생성되는 스키마는 동일합니다. 달라지는 건 표기법뿐입니다.

```bash
npx stingerloom introspect --style decorator    # 기본값
npx stingerloom introspect --style code-first
```

```typescript
await runIntrospect(dbOptions, {
  outputDir: "./src/entities",
  codeBuilderOptions: { style: "code-first" },
});
```

같은 `posts` 테이블을 두 스타일로 출력하면 다음과 같습니다.

```typescript
// --style decorator
import { Column, Entity, ManyToOne, PrimaryGeneratedColumn, RelationColumn, type Relation } from "@stingerloom/orm";
import { User } from "./user.entity.js";

@Entity({ name: "posts" })
export class Post {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 200 })
  title!: string;

  @ManyToOne(() => User, (entity: any) => entity.author, { onDelete: "CASCADE" })
  @RelationColumn({ name: "author_id", type: "int", nullable: false, referencedColumn: "id" })
  author!: Relation<User>;
}
```

```typescript
// --style code-first
import { defineEntity, t, type InferEntity, type AnyEntityClass } from "@stingerloom/orm";
import { User } from "./user.entity.js";

export const Post = defineEntity(
  "posts",
  {
    id: t.int().primary().generated(),
    title: t.varchar(200),
    author: t.manyToOne<User>((): AnyEntityClass => User, {
      relationColumn: { name: "author_id", type: "int", nullable: false, referencedColumn: "id" },
      onDelete: "CASCADE",
    }),
  },
);

export interface Post extends InferEntity<typeof Post> {}
```

빌드에 `experimentalDecorators` / `emitDecoratorMetadata`를 넣고 싶지 않거나, 행 타입을 직접 쓰는 대신 추론(`InferEntity`)받고 싶다면 `code-first`를 고르세요. 코드베이스의 나머지가 데코레이터 기반이라면 `decorator`가 자연스럽습니다.

code-first 출력에는 빠지면 안 되는 부분이 두 가지 있습니다.

- 관계 대상 thunk에 타입을 명시합니다(`(): AnyEntityClass => User`). 이 명시가 없으면 서로를 참조하는 두 엔티티가 둘 다 타입을 추론받지 못합니다(TS7022).
- 행 타입은 `type` 별칭이 아니라 인터페이스 병합(`export interface Post extends InferEntity<typeof Post> {}`)으로 선언합니다. 인터페이스는 멤버를 지연 해석하기 때문에 자기참조 테이블(`parent_id` FK)이 순환 타입이 되지 않습니다. 이 경우에는 shape 타입 인자도 생략합니다: `t.manyToOne((): AnyEntityClass => Department, …)`.

데코레이터 스타일만 표현할 수 있는 것도 하나 있습니다. `NOT NULL`인 바이너리 컬럼입니다. `t.blob()` 컬럼은 항상 nullable로 만들어지므로, code-first 출력에서는 그런 컬럼에 NOTE를 붙입니다.

---

## 라운드 트립 안정성

인트로스펙션 출력은 결정론적입니다. 같은 DB 스키마로 두 번 실행하면 비트 단위로 같은 파일이 나옵니다. 그 출력물을 스키마로 적용하고 다시 인트로스펙트해도 같은 파일이 나옵니다.

이것은 가정이 아니라 검증된 성질입니다.

- **모든 ORM 컬럼 타입, 모든 방언.** 유닛 테스트가 ORM이 만들 수 있는 컬럼 타입을 하나씩 방언의 컬럼 정의 빌더로 렌더링하고 그 DDL을 다시 읽은 뒤, 타입 선택이 그 타입을 정확히 재현하는 타입에 도달하는지 확인합니다.
- **두 emitter, ORM 메타데이터 기준.** 유닛 테스트가 두 스타일로 생성한 파일을 타입 체크하고 실제로 로드한 다음, 컬럼마다 선언된 타입·null 허용·키·생성 여부·기본값·관계 컬럼·참조 동작·인덱스를 모델이 고른 값과 비교합니다. 한쪽 표기법만 옵션을 잘못 적거나, ORM이 `design:type`에서 옵션을 다르게 추론하는 경우를 그냥 넘기지 않습니다.
- **실제 데이터베이스.** 통합 테스트가 SQLite, PostgreSQL, MySQL, MariaDB에 일반 DDL로 스키마를 만들고, 두 스타일로 엔티티를 생성해 `synchronize`로 테이블을 다시 만듭니다. 다시 만든 스키마는 처음과 똑같이 읽혀야 하고, 거기서 생성한 파일도 처음 파일과 바이트 단위로 같아야 합니다.

이를 떠받치는 장치들:

| 장치 | 이유 |
|------|------|
| DB 컬럼명 ≠ 프로퍼티명이면 `name:`을 명시 | identity NamingStrategy에서 재적용 시 camelCase 컬럼이 만들어지는 것을 방지 |
| 타입에 영향을 주는 옵션(`type`, `length`, `precision` / `scale`, `enumValues`, `enumName`, `arrayElementType`)을 기본 키까지 전부 명시 | 데코레이터 메타데이터는 컴파일러 설정에 따라 달라집니다(`strictNullChecks`에서 `string \| null`은 `Object`). 추론에 맡긴 옵션은 컬럼을 그 설정에 묶어 버립니다 |
| `any` / `Buffer` 프로퍼티에는 `nullable: false`를 명시 | `@Column`은 그런 `design:type`을 기본적으로 nullable로 봅니다 |
| FK 관계는 컬럼 위치 순으로 정렬 | 카탈로그의 기본 정렬은 엔진마다 안정적이지 않습니다 |
| 클래스 레벨 인덱스는 일반 컬럼을 프로퍼티 이름으로, 조인 컬럼을 DB 컬럼 이름으로 지칭 | 모든 인덱스 선언 경로에서 올바른 컬럼으로 풀립니다 |
| 기본값은 방언별로 값 또는 식으로 해석 | 같은 리터럴을 MySQL은 따옴표 없이(`active`), MariaDB는 따옴표와 함께(`'active'`), PostgreSQL은 캐스트와 함께(`'active'::character varying`) 보여 줍니다. MySQL의 `CURRENT_TIMESTAMP` / `now()` / `current_timestamp()`는 같은 함수로 취급합니다 |
| 식은 바깥 괄호를 벗겨서 저장 | 카탈로그마다 괄호를 남기는지가 다르고, ORM이 정확히 한 쌍을 다시 붙입니다 |
| 기본 키는 절대 nullable로 출력하지 않음 | SQLite는 `INTEGER PRIMARY KEY`(rowid 별칭)를 `notnull = 0`으로 보고합니다 |
| 클래스 이름은 전역 객체나 import 이름을 피하고(`errors` → `ErrorEntity`), 두 테이블이 같은 클래스·파일을 쓰지 않음 | `design:type` 메타데이터가 `Error`, `Date` 등을 참조합니다. `user`와 `users`가 서로 덮어쓰는 일도 막습니다 |

덕분에 레거시 DB를 인트로스펙트해 엔티티를 커밋한 뒤, CI/CD가 스테이징 DB에 재적용해도 동일한 결과를 얻을 수 있습니다.

### 에코가 보존하지 못하는 것

원리상 왕복이 불가능한 것도 있습니다. 다만 어느 것도 말없이 사라지지는 않습니다. 제너레이터가 해당 필드(또는 엔티티) 위에 `// NOTE:` 주석을 달고, 같은 문장을 `GeneratedEntity.notes`로도 돌려줍니다.

| 상황 | 동작 |
|------|------|
| ORM이 만들 수 없는 타입(`smallint`, `int unsigned`, PostgreSQL `double precision`, `timestamp(3)`, `mediumtext`, `inet`, `interval` 등) | 가장 가까운 ORM 타입을 쓰고, NOTE에 DB가 선언한 표기와 엔티티가 만들 표기를 나란히 적습니다. 대응 타입이 전혀 없으면 어떤 값이든 텍스트로 담을 수 있는 `text`가 됩니다. [타입 매핑](#타입-매핑) 참고 |
| ORM이 어피니티를 바꾸게 되는 SQLite 선언(`DATETIME`, `DATE`, `JSON`, `DECIMAL`) | NOTE를 답니다. ORM은 `TEXT` / `REAL`로 선언하는데, 어피니티가 달라지면 일부 값이 다르게 저장됩니다(`'123'`은 TEXT에서는 텍스트로 남지만 `DATETIME`의 NUMERIC 어피니티에서는 정수가 됩니다). `BOOLEAN` → `INTEGER`는 어피니티가 같으므로 NOTE를 달지 않습니다 |
| 복합 외래 키 | 컬럼은 일반 컬럼으로 남기고, 마이그레이션으로 다시 만들어야 할 제약을 NOTE에 적습니다 |
| 생성 대상이 아닌 테이블(제외됐거나 다른 스키마에 있는)을 참조하는 외래 키 | 존재하지 않는 클래스를 import하게 될 관계 대신 일반 컬럼으로 남깁니다 |
| 기본 키가 아닌 컬럼을 참조하는 외래 키 | NOTE를 답니다. 스키마 생성은 항상 대상 테이블의 기본 키를 기준으로 제약을 만듭니다 |
| 부분·식·전문(FULLTEXT)·접두 길이·내림차순·`INCLUDE`·btree가 아닌 인덱스 | 선언하지 않습니다. 그 부분을 빼고 다시 만들면 다른 인덱스(심지어 더 넓은 UNIQUE)가 되기 때문입니다. NOTE에 정의를 적습니다 |
| 생성(계산) 컬럼 | 일반 컬럼으로 출력하고 NOTE를 답니다 |
| 타임스탬프 데코레이터가 대신 맡게 되는 기본값·`ON UPDATE` | NOTE를 답니다. 컬럼 값은 ORM이 채웁니다 |
| 단일 정수 기본 키가 아닌 identity 컬럼 | NOTE를 답니다 |
| 기본 키가 없는 테이블 | NOTE를 답니다 |
| 컬럼 순서 | 관계의 조인 컬럼은 테이블의 다른 컬럼 뒤에 만들어집니다 |
| 외래 키와 단일 컬럼 프로퍼티 인덱스의 제약·인덱스 이름 | ORM의 네이밍 전략으로 새로 정해집니다 |
| `@OneToMany`, `@OneToOne` | 단방향 FK 인트로스펙션만으로는 알 수 없습니다 — [알려진 한계](#알려진-한계) 참고 |

---

## 타입 매핑

아래 표는 손으로 적은 것이 아니라, 각 방언의 컬럼 정의 빌더로 렌더링해 타입 선택이 실제로 내놓은 결과입니다. *생성 결과*는 생성된 엔티티가 선언하는 DDL입니다. **exact**는 DB 타입을 그대로 재현한다는 뜻이고, **equivalent**는 표기만 다르고 DB가 똑같이 다루는 경우, **NOTE**는 파일에 NOTE가 붙는 경우입니다.

### PostgreSQL

| DB 타입 | ORM `ColumnType` | 생성 결과 | |
|---------|------------------|-----------|---|
| `integer`, `serial` | `int` | `INTEGER` | exact |
| `bigint`, `bigserial` | `bigint` | `BIGINT` | exact |
| `smallint` | `int` | `INTEGER` | NOTE |
| `real` | `float` | `REAL` | exact |
| `double precision` | `float` | `REAL` | NOTE |
| `numeric(p,s)` | `double` + `precision` / `scale` | `NUMERIC(p, s)` | exact |
| `numeric`(제약 없음) | `double` | `NUMERIC(10, 2)` | NOTE |
| `boolean` | `boolean` | `BOOLEAN` | exact |
| `character varying(n)` | `varchar` + `length` | `VARCHAR(n)` | exact |
| `character varying`(길이 제한 없음) | `text` | `TEXT` | equivalent |
| `character(n)` | `char` + `length` | `CHAR(n)` | exact |
| `text` | `text` | `TEXT` | exact |
| `uuid` | `uuid` | `UUID` | exact |
| `bytea` | `blob` | `BYTEA` | exact |
| `json` / `jsonb` | `json` / `jsonb` | `JSON` / `JSONB` | exact |
| `date` | `date` | `DATE` | exact |
| `timestamp` | `datetime` | `TIMESTAMP` | exact |
| `timestamptz` | `timestamptz` | `TIMESTAMPTZ` | exact |
| `timestamp(3)` 등 기본값이 아닌 정밀도 | `datetime` / `timestamptz` | `TIMESTAMP` / `TIMESTAMPTZ` | NOTE |
| enum 타입 | `enum` + `enumValues` + `enumName` | 같은 이름의 타입 | exact |
| `integer[]`, `character varying(20)[]` 등 | `array` + `arrayElementType`(+ `length`) | `INTEGER[]`, `VARCHAR(20)[]` | exact |
| `time`, `interval`, `inet`, `money`, 도메인 등 | `text` | `TEXT` | NOTE |

identity 컬럼(`GENERATED … AS IDENTITY`)과 `serial` 컬럼은 DB가 값을 생성하는 컬럼으로 읽혀 `@PrimaryGeneratedColumn`이 됩니다. 64비트 키에는 `type: "bigint"`가 붙고, ORM은 이를 `BIGSERIAL`로 만듭니다.

### MySQL / MariaDB

| DB 타입 | ORM `ColumnType` | 생성 결과 | |
|---------|------------------|-----------|---|
| `int` | `int` | `INT` | exact |
| `bigint` | `bigint` | `BIGINT` | exact |
| `tinyint(1)` | `boolean` | `TINYINT(1)` | exact |
| `tinyint`, `smallint`, `mediumint` | `int` | `INT` | NOTE |
| `… unsigned` | `int` / `bigint` | `INT` / `BIGINT` | NOTE |
| `float` | `float` | `FLOAT` | exact |
| `double` | `float` | `FLOAT` | NOTE |
| `decimal(p,s)` | `double` + `precision` / `scale` | `DECIMAL(p, s)` | exact |
| `varchar(n)` / `char(n)` | `varchar` / `char` + `length` | `VARCHAR(n)` / `CHAR(n)` | exact |
| `text` / `longtext` | `text` / `longtext` | `TEXT` / `LONGTEXT` | exact |
| `tinytext` / `mediumtext` | `text` / `longtext` | `TEXT` / `LONGTEXT` | NOTE |
| `blob` | `blob` | `BLOB` | exact |
| `tinyblob`, `mediumblob`, `longblob`, `binary(n)`, `varbinary(n)` | `blob` | `BLOB` | NOTE |
| `json`(MariaDB: `json_valid()` 체크가 붙은 `longtext`) | `json` | `JSON` | exact |
| `uuid`(MariaDB 10.7+) | `uuid` | MariaDB 10.7+에서 `UUID`, 그 외 `CHAR(36)` | exact / NOTE |
| `date` | `date` | `DATE` | exact |
| `datetime` | `datetime` | `DATETIME` | exact |
| `timestamp` | `timestamp` | `TIMESTAMP` | exact |
| `datetime(n)`, `timestamp(n)` | `datetime` / `timestamp` | `DATETIME` / `TIMESTAMP` | NOTE |
| `enum('a','b',…)` | `enum` + `enumValues` | `ENUM('a','b',…)` | exact |
| `time`, `year`, `set(…)`, `bit(n)`, 공간 타입 | `text` | `TEXT` | NOTE |

리더가 서버 버전을 먼저 확인하기 때문에, MariaDB의 따옴표 붙은 기본값, `JSON` 별칭, 네이티브 `UUID`를 MariaDB가 뜻하는 대로 읽습니다.

### SQLite

| 선언 타입 | ORM `ColumnType` | 생성 결과 | |
|-----------|------------------|-----------|---|
| `INTEGER`, `INT` | `int` | `INTEGER` | exact |
| `BIGINT` | `bigint` | `BIGINT` | exact |
| `TINYINT`, `SMALLINT`, `BOOLEAN` | `int` / `boolean` | `INTEGER` | equivalent |
| `REAL`, `DOUBLE`, `FLOAT` | `float` | `REAL` | exact |
| `VARCHAR(n)`, `TEXT(n)` | `varchar` + `length` | `TEXT(n)` | exact |
| `CHAR(n)` | `char` + `length` | `TEXT(n)` | equivalent |
| `TEXT`, `CLOB`, `VARCHAR` | `text` | `TEXT` | exact / equivalent |
| `BLOB` | `blob` | `BLOB` | exact |
| `DECIMAL`, `NUMERIC` | `double` | `REAL` | NOTE |
| `DATETIME`, `TIMESTAMP`, `DATE` | `datetime` / `date` | `TEXT` | NOTE |
| `JSON`, `UUID` | `json` / `uuid` | `TEXT` / `VARCHAR(36)` | NOTE |
| 선언 타입 없음, 모르는 이름 | SQLite 어피니티 규칙을 따르고, 맞는 것이 없으면 `text` | | NOTE |

단일 컬럼 `INTEGER PRIMARY KEY`(`INT PRIMARY KEY`가 아니고, `WITHOUT ROWID` 테이블도 아닌 경우)는 SQLite의 rowid 별칭이라 `@PrimaryGeneratedColumn`이 됩니다. 이 ORM이 만든 DB는 그대로 다시 읽히므로, 루프는 두 번째 세대부터 안정됩니다.

---

## 외래 키 감지

제너레이터가 함께 생성 중인 테이블을 가리키는 단일 컬럼 외래 키를 발견하면:

1. **FK 컬럼은 `@Column`으로 출력하지 않습니다**(관계가 대신 표현합니다).
2. **참조 대상 테이블을 가리키는 `@ManyToOne` + `@RelationColumn` 쌍을 출력합니다.** 제약의 `onDelete` / `onUpdate`가 `NO ACTION`이 아니면 함께 적습니다.
3. **관계는 FK 컬럼의 위치 순으로 정렬합니다.** 그래서 출력이 결정론적입니다.

```typescript
@ManyToOne(() => User, (entity: any) => entity.author, { onDelete: "CASCADE" })
@RelationColumn({ name: "author_id", type: "int", nullable: false, referencedColumn: "id" })
author!: Relation<User>;
```

`@RelationColumn`은 FK 컬럼 자신의 `type`과 `nullable`을 대상 PK에서 추론하게 두지 않고 직접 적습니다. 그 추론은 컬럼을 기본적으로 nullable로 만들기 때문에, 원본 스키마의 `NOT NULL`이 소리 없이 사라집니다. 조인 컬럼의 길이는 참조하는 기본 키에서 가져오는데, 그 때문에 컬럼이 달라지는 경우(자기 길이를 가진 `varchar` FK 등)에는 관계에 NOTE를 답니다.

MySQL에서는 `RESTRICT`를 `NO ACTION`으로 읽습니다. InnoDB는 둘 다 즉시 검사하고, MariaDB는 둘 다 지정하지 않은 키를 `RESTRICT`로 보고하기 때문입니다.

프로퍼티 이름은 FK 컬럼에서 이렇게 만듭니다.

- `_id` 접미사 제거: `author_id` → `author`
- `id_` 접두사 제거: `id_ancestor` → `ancestor`
- 그 외에는 컬럼명을 camelCase로: `parentRef` → `parentRef`

만든 이름이 다른 프로퍼티와 겹치면(예: FK 컬럼이 `user_id`인데 `user`라는 텍스트 컬럼이 이미 있는 경우) FK 컬럼 전체를 camelCase로 바꾼 이름(`userId`)을 쓰고, 그래도 겹치면 숫자 접미사를 붙입니다.

복합 외래 키, 다른 스키마를 가리키는 외래 키, 생성 대상이 아닌 테이블을 가리키는 외래 키는 일반 컬럼으로 남기고 NOTE를 답니다([에코가 보존하지 못하는 것](#에코가-보존하지-못하는-것) 참고).

### 자기참조 FK

FK가 같은 테이블을 가리키면 관계는 출력하되 **클래스를 import하지 않습니다**.

```typescript
@Entity({ name: "department" })
export class Department {
  @PrimaryGeneratedColumn({ name: "DEPT_SQ" })
  deptSq!: number;

  @ManyToOne(() => Department, (entity: any) => entity.upperDeptSq)
  @RelationColumn({ name: "UPPER_DEPT_SQ", type: "int", nullable: true, referencedColumn: "DEPT_SQ" })
  upperDeptSq!: Relation<Department>;
}
```

### 복합 PK 클로저 테이블

FK 컬럼이 기본 키의 일부이기도 하면(클로저 테이블이나 복합 PK 조인 테이블에서 흔합니다) `@PrimaryColumn` 선언과 관계를 **둘 다** 출력합니다.

```typescript
@Entity({ name: "post_comment_closure" })
export class PostCommentClosure {
  @PrimaryColumn({ type: "int", name: "id_ancestor" })
  idAncestor!: number;

  @PrimaryColumn({ type: "int", name: "id_descendant" })
  idDescendant!: number;

  @ManyToOne(() => PostComment, (entity: any) => entity.ancestor)
  @RelationColumn({ name: "id_ancestor", type: "int", nullable: false, referencedColumn: "id" })
  ancestor!: Relation<PostComment>;

  @ManyToOne(() => PostComment, (entity: any) => entity.descendant)
  @RelationColumn({ name: "id_descendant", type: "int", nullable: false, referencedColumn: "id" })
  descendant!: Relation<PostComment>;
}
```

---

## 인덱스 감지

제너레이터는 PK가 아닌 모든 인덱스를 읽습니다 — `INFORMATION_SCHEMA.STATISTICS`(MySQL), `pg_index`(PostgreSQL), `PRAGMA index_list` + `PRAGMA index_xinfo`(SQLite). 그리고 이렇게 분류합니다.

| 인덱스 종류 | 출력 형태 |
|------------|----------|
| 일반 컬럼 하나에 대한 비-UNIQUE 인덱스 | 프로퍼티 레벨 `@Index()` |
| 단일 컬럼 UNIQUE | 클래스 레벨 `@UniqueIndex([col], name)` |
| 다중 컬럼 비-UNIQUE, 또는 관계의 조인 컬럼에 걸린 인덱스 | 클래스 레벨 `@Index([col1, col2], name)` |
| 다중 컬럼 UNIQUE | 클래스 레벨 `@UniqueIndex([col1, col2], name)` |
| 부분·식·전문·접두 길이·내림차순·`INCLUDE`·btree가 아닌 인덱스 | 선언하지 않고, NOTE에 정의를 적습니다 |

기본 키를 정확히 덮는 인덱스는 제외합니다(`@PrimaryColumn` / `@PrimaryGeneratedColumn`이 이미 처리합니다). MySQL에서는 외래 키 컬럼을 정확히 덮는 비-UNIQUE 인덱스도 제외합니다. InnoDB가 외래 키마다 스스로 하나씩 만들기 때문입니다. PostgreSQL과 SQLite는 그렇게 하지 않으므로, 두 DB에서는 그런 인덱스가 스키마 작성자가 직접 만든 것이라 그대로 유지합니다.

클래스 레벨 데코레이터는 일반 컬럼을 **프로퍼티 키**로, 관계의 조인 컬럼을 **DB 컬럼 이름**으로 가리킵니다. ORM은 둘 다 올바른 컬럼으로 풉니다.

---

## 타임스탬프 데코레이터 휴리스틱

표준 타임스탬프 이름과 일치하고 타입·null 허용 조건까지 맞는 컬럼은 일반 `@Column` 대신 타임스탬프 데코레이터로 출력합니다.

| 프로퍼티명 | 컬럼 타입 | nullable | 데코레이터 |
|-----------|----------|----------|-----------|
| `createdAt` | datetime/timestamp/timestamptz/date | 아니오 | `@CreateTimestamp({ name?, type? })` |
| `updatedAt` | datetime/timestamp/timestamptz/date | 아니오 | `@UpdateTimestamp({ name?, type? })` |
| `deletedAt` | datetime/timestamp/timestamptz/date | 예 | `@DeletedAt({ name?, type? })` |

DB 컬럼명이 프로퍼티명과 다르면 `name:`을, 타입이 기본값 `datetime`이 아니면 `type:`을 출력합니다. 이 데코레이터들에는 `default` 옵션이 없습니다. 그래서 컬럼에 DB 기본값(보통 `CURRENT_TIMESTAMP`)이나 `ON UPDATE`가 있으면 ORM이 값을 직접 채우고, 엔티티가 더는 선언하지 않는 DB 절이 무엇인지 NOTE로 알려 줍니다. 휴리스틱에 맞지 않는 컬럼(`upload_date`, `published_at` 등)은 원래 기본값을 보존한 일반 `@Column`으로 출력합니다.

---

## 기본값 보존

방언별 리더가 기본값을 값 또는 식으로 해석하고, 낮추기 단계에서 `@Column({ default: … })`로 적습니다. 괄호로 감싼 문자열은 SQL 원문으로, 나머지는 값으로 취급됩니다.

| DB 기본값 | 출력 |
|-----------|------|
| `'active'`(SQLite, MariaDB), `active`(MySQL), `'active'::character varying`(PostgreSQL) | `default: "active"` |
| 숫자 컬럼의 `0`, `-1`, `'-1'::integer` | `default: 0`, `default: -1` |
| `true` / `false`, 불리언 컬럼의 `0` / `1` | `default: true` / `default: false` |
| `CURRENT_TIMESTAMP`, `now()`, `gen_random_uuid()`, `(datetime('now'))` | `default: "(CURRENT_TIMESTAMP)"` — 카탈로그가 괄호를 몇 겹 남겼든 정확히 한 쌍 |
| MySQL `_utf8mb4'[]'`(TEXT / BLOB / JSON의 리터럴 기본값) | `default: "('[]')"` — MySQL은 이 타입들에 다른 형태를 받지 않습니다 |
| `Number.MAX_SAFE_INTEGER`를 넘는 정수 | 자릿수를 잃지 않도록 문자열로 |
| `nextval('seq'::regclass)`, `AUTO_INCREMENT` | 생략 — `@PrimaryGeneratedColumn`이 담당합니다(그 밖의 위치에서는 NOTE) |
| `NULL` | 생략 — 기본값이 없는 것과 같습니다 |
| `(`로 시작하고 `)`로 끝나는 문자열 리터럴 | 선언하지 않고 NOTE — ORM이 SQL로 읽기 때문입니다 |

---

## 옵션 레퍼런스

### `IntrospectionGeneratorOptions`

| 옵션 | 타입 | 설명 |
|------|------|------|
| `schema` | `string` | PostgreSQL 스키마. 기본값: `"public"` |
| `includeTables` | `string[]` | 생성할 테이블 화이트리스트 |
| `excludeTables` | `string[]` | 건너뛸 테이블 블랙리스트 |
| `codeBuilderOptions` | `EntityCodeBuilderOptions` | `EntityCodeBuilder`로 전달 |

### `EntityCodeBuilderOptions`

| 옵션 | 타입 | 기본값 |
|------|------|--------|
| `importPath` | `string` | `"@stingerloom/orm"` |
| `style` | `"decorator" \| "code-first"` | `"decorator"` |

---

## API 레퍼런스

### `IntrospectionGenerator`

| 메서드 | 시그니처 | 설명 |
|--------|---------|------|
| `constructor` | `(queryFn, dialect, options?)` | 쿼리 함수, 방언(`"postgres"` / `"mysql"` / `"sqlite"`), 옵션으로 생성 |
| `generate()` | `(): Promise<GeneratedEntity[]>` | 조건에 맞는 모든 테이블의 엔티티 파일 생성 |
| `readSchema()` | `(): Promise<SchemaIR>` | 조건에 맞는 테이블을 스키마 IR로 |
| `readTable(table)` | `(table: string): Promise<TableIR>` | 테이블 하나를 스키마 IR로 |
| `discoverTables()` | `(): Promise<string[]>` | 모든 사용자 테이블(뷰 제외), 이름순 |
| `getColumns(table)` | `(table: string): Promise<DbColumn[]>` | **Deprecated** — `readTable()`을 쓰세요. IR에서 만든 컬럼 행 |
| `getPrimaryKeys(table)` | `(table: string): Promise<string[]>` | **Deprecated** — `readTable()`(`primaryKey`) |
| `getForeignKeys(table)` | `(table: string): Promise<DbForeignKey[]>` | **Deprecated** — `readTable()`(`foreignKeys`). 컬럼당 한 행이며, 복합 키의 행들은 `constraint_name`을 공유 |
| `getIndexes(table)` | `(table: string): Promise<DbIndex[]>` | **Deprecated** — `readTable()`(`indexes`) |

`GeneratedEntity`는 `{ tableName, className, fileName, code, notes }`입니다. `notes`에는 파일에 달린 `// NOTE:`가 모두 들어 있고, 필드에 달린 것은 앞에 프로퍼티 이름이 붙습니다.

### 스키마 IR

`@stingerloom/orm/introspection`에서 export합니다.

| 타입 | 형태 |
|------|------|
| `SchemaIR` | `{ dialect, schema?, tables: TableIR[] }` |
| `TableIR` | `{ name, columns: ColumnIR[], primaryKey: string[], foreignKeys: ForeignKeyIR[], indexes: IndexIR[] }` |
| `ColumnIR` | `{ name, type: CanonicalType, nullable, default?: DefaultValue, identity, generatedExpression?, onUpdate?, nativeType, rawDefault? }` |
| `CanonicalType` | `kind`로 구분하는 유니온: `integer`(`bytes`, `unsigned`), `boolean`, `decimal`(`precision`, `scale`), `float`(`bytes`), `string`(`fixed`, `length`), `text`(`size`), `binary`, `blob`, `uuid`, `json`(`binary`), `date`, `time`, `timestamp`(`zone: "local" \| "instant"`, `precision`), `enum`(`values`, `name`), `array`(`element`), `other`(`native`) |
| `DefaultValue` | `string` / `number`(텍스트로 보관) / `boolean` / `null` / `expression`(`sql`) / `sequence` |
| `ForeignKeyIR` | `{ name?, columns, referencedTable, referencedSchema?, referencedColumns, onDelete, onUpdate }` |
| `IndexIR` | `{ name, unique, columns, unsupported: string[] }` — `unsupported`는 인덱스에 일반 컬럼 목록 이상으로 무엇이 있는지 설명합니다 |

### `runIntrospect(dbOptions, cliOptions?)`

`DatabaseClient`로 접속하고, 제너레이터를 실행한 뒤, 디스크에 파일을 씁니다(`dryRun`이 아닐 때). `{ writtenFiles, entities }`를 반환합니다.

### `IntrospectionTypeMapper`

예전 타입 표로, 직접 쓰던 코드를 위해 그대로 남겨 두었습니다. 제너레이터는 더 이상 `toColumnType()`이나 `hasMapping()`을 참조하지 않습니다(둘 다 deprecated). [타입 매핑](#타입-매핑)을 참고하세요.

| 메서드 | 시그니처 | 설명 |
|--------|---------|------|
| `toColumnType(dbType, dialect, columnTypeFull?)` | `(...): ColumnType` | **Deprecated.** 예전 표로 DB 타입을 매핑 |
| `hasMapping(dbType, dialect)` | `(...): boolean` | **Deprecated.** 예전 표에 해당 타입이 있는지 |
| `toTsType(columnType)` | `(columnType: ColumnType): string` | ORM `ColumnType` → TypeScript 타입 문자열 |
| `parseSqliteWidth(declaredType)` | `(declaredType: string): number \| null` | `VARCHAR(N)` 등에서 `N` 추출 |
| `parseSqlitePrecisionScale(declaredType)` | `(declaredType: string): { precision, scale } \| null` | `DECIMAL(P, S)`에서 `(P, S)` 추출 |

### `EntityCodeBuilder`

| 메서드 | 시그니처 | 설명 |
|--------|---------|------|
| `constructor` | `(options?: EntityCodeBuilderOptions)` | import 경로와 출력 스타일을 선택적으로 받는 빌더 |
| `build(table, columns, pks, fks, dialect, indexes?, context?)` | `(...): string` | `DbColumn` 행으로부터 제너레이터와 같은 파이프라인을 거쳐 엔티티 소스를 생성. `context.primaryKeysByTable`을 주면 기본 키가 아닌 컬럼을 참조하는 FK에 NOTE를 답니다 |
| `emit(model)` | `(model: EntityModel): string` | 이미 낮춘 모델을 이 빌더의 스타일로 출력 |
| `tableNameToClassName(table)` | `(string): string` | snake_case 테이블 → PascalCase 클래스 |
| `classNameToFileName(className)` | `(string): string` | PascalCase 클래스 → kebab-case 파일명 |

### `DbColumn`

`EntityCodeBuilder.build()`가 받고, deprecated된 `getColumns()`가 돌려주는 행 형태입니다. 각 필드는 지정한 방언의 카탈로그가 뜻하는 대로 해석됩니다.

| 프로퍼티 | 타입 | 설명 |
|----------|------|------|
| `column_name` | `string` | 컬럼명 |
| `data_type` | `string` | DB 네이티브 타입명 |
| `is_nullable` | `string` | `"YES"` 또는 `"NO"` |
| `character_maximum_length` | `number \| null` | char/varchar의 최대 길이 |
| `numeric_precision` | `number \| null` | decimal/numeric의 정밀도 |
| `numeric_scale` | `number \| null` | decimal/numeric의 스케일 |
| `column_default` | `string \| null` | DB의 기본값 식 |
| `column_type` | `string \| null` | 폭까지 포함한 전체 선언 타입(MySQL `COLUMN_TYPE`, 예: `tinyint(1)`) |
| `is_identity` | `string \| null` | PG의 `GENERATED AS IDENTITY`면 `"YES"` |
| `enum_values` | `string[] \| null` | enum 라벨(PG `pg_enum` 또는 MySQL 파싱 결과) |
| `udt_name` | `string \| null` | PostgreSQL enum 타입 이름, 또는 `integer[]`의 `_int4` |
| `extra` | `string \| null` | MySQL `EXTRA`(예: `auto_increment`) |

### `DbForeignKey`

| 프로퍼티 | 타입 | 설명 |
|----------|------|------|
| `column_name` | `string` | 현재 테이블의 FK 컬럼 |
| `referenced_table` | `string` | 대상 테이블 |
| `referenced_column` | `string` | 대상 컬럼 |
| `constraint_name` | `string \| undefined` | FK 제약 이름. 같은 이름을 가진 행들이 하나의 복합 키를 이룹니다 |

### `DbIndex`

| 프로퍼티 | 타입 | 설명 |
|----------|------|------|
| `name` | `string` | 인덱스명(`@Index`/`@UniqueIndex` 출력 시 보존) |
| `column_names` | `string[]` | 인덱스를 구성하는 컬럼(순서 유지) |
| `is_unique` | `boolean` | UNIQUE 인덱스 여부 |

---

## 알려진 한계

인트로스펙션은 DB 스키마에 명시된 정보만 추출합니다. 다음은 한 방향 FK 정보만으로는 도출할 수 없어서, 생성 후 직접 보강해야 합니다.

- **`@OneToMany` 인버스 컬렉션**(예: `User`에 `posts: Post[]`). 제너레이터는 `posts.author_id` FK의 소유 측면만 볼 수 있어서, 인버스 측 프로퍼티는 직접 추가해야 합니다.
- **`@OneToOne`과 `@ManyToOne`의 구분.** 모든 FK는 `@ManyToOne`으로 출력됩니다. FK 컬럼에 UNIQUE 제약이 있다면 직접 바꾸는 편이 좋습니다.
- **읽기 좋은 프로퍼티 별칭.** `CTGR_GRP_SQ` 같은 컬럼은 `ctgrGrpSq`로 camelCase 변환됩니다. `groupId`처럼 더 알아보기 쉬운 이름을 원하면 프로퍼티명을 바꾸고 `name:` 옵션은 `CTGR_GRP_SQ`를 가리키게 두세요.

엔티티가 테이블에 대해 표현하지 못하는 나머지는 [에코가 보존하지 못하는 것](#에코가-보존하지-못하는-것)에 정리돼 있고, 생성된 파일에도 NOTE로 표시됩니다.

`@ManyToOne(() => Entity, (entity: any) => entity.foo)`의 인버스 접근자는 `any`로 둔 placeholder입니다. 인버스 프로퍼티가 없어도 컴파일은 됩니다. `@OneToMany` 컬렉션을 추가한 뒤 placeholder를 실제 이름으로 바꾸세요.

---

## 다음 단계

- [데이터베이스 시딩](./seeding.md) — 생성 후 테이블에 초기 데이터 채우기
- [마이그레이션](./migrations.md) — 버전 관리되는 스키마 변경
- [엔티티 & 컬럼](./entities.md) — 생성된 엔티티 파일 커스터마이즈
- [관계](./relations.md) — OneToMany, ManyToMany 등 관계 추가
