# 데이터베이스 인트로스펙션

## 인트로스펙션이 필요한 이유

새 팀에 합류했다고 가정해 봅시다. 프로젝트의 데이터베이스에는 테이블 47개와 컬럼 수백 개가 있습니다. 그리고 외래 키가 이 테이블들을 모두 연결합니다. 이전 개발자는 ORM을 쓰지 않았습니다. 그래서 SQL은 모두 직접 작성한 것입니다. 맡은 일은 이 프로젝트를 Stingerloom ORM으로 옮기는 것입니다.

인트로스펙션이 없으면 pgAdmin이나 DBeaver를 열고 테이블 정의를 하나씩 살펴야 합니다. 그리고 엔티티 파일 47개를 직접 작성해야 합니다. 컬럼마다 타입, null 허용 여부, 길이, 기본값을 확인합니다. 외래 키마다 관계를 파악해서 `@ManyToOne` 데코레이터를 추가합니다. 이 일은 몇 시간이 걸리고 실수도 거의 틀림없이 생깁니다.

인트로스펙션을 쓰면 제너레이터를 데이터베이스에 연결하기만 하면 됩니다. 그러면 엔티티 파일 47개가 자동으로 생성됩니다. 출력할 표기법은 이 ORM의 두 엔티티 표기법 중에서 고릅니다. 하나는 데코레이터이고 다른 하나는 데코레이터 없는 `defineEntity` 빌더입니다([출력 스타일 선택](#출력-스타일-선택) 참고). 외래 키는 `@ManyToOne` + `@RelationColumn`이 되고 `ON DELETE` / `ON UPDATE` 동작도 함께 담깁니다. 고유 제약 조건은 `@UniqueIndex`가 됩니다. `created_at` / `updated_at` / `deleted_at` 컬럼은 타임스탬프 컬럼으로 인식해서 `@CreateTimestamp` / `@UpdateTimestamp` / `@DeletedAt`로 출력합니다. snake_case 컬럼 이름은 명시적인 `name:` 옵션으로 보존합니다. 그래서 생성된 엔티티는 **라운드 트립이 안정적**입니다. 이 엔티티를 빈 데이터베이스에 다시 적용하면 같은 스키마가 만들어진다는 뜻입니다.

테이블에는 있지만 엔티티로 표현할 수 *없는* 부분도 있습니다. ORM에 대응 타입이 없는 컬럼, 복합 외래 키, 부분 인덱스가 그 예입니다. 제너레이터는 이런 부분을 아무 표시 없이 다른 것으로 바꾸지 않습니다. 대신 생성된 파일의 해당 위치에 `// NOTE:` 주석을 남깁니다.

인트로스펙션은 스키마 동기화와 반대 방향으로 동작합니다. `synchronize: true`는 엔티티를 읽어 테이블을 생성합니다. 인트로스펙션은 테이블을 읽어 엔티티를 생성합니다.

---

## 동작 방식

데이터베이스마다 스키마를 설명하는 방식이 다릅니다. PostgreSQL은 타입을 `character varying(80)`으로 적고 기본값을 `'active'::character varying`으로 적습니다. MySQL은 같은 기본값을 따옴표 없이 `active`로 보여 줍니다. MariaDB는 `'active'`로 보여 줍니다. SQLite는 `CREATE TABLE`에 적힌 표기를 그대로 남겨 둡니다. 이 설명을 곧장 TypeScript로 옮기는 코드는 모든 단계에서 모든 표기를 알아야 합니다. 그리고 어느 한 단계가 표기 하나를 놓치면 미묘하게 틀린 엔티티가 나옵니다.

그래서 인트로스펙션은 작은 컴파일러처럼 동작합니다. 그 가운데에는 다이얼렉트에 중립적인 **스키마 IR**(중간 표현)이 있습니다.

```
                      읽기                        낮추기                        출력
 PostgreSQL 카탈로그 ─┐                ┌───────────────────────────┐
 MySQL 카탈로그  ─────┼──▶  스키마 IR ─┤ 이름, 관계, 인덱스           ├─▶ EntityModel ─┬─▶ @Entity 클래스
 SQLite 카탈로그 ─────┘   (의미 기준)  │ 컬럼별 ORM 타입               │               └─▶ defineEntity(...)
                                      └────────────┬──────────────┘
                                                   │ 검증
                          ORM이 그 타입으로 실제로 생성하는 DDL을 같은 다이얼렉트
                          리더로 다시 읽어 IR과 비교
```

1. **읽기.** 카탈로그 리더는 다이얼렉트마다 하나씩 있습니다. 리더는 데이터베이스의 테이블 설명을 IR로 옮깁니다. 각 컬럼에는 *정규 타입*(canonical type), 해석한 기본값, identity 여부가 담깁니다. 정규 타입은 표기가 아니라 의미를 기준으로 합니다. 예를 들어 MySQL `TIMESTAMP`와 PostgreSQL `timestamptz`는 둘 다 시점(instant)입니다. MySQL `DATETIME`과 PostgreSQL `timestamp`는 둘 다 벽시계 시각입니다. IR에는 기본 키, 외래 키, 인덱스도 담깁니다. 외래 키는 참조 동작과 함께 담습니다. 복합 외래 키는 나누지 않고 하나로 담습니다. 인덱스에 일반 컬럼 목록 말고 다른 내용이 있으면 그 내용도 담습니다. 다이얼렉트별 특이점은 모두 이 단계에서만 처리합니다.
2. **낮추기(lowering).** 각 테이블이 `EntityModel`이 됩니다. 모델에는 유효하고 서로 겹치지 않는 클래스 이름과 속성 이름이 들어갑니다. 단일 컬럼 외래 키마다 관계가 하나씩 들어가고 인덱스와 타임스탬프 마커도 들어갑니다. ORM 컬럼 타입은 손으로 관리하는 역방향 표에서 찾지 않습니다. 후보 ORM 타입을 다이얼렉트의 실제 컬럼 정의 빌더로 렌더링합니다. 이 빌더는 `synchronize`가 테이블을 생성할 때 쓰는 코드입니다. 렌더링한 DDL은 같은 리더로 다시 읽습니다. 그리고 컬럼 타입을 그대로 재현하는 첫 후보를 고릅니다. 그 후보가 재현하지 못하는 부분은 기록해 둡니다.
3. **출력.** 모델을 데코레이터 클래스나 `defineEntity` 빌더로 적습니다. 두 emitter는 모두 모델이 정한 옵션을 빠짐없이 출력합니다. 그래서 데코레이터 표기와 `defineEntity` 표기는 항상 같은 스키마를 선언합니다.

매핑은 ORM이 실제로 생성하는 DDL과 대조해 검증합니다. 그래서 매핑과 DDL이 어긋날 수 없습니다. ORM이 어떤 타입을 선언하는 방식이 바뀌면 타입 선택과 NOTE도 그에 맞춰 바뀝니다.

---

## 세 가지 사용 방식

### 1. CLI: `npx stingerloom introspect`

가장 간단한 방법입니다. CLI는 `stingerloom.config.ts`나 `ormconfig.ts`에 있는 데이터베이스 설정을 그대로 재사용합니다.

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
| `--config <path>` | 설정 파일 경로 명시. 기본값: 자동 감지 |

생성된 파일 중에 `// NOTE:`가 달린 파일이 있으면 CLI가 그 개수와 파일 이름을 로그로 남깁니다. 그래서 스키마가 커도 NOTE를 놓치지 않습니다.

### 2. `runIntrospect()`: 프로그래밍 방식 헬퍼

모든 과정을 직접 제어하려는 스크립트에서 씁니다. `runIntrospect`는 한 번의 호출로 `DatabaseClient` 연결, 제너레이터 실행, 파일 쓰기를 모두 처리합니다.

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
| `includeTables` | `string[]` | 없음 |
| `excludeTables` | `string[]` | 없음 |
| `codeBuilderOptions` | `EntityCodeBuilderOptions` | 없음 |
| `dryRun` | `boolean` | `false`. true면 파일을 쓰지 않고 엔티티만 반환 |

### 3. `IntrospectionGenerator`: 저수준 빌딩 블록

커스텀 쿼리 함수로 제너레이터를 실행할 때 씁니다. 코드를 생성하지 않고 스키마만 읽을 때도 씁니다.

```typescript
import { IntrospectionGenerator } from "@stingerloom/orm/introspection";

const generator = new IntrospectionGenerator(
  (q) => driver.query(q),         // 문자열과 `sql` 템플릿 태그 모두 허용
  "postgres",                      // "postgres" | "mysql" | "sqlite"
  { schema: "public", excludeTables: ["__migrations"] },
);

const entities = await generator.generate();

// 스키마 IR만 따로 조회합니다.
// IR은 다이얼렉트에 중립적인 구조적 스키마 설명입니다.
const schema = await generator.readSchema();   // 선택된 테이블 전체
const users = await generator.readTable("users");
users.columns[0];
// { name: "id", type: { kind: "integer", bytes: 4, unsigned: false },
//   nullable: false, identity: true, nativeType: "integer", ... }
```

---

## 생성되는 코드 모습

다음과 같은 MariaDB 스키마가 있다고 해 봅시다.

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

눈여겨볼 점은 다음과 같습니다.

- **`name:` 옵션이 데이터베이스 컬럼 이름을 보존합니다.** `access_key`와 `is_valid`가 그 예입니다. 이 옵션 덕분에 기본 네이밍 전략인 identity에서도 라운드 트립이 안정적입니다. 이 옵션이 없으면 엔티티를 적용했을 때 `access_key` 대신 `accessKey` 컬럼이 만들어집니다.
- **TINYINT(1)은 `boolean`으로 인식합니다.** 다른 폭의 TINYINT는 작은 정수입니다.
- **`INT UNSIGNED`에는 NOTE가 붙습니다.** ORM에는 부호 없는 정수 타입이 없습니다. 그래서 엔티티는 부호 있는 `INT`를 생성합니다. NOTE는 두 표기를 나란히 적어 이 차이를 알려 줍니다.
- **`created_at` / `updated_at`은 타임스탬프 데코레이터로 출력됩니다.** 이 데코레이터가 대신 맡는 데이터베이스 기본값과 `ON UPDATE`는 아무 표시 없이 사라지지 않고 NOTE로 남습니다.
- **외래 키 컬럼 `profile_id`는 `@Column`이 아닙니다.** 이 컬럼은 `@ManyToOne` + `@RelationColumn`으로 표현합니다. 여기에는 외래 키 컬럼 자신의 이름, 타입, null 허용 여부가 담깁니다. 제약 조건의 `ON DELETE SET NULL`도 담깁니다.
- **고유 인덱스는 클래스 레벨 `@UniqueIndex`로 올라갑니다.** 원래 인덱스 이름도 보존합니다. InnoDB가 외래 키 때문에 스스로 생성한 인덱스는 선언하지 않습니다. ORM이 외래 키를 생성하면 이 인덱스도 다시 생기기 때문입니다.

---

## 출력 스타일 선택

이 ORM에는 엔티티를 선언하는 동등한 방법이 두 가지 있습니다. 인트로스펙션은 둘 중 어느 방법으로든 출력할 수 있습니다. 두 방법은 모두 같은 메타데이터 브리지를 거칩니다. 그래서 생성되는 스키마는 같고 표기법만 다릅니다.

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

빌드에 `experimentalDecorators` / `emitDecoratorMetadata`를 넣고 싶지 않으면 `code-first`를 고르세요. 행 타입을 직접 쓰지 않고 `InferEntity`로 추론받고 싶을 때도 `code-first`가 맞습니다. 코드베이스의 나머지가 데코레이터 기반이면 `decorator`를 고르세요.

code-first 출력에는 빠지면 안 되는 부분이 두 가지 있습니다.

- 관계 대상 thunk에는 `(): AnyEntityClass => User`처럼 타입을 명시합니다. 이 타입이 없으면 서로 참조하는 두 엔티티가 모두 타입을 추론받을 수는 없습니다(TS7022).
- 행 타입은 `type` 별칭이 아니라 인터페이스 병합으로 선언합니다. `export interface Post extends InferEntity<typeof Post> {}`가 그 형태입니다. 인터페이스는 멤버를 지연 해석합니다. 그래서 `parent_id` 외래 키가 있는 자기 참조 테이블도 순환 타입이 되지 않습니다. 자기 참조 관계에서는 shape 타입 인자도 생략하고 `t.manyToOne((): AnyEntityClass => Department, …)`처럼 씁니다.

데코레이터 스타일만 표현할 수 있는 것도 하나 있습니다. `NOT NULL`인 바이너리 컬럼입니다. `t.blob()` 컬럼은 항상 nullable로 생성됩니다. 그래서 code-first 출력에서는 이런 컬럼에 NOTE를 붙입니다.

---

## 라운드 트립 안정성

인트로스펙션 출력은 결정론적입니다. 같은 데이터베이스 스키마에서 두 번 실행하면 비트 단위로 같은 파일이 나옵니다. 출력한 엔티티를 스키마로 적용하고 다시 인트로스펙션을 실행해도 같은 파일이 나옵니다.

이 성질은 가정한 것이 아니라 검증한 것입니다.

- **모든 ORM 컬럼 타입, 모든 다이얼렉트.** 유닛 테스트는 ORM이 생성할 수 있는 컬럼 타입을 하나씩 다이얼렉트의 컬럼 정의 빌더로 렌더링합니다. 그리고 그 DDL을 다시 읽습니다. 이때 타입 선택은 그 타입을 정확히 재현하는 타입에 도달해야 합니다.
- **두 emitter, ORM 메타데이터 기준.** 유닛 테스트는 두 스타일로 생성한 파일을 타입 체크하고 실제로 로드합니다. 그다음 컬럼마다 선언된 값을 모델이 고른 값과 비교합니다. 비교 항목은 타입, null 허용, 키, 생성 여부, 기본값, 관계 컬럼, 참조 동작, 인덱스입니다. 그래서 한쪽 표기법만 옵션을 잘못 적은 경우도 걸러집니다. ORM이 `design:type`에서 옵션을 다르게 추론한 경우도 걸러집니다.
- **실제 데이터베이스.** 통합 테스트는 SQLite, PostgreSQL, MySQL, MariaDB에서 일반 DDL로 스키마를 생성합니다. 그리고 두 스타일로 엔티티를 생성한 뒤 `synchronize`로 테이블을 다시 생성합니다. 다시 생성한 스키마는 처음과 똑같이 읽혀야 합니다. 거기서 생성한 파일도 처음 파일과 바이트 단위로 같아야 합니다.

이 성질을 뒷받침하는 장치는 다음과 같습니다.

| 장치 | 이유 |
|------|------|
| 데이터베이스 컬럼 이름 ≠ 속성 이름이면 `name:`을 명시 | identity 네이밍 전략으로 다시 적용할 때 camelCase 컬럼이 생성되지 않게 함 |
| 타입에 영향을 주는 옵션(`type`, `length`, `precision` / `scale`, `enumValues`, `enumName`, `arrayElementType`)을 기본 키까지 전부 명시 | 데코레이터 메타데이터는 컴파일러 설정에 따라 달라집니다. 예를 들어 `strictNullChecks`에서 `string \| null`은 `Object`입니다. 추론에 맡긴 옵션은 컬럼을 그 설정에 묶어 버립니다 |
| `any` / `Buffer` 속성에는 `nullable: false`를 명시 | `@Column`은 그런 `design:type`을 기본적으로 nullable로 봅니다 |
| 외래 키 관계는 컬럼 위치 순으로 정렬 | 카탈로그 순서는 엔진마다 일정하지 않습니다 |
| 클래스 레벨 인덱스에서 일반 컬럼은 속성 이름으로, 조인 컬럼은 데이터베이스 컬럼 이름으로 지칭 | 모든 인덱스 선언 경로에서 올바른 컬럼으로 풀립니다 |
| 기본값은 다이얼렉트별로 값이나 식으로 해석 | MySQL은 리터럴을 따옴표 없이 `active`로 보여 줍니다. MariaDB는 따옴표를 붙여 `'active'`로 보여 줍니다. PostgreSQL은 캐스트를 붙여 `'active'::character varying`으로 보여 줍니다. MySQL의 `CURRENT_TIMESTAMP` / `now()` / `current_timestamp()`는 같은 함수로 취급합니다 |
| 식은 바깥 괄호를 벗겨서 저장 | 괄호를 남기는지는 카탈로그마다 다릅니다. ORM은 괄호를 정확히 한 쌍 다시 붙입니다 |
| 기본 키는 절대 nullable로 출력하지 않음 | SQLite는 rowid 별칭인 `INTEGER PRIMARY KEY`를 `notnull = 0`으로 보고합니다 |
| 클래스 이름은 전역 객체나 import한 이름을 피함(`errors` → `ErrorEntity`). 두 테이블이 같은 클래스나 파일을 쓰지 않음 | `design:type` 메타데이터가 `Error`, `Date` 등을 참조합니다. `user`와 `users`가 서로 덮어쓰는 일도 막습니다 |

이 장치들이 결과를 보장합니다. 레거시 데이터베이스를 인트로스펙션해 엔티티를 커밋해 두면 CI/CD가 이 엔티티를 스테이징 데이터베이스에 다시 적용해도 결과가 같습니다.

### 라운드 트립에서 보존되지 않는 항목

라운드 트립을 거치면 원리상 보존되지 않는 것도 있습니다. 다만 어느 것도 아무 표시 없이 사라지지는 않습니다. 제너레이터는 해당 필드나 엔티티 위에 `// NOTE:` 주석을 답니다. 그리고 같은 문장을 `GeneratedEntity.notes`로도 반환합니다.

| 상황 | 동작 |
|------|------|
| ORM이 생성할 수 없는 타입(`smallint`, `int unsigned`, `timestamp(3)`, `mediumtext`, `inet`, `interval` 등) | 가장 가까운 ORM 타입을 씁니다. NOTE에는 데이터베이스가 선언한 표기와 엔티티가 생성할 표기를 나란히 적습니다. 대응 타입이 전혀 없으면 `text`가 됩니다. `text`는 어떤 값이든 텍스트 형태로 담습니다. [타입 매핑](#타입-매핑) 참고 |
| ORM이 어피니티를 바꾸게 되는 SQLite 선언(`DATETIME`, `DATE`, `JSON`) | NOTE를 답니다. ORM은 이 컬럼을 `TEXT`로 선언합니다. 어피니티가 달라지면 일부 값이 다르게 저장됩니다. 예를 들어 `'123'`은 TEXT 어피니티에서는 텍스트로 남습니다. 하지만 `DATETIME`의 NUMERIC 어피니티에서는 정수가 됩니다. `BOOLEAN` → `INTEGER`는 어피니티가 같으므로 NOTE를 달지 않습니다 |
| 복합 외래 키 | 컬럼은 일반 컬럼으로 남깁니다. 마이그레이션으로 다시 생성해야 할 제약 조건은 NOTE에 적습니다 |
| 생성 대상이 아닌 테이블을 참조하는 외래 키(제외한 테이블, 다른 스키마의 테이블) | 관계로 출력하면 존재하지 않는 클래스를 import하게 됩니다. 그래서 일반 컬럼으로 남깁니다 |
| 기본 키가 아닌 컬럼을 참조하는 외래 키 | NOTE를 답니다. 스키마 생성은 항상 대상 테이블의 기본 키를 기준으로 제약 조건을 생성합니다 |
| 부분·식·전문(FULLTEXT)·접두 길이·내림차순·`INCLUDE`·btree가 아닌 인덱스 | 선언하지 않습니다. 그 부분을 빼고 다시 생성하면 다른 인덱스가 되기 때문입니다. 범위가 더 넓은 고유 인덱스가 될 수도 있습니다. NOTE에 정의를 적습니다 |
| 생성(계산) 컬럼 | 일반 컬럼으로 출력하고 NOTE를 답니다 |
| 타임스탬프 데코레이터가 대신 맡는 기본값·`ON UPDATE` | NOTE를 답니다. 컬럼 값은 ORM이 채웁니다 |
| 단일 정수 기본 키가 아닌 identity 컬럼 | NOTE를 답니다 |
| 기본 키가 없는 테이블 | NOTE를 답니다 |
| 컬럼 순서 | 관계의 조인 컬럼은 테이블의 다른 컬럼 뒤에 생성됩니다 |
| 외래 키와 단일 컬럼 속성 인덱스의 제약 조건·인덱스 이름 | ORM의 네이밍 전략으로 새로 정해집니다 |
| `@OneToMany`, `@OneToOne` | 한쪽 외래 키만 보는 인트로스펙션으로는 알 수 없습니다. [알려진 한계](#알려진-한계) 참고 |

---

## 타입 매핑

아래 표는 손으로 적은 것이 아닙니다. 각 다이얼렉트의 컬럼 정의 빌더로 렌더링해서 타입 선택이 실제로 내놓은 결과입니다. *생성 결과*는 생성된 엔티티가 선언하는 DDL입니다. **exact**는 데이터베이스 타입을 그대로 재현한다는 뜻입니다. **equivalent**는 표기만 다르고 데이터베이스는 똑같이 다룬다는 뜻입니다. **NOTE**는 파일에 NOTE가 붙는다는 뜻입니다.

### PostgreSQL

| DB 타입 | ORM `ColumnType` | 생성 결과 | |
|---------|------------------|-----------|---|
| `integer`, `serial` | `int` | `INTEGER` | exact |
| `bigint`, `bigserial` | `bigint` | `BIGINT` | exact |
| `smallint` | `int` | `INTEGER` | NOTE |
| `real` | `float` | `REAL` | exact |
| `double precision` | `double` | `DOUBLE PRECISION` | exact |
| `numeric(p,s)` | `decimal` + `precision` / `scale` | `NUMERIC(p, s)` | exact |
| `numeric`(제약 없음) | `decimal` | `NUMERIC(10, 2)` | NOTE |
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

identity 컬럼(`GENERATED … AS IDENTITY`)과 `serial` 컬럼은 데이터베이스가 값을 생성하는 컬럼으로 읽힙니다. 그래서 `@PrimaryGeneratedColumn`이 됩니다. 64비트 키에는 `type: "bigint"`가 붙습니다. ORM은 이 키를 `BIGSERIAL`로 생성합니다.

### MySQL / MariaDB

| DB 타입 | ORM `ColumnType` | 생성 결과 | |
|---------|------------------|-----------|---|
| `int` | `int` | `INT` | exact |
| `bigint` | `bigint` | `BIGINT` | exact |
| `tinyint(1)` | `boolean` | `TINYINT(1)` | exact |
| `tinyint`, `smallint`, `mediumint` | `int` | `INT` | NOTE |
| `… unsigned` | `int` / `bigint` | `INT` / `BIGINT` | NOTE |
| `float` | `float` | `FLOAT` | exact |
| `double` | `double` | `DOUBLE` | exact |
| `decimal(p,s)` | `decimal` + `precision` / `scale` | `DECIMAL(p, s)` | exact |
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

리더는 서버 버전을 먼저 확인합니다. 그래서 MariaDB의 따옴표 붙은 기본값, `JSON` 별칭, 네이티브 `UUID`를 MariaDB가 뜻하는 대로 읽습니다.

### SQLite

| 선언 타입 | ORM `ColumnType` | 생성 결과 | |
|-----------|------------------|-----------|---|
| `INTEGER`, `INT` | `int` | `INTEGER` | exact |
| `BIGINT` | `bigint` | `BIGINT` | exact |
| `TINYINT`, `SMALLINT`, `BOOLEAN` | `int` / `boolean` | `INTEGER` | equivalent |
| `REAL`, `DOUBLE`, `FLOAT` | `double` | `REAL` | exact |
| `VARCHAR(n)`, `TEXT(n)` | `varchar` + `length` | `TEXT(n)` | exact |
| `CHAR(n)` | `char` + `length` | `TEXT(n)` | equivalent |
| `TEXT`, `CLOB`, `VARCHAR` | `text` | `TEXT` | exact / equivalent |
| `BLOB` | `blob` | `BLOB` | exact |
| `DECIMAL(p,s)`, `NUMERIC(p,s)` | `decimal` + `precision` / `scale` | `NUMERIC(p, s)` | exact |
| `DECIMAL`, `NUMERIC`(정밀도 없음) | `decimal` | `NUMERIC(10, 2)` | equivalent |
| `DATETIME`, `TIMESTAMP`, `DATE` | `datetime` / `date` | `TEXT` | NOTE |
| `JSON`, `UUID` | `json` / `uuid` | `TEXT` / `VARCHAR(36)` | NOTE |
| 선언 타입 없음, 모르는 이름 | SQLite 어피니티 규칙을 따름. 맞는 것이 없으면 `text` | | NOTE |

단일 컬럼 `INTEGER PRIMARY KEY`는 SQLite의 rowid 별칭입니다. 그래서 `@PrimaryGeneratedColumn`이 됩니다. 다만 `INT PRIMARY KEY`와 `WITHOUT ROWID` 테이블의 기본 키는 여기에 해당하지 않습니다. 이 ORM이 생성한 데이터베이스는 그대로 다시 읽힙니다. 그래서 루프는 두 번째 세대부터 안정됩니다.

---

## 외래 키 감지

단일 컬럼 외래 키가 함께 생성 중인 테이블을 가리킬 때가 있습니다. 제너레이터는 이런 외래 키를 발견하면 다음과 같이 처리합니다.

1. **외래 키 컬럼은 `@Column`으로 출력하지 않습니다.** 관계가 이 컬럼을 대신 표현합니다.
2. **참조 대상 테이블을 가리키는 `@ManyToOne` + `@RelationColumn` 쌍을 출력합니다.** 제약 조건의 `onDelete` / `onUpdate`가 `NO ACTION`이 아니면 함께 적습니다.
3. **관계는 외래 키 컬럼이 테이블에 놓인 위치 순으로 정렬합니다.** 그래서 출력이 결정론적입니다.

```typescript
@ManyToOne(() => User, (entity: any) => entity.author, { onDelete: "CASCADE" })
@RelationColumn({ name: "author_id", type: "int", nullable: false, referencedColumn: "id" })
author!: Relation<User>;
```

`@RelationColumn`에는 외래 키 컬럼 자신의 `type`과 `nullable`을 직접 적습니다. 대상 기본 키에서 추론하게 두지 않습니다. 그 추론은 컬럼을 기본적으로 nullable로 만들기 때문입니다. 그러면 원본 스키마의 `NOT NULL`이 아무 표시 없이 사라집니다. 조인 컬럼의 길이는 참조하는 기본 키에서 가져옵니다. 그래서 길이 때문에 컬럼이 달라지면 관계에 NOTE를 답니다. 자기 길이를 가진 `varchar` 외래 키가 그 예입니다.

MySQL에서는 `RESTRICT`를 `NO ACTION`으로 읽습니다. InnoDB는 `RESTRICT`와 `NO ACTION`을 모두 즉시 검사하기 때문입니다. 게다가 MariaDB는 둘 다 지정하지 않은 키를 `RESTRICT`로 보고합니다.

속성 이름은 외래 키 컬럼 이름에서 이렇게 만듭니다.

- `_id` 접미사 제거: `author_id` → `author`
- `id_` 접두사 제거: `id_ancestor` → `ancestor`
- 그 밖에는 컬럼 이름을 camelCase로 변환: `parentRef` → `parentRef`

만든 이름이 다른 속성과 겹칠 때가 있습니다. 예를 들어 외래 키 컬럼이 `user_id`인데 `user`라는 텍스트 컬럼이 이미 있는 경우입니다. 이때는 외래 키 컬럼 이름 전체를 camelCase로 바꾼 `userId`로 넘어갑니다. 그래도 겹치면 숫자 접미사를 붙입니다.

복합 외래 키, 다른 스키마를 가리키는 외래 키, 생성 대상이 아닌 테이블을 가리키는 외래 키는 일반 컬럼으로 남기고 NOTE를 답니다([라운드 트립에서 보존되지 않는 항목](#라운드-트립에서-보존되지-않는-항목) 참고).

### 자기 참조 외래 키

외래 키가 같은 테이블을 가리키면 관계는 출력합니다. 하지만 클래스는 import하지 않습니다.

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

### 복합 기본 키 클로저 테이블

외래 키 컬럼이 기본 키의 일부이기도 하면 `@PrimaryColumn` 선언과 관계를 모두 출력합니다. 이런 구조는 클로저 테이블이나 복합 기본 키를 가진 조인 테이블에서 흔합니다.

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

제너레이터는 기본 키가 아닌 인덱스를 모두 읽습니다. MySQL에서는 `INFORMATION_SCHEMA.STATISTICS`를 읽고 PostgreSQL에서는 `pg_index`를 읽습니다. SQLite에서는 `PRAGMA index_list`와 `PRAGMA index_xinfo`를 읽습니다. 그리고 읽은 인덱스를 다음과 같이 분류합니다.

| 인덱스 종류 | 출력 형태 |
|------------|----------|
| 일반 컬럼 하나에 걸린 고유하지 않은 인덱스 | 속성 레벨 `@Index()` |
| 단일 컬럼 고유 인덱스 | 클래스 레벨 `@UniqueIndex([col], name)` |
| 고유하지 않은 다중 컬럼 인덱스, 또는 관계의 조인 컬럼에 걸린 인덱스 | 클래스 레벨 `@Index([col1, col2], name)` |
| 다중 컬럼 고유 인덱스 | 클래스 레벨 `@UniqueIndex([col1, col2], name)` |
| 부분·식·전문·접두 길이·내림차순·`INCLUDE`·btree가 아닌 인덱스 | 선언하지 않음. NOTE에 정의를 적습니다 |

기본 키를 정확히 덮는 인덱스는 제외합니다. `@PrimaryColumn` / `@PrimaryGeneratedColumn`이 이미 처리하기 때문입니다. MySQL에서는 외래 키 컬럼을 정확히 덮는 고유하지 않은 인덱스도 제외합니다. InnoDB가 외래 키마다 이런 인덱스를 스스로 하나씩 생성하기 때문입니다. PostgreSQL과 SQLite는 이런 인덱스를 생성하지 않습니다. 그래서 PostgreSQL과 SQLite에서 이런 인덱스는 스키마 작성자가 직접 생성한 것으로 보고 그대로 유지합니다.

클래스 레벨 데코레이터에서 일반 컬럼은 속성 키로 가리키고 관계의 조인 컬럼은 데이터베이스 컬럼 이름으로 가리킵니다. ORM은 어느 쪽이든 올바른 컬럼으로 풉니다.

---

## 타임스탬프 데코레이터 휴리스틱

표준 타임스탬프 이름과 일치하고 타입·null 허용 조건까지 맞는 컬럼은 일반 `@Column` 대신 타임스탬프 데코레이터로 출력합니다.

| 속성 이름 | 컬럼 타입 | nullable | 데코레이터 |
|-----------|----------|----------|-----------|
| `createdAt` | datetime/timestamp/timestamptz/date | 아니오 | `@CreateTimestamp({ name?, type? })` |
| `updatedAt` | datetime/timestamp/timestamptz/date | 아니오 | `@UpdateTimestamp({ name?, type? })` |
| `deletedAt` | datetime/timestamp/timestamptz/date | 예 | `@DeletedAt({ name?, type? })` |

데이터베이스 컬럼 이름이 속성 이름과 다르면 `name:`을 출력합니다. 타입이 기본값인 `datetime`이 아니면 `type:`을 출력합니다. 이 데코레이터들에는 `default` 옵션이 없습니다. 그래서 컬럼에 데이터베이스 기본값이나 `ON UPDATE`가 있으면 ORM이 값을 직접 채웁니다. 이 기본값은 보통 `CURRENT_TIMESTAMP`입니다. 그리고 NOTE에는 엔티티가 더는 선언하지 않는 데이터베이스 절이 적힙니다. 휴리스틱에 맞지 않는 컬럼은 일반 `@Column`으로 출력하고 원래 기본값을 보존합니다. `upload_date`, `published_at`이 그 예입니다.

---

## 기본값 보존

다이얼렉트별 리더는 기본값을 값이나 식으로 해석합니다. 낮추기 단계는 그 결과를 `@Column({ default: … })`로 적습니다. 괄호로 감싼 문자열은 raw SQL로 취급하고 나머지는 값으로 취급합니다.

| DB 기본값 | 출력 |
|-----------|------|
| `'active'`(SQLite, MariaDB), `active`(MySQL), `'active'::character varying`(PostgreSQL) | `default: "active"` |
| 숫자 컬럼의 `0`, `-1`, `'-1'::integer` | `default: 0`, `default: -1` |
| `true` / `false`, 불리언 컬럼의 `0` / `1` | `default: true` / `default: false` |
| `CURRENT_TIMESTAMP`, `now()`, `gen_random_uuid()`, `(datetime('now'))` | `default: "(CURRENT_TIMESTAMP)"`. 카탈로그가 괄호를 몇 겹 남겼든 괄호는 정확히 한 쌍 |
| MySQL `_utf8mb4'[]'`(TEXT / BLOB / JSON의 리터럴 기본값) | `default: "('[]')"`. MySQL은 이 타입에 다른 형태를 받지 않습니다 |
| `Number.MAX_SAFE_INTEGER`를 넘는 정수 | 자릿수를 잃지 않도록 문자열로 |
| `nextval('seq'::regclass)`, `AUTO_INCREMENT` | 생략. `@PrimaryGeneratedColumn`이 담당합니다. 그 밖의 위치에서는 NOTE |
| `NULL` | 생략. 기본값이 없는 것과 같습니다 |
| `(`로 시작하고 `)`로 끝나는 문자열 리터럴 | 선언하지 않고 NOTE를 답니다. ORM이 이 값을 SQL로 읽기 때문입니다 |

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
| `constructor` | `(queryFn, dialect, options?)` | 쿼리 함수, 다이얼렉트(`"postgres"` / `"mysql"` / `"sqlite"`), 옵션으로 생성 |
| `generate()` | `(): Promise<GeneratedEntity[]>` | 조건에 맞는 모든 테이블의 엔티티 파일 생성 |
| `readSchema()` | `(): Promise<SchemaIR>` | 조건에 맞는 테이블을 스키마 IR로 반환 |
| `readTable(table)` | `(table: string): Promise<TableIR>` | 테이블 하나를 스키마 IR로 반환 |
| `discoverTables()` | `(): Promise<string[]>` | 모든 사용자 테이블(뷰 제외), 이름순 |
| `getColumns(table)` | `(table: string): Promise<DbColumn[]>` | deprecated. `readTable()`을 쓰세요. IR에서 만든 컬럼 행 |
| `getPrimaryKeys(table)` | `(table: string): Promise<string[]>` | deprecated. `readTable()`의 `primaryKey`를 쓰세요 |
| `getForeignKeys(table)` | `(table: string): Promise<DbForeignKey[]>` | deprecated. `readTable()`의 `foreignKeys`를 쓰세요. 컬럼마다 한 행이고 복합 키의 행들은 `constraint_name`을 공유 |
| `getIndexes(table)` | `(table: string): Promise<DbIndex[]>` | deprecated. `readTable()`의 `indexes`를 쓰세요 |

`GeneratedEntity`는 `{ tableName, className, fileName, code, notes }`입니다. `notes`에는 파일에 달린 `// NOTE:`가 모두 들어 있습니다. 필드에 달린 NOTE에는 앞에 속성 이름이 붙습니다.

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
| `IndexIR` | `{ name, unique, columns, unsupported: string[] }`. `unsupported`는 인덱스에 일반 컬럼 목록 말고 무엇이 더 있는지 설명합니다 |

### `runIntrospect(dbOptions, cliOptions?)`

`DatabaseClient`로 연결하고 제너레이터를 실행합니다. 그리고 `dryRun`이 아니면 디스크에 파일을 씁니다. `{ writtenFiles, entities }`를 반환합니다.

### `IntrospectionTypeMapper`

예전 타입 표입니다. 이 표를 직접 쓰던 코드를 위해 남겨 두었습니다. 제너레이터는 deprecated된 `toColumnType()`과 `hasMapping()`을 더 이상 참조하지 않습니다. [타입 매핑](#타입-매핑)을 참고하세요.

| 메서드 | 시그니처 | 설명 |
|--------|---------|------|
| `toColumnType(dbType, dialect, columnTypeFull?)` | `(...): ColumnType` | deprecated. 예전 표로 데이터베이스 타입을 매핑 |
| `hasMapping(dbType, dialect)` | `(...): boolean` | deprecated. 예전 표에 해당 타입이 있는지 확인 |
| `toTsType(columnType)` | `(columnType: ColumnType): string` | ORM `ColumnType` → TypeScript 타입 문자열 |
| `parseSqliteWidth(declaredType)` | `(declaredType: string): number \| null` | `VARCHAR(N)` 등에서 `N` 추출 |
| `parseSqlitePrecisionScale(declaredType)` | `(declaredType: string): { precision, scale } \| null` | `DECIMAL(P, S)`에서 `(P, S)` 추출 |

### `EntityCodeBuilder`

| 메서드 | 시그니처 | 설명 |
|--------|---------|------|
| `constructor` | `(options?: EntityCodeBuilderOptions)` | import 경로와 출력 스타일을 선택적으로 받는 빌더 |
| `build(table, columns, pks, fks, dialect, indexes?, context?)` | `(...): string` | `DbColumn` 행에서 엔티티 소스를 생성. 제너레이터와 같은 파이프라인을 거칩니다. `context.primaryKeysByTable`을 넘기면 기본 키가 아닌 컬럼을 참조하는 외래 키에 NOTE를 답니다 |
| `emit(model)` | `(model: EntityModel): string` | 이미 낮춘 모델을 이 빌더의 스타일로 출력 |
| `tableNameToClassName(table)` | `(string): string` | snake_case 테이블 → PascalCase 클래스 |
| `classNameToFileName(className)` | `(string): string` | PascalCase 클래스 → kebab-case 파일명 |

### `DbColumn`

`EntityCodeBuilder.build()`가 받는 행 형태입니다. deprecated된 `getColumns()`도 이 형태를 반환합니다. 각 필드는 지정한 다이얼렉트의 카탈로그가 뜻하는 대로 해석됩니다.

| 속성 | 타입 | 설명 |
|----------|------|------|
| `column_name` | `string` | 컬럼 이름 |
| `data_type` | `string` | 데이터베이스 네이티브 타입 이름 |
| `is_nullable` | `string` | `"YES"` 또는 `"NO"` |
| `character_maximum_length` | `number \| null` | char/varchar의 최대 길이 |
| `numeric_precision` | `number \| null` | decimal/numeric의 정밀도 |
| `numeric_scale` | `number \| null` | decimal/numeric의 스케일 |
| `column_default` | `string \| null` | 데이터베이스의 기본값 식 |
| `column_type` | `string \| null` | 폭까지 포함한 전체 선언 타입(MySQL `COLUMN_TYPE`, 예: `tinyint(1)`) |
| `is_identity` | `string \| null` | PostgreSQL의 `GENERATED AS IDENTITY`면 `"YES"` |
| `enum_values` | `string[] \| null` | enum 라벨(PostgreSQL `pg_enum` 또는 MySQL 파싱 결과) |
| `udt_name` | `string \| null` | PostgreSQL enum 타입 이름, 또는 `integer[]`의 `_int4` |
| `extra` | `string \| null` | MySQL `EXTRA`(예: `auto_increment`) |

### `DbForeignKey`

| 속성 | 타입 | 설명 |
|----------|------|------|
| `column_name` | `string` | 현재 테이블의 외래 키 컬럼 |
| `referenced_table` | `string` | 대상 테이블 |
| `referenced_column` | `string` | 대상 컬럼 |
| `constraint_name` | `string \| undefined` | 외래 키 제약 조건 이름. 같은 이름을 가진 행들이 복합 키 하나를 이룹니다 |

### `DbIndex`

| 속성 | 타입 | 설명 |
|----------|------|------|
| `name` | `string` | 인덱스 이름(`@Index`/`@UniqueIndex` 출력 시 보존) |
| `column_names` | `string[]` | 인덱스를 구성하는 컬럼(순서 유지) |
| `is_unique` | `boolean` | 고유 인덱스 여부 |

---

## 알려진 한계

인트로스펙션은 데이터베이스 스키마에 명시된 정보만 추출합니다. 다음 항목은 한쪽 외래 키 정보만으로는 도출할 수 없습니다. 그래서 생성한 뒤에 직접 보강해야 합니다.

- **`@OneToMany` 역방향 측 컬렉션.** `User`의 `posts: Post[]`가 그 예입니다. 제너레이터는 소유 측의 `posts.author_id` 외래 키만 봅니다. 그래서 역방향 측 속성은 직접 추가해야 합니다.
- **`@OneToOne`과 `@ManyToOne`의 구분.** 모든 외래 키는 `@ManyToOne`으로 출력됩니다. 외래 키 컬럼에 고유 제약 조건이 있으면 직접 바꾸는 편이 좋습니다.
- **읽기 좋은 속성 별칭.** `CTGR_GRP_SQ` 같은 컬럼은 camelCase로 변환해 `ctgrGrpSq`가 됩니다. `groupId`처럼 더 알아보기 쉬운 이름을 원하면 속성 이름을 바꾸세요. 이때 `name:` 옵션은 그대로 `CTGR_GRP_SQ`를 가리키게 둡니다.

엔티티가 테이블에서 표현하지 못하는 나머지 항목은 [라운드 트립에서 보존되지 않는 항목](#라운드-트립에서-보존되지-않는-항목)에 있습니다. 이 항목은 생성된 파일에도 NOTE로 표시됩니다.

`@ManyToOne(() => Entity, (entity: any) => entity.foo)`의 역방향 측 접근자는 `any`를 쓴 플레이스홀더입니다. 그래서 역방향 측 속성이 없어도 코드가 컴파일됩니다. `@OneToMany` 컬렉션을 추가한 뒤에는 플레이스홀더를 실제 이름으로 바꾸세요.

---

## 다음 단계

- [데이터베이스 시딩](./seeding.md): 생성한 테이블에 초기 데이터 채우기
- [마이그레이션](./migrations.md): 버전 관리되는 스키마 변경
- [엔티티 & 컬럼](./entities.md): 생성된 엔티티 파일 커스터마이즈
- [관계](./relations.md): OneToMany, ManyToMany 등 관계 추가
