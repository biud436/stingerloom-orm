# Migrations

## Migration이 필요한 이유

개발 중에는 `synchronize: true`로 두면 ORM이 엔티티 정의에 맞춰 테이블을 자동으로 맞춰 줍니다. 편하긴 해요. 다만 프로덕션에 그대로 갖다 두기에는 위험합니다.

한 장면을 상상해 볼게요. `users` 테이블에 행이 5만 개 쌓여 있습니다. 엔티티 클래스에서 컬럼 이름 하나를 `phone`에서 `mobile`로 바꿨어요. `synchronize: true` 모드의 ORM은 이걸 "`phone`이 사라지고 `mobile`이 새로 생겼다"고 읽습니다. 그래서 `phone`을 DROP하고 `mobile`을 ADD해요. 전화번호 5만 건이 그 순간 사라집니다.

**Migration**은 스키마 변경을 코드로, 그것도 버전 관리되는 코드로 적어 두는 방식입니다. ORM의 추측에 맡기는 대신, 무엇을 할지 직접 적어 놓는 거예요.

```sql
-- What synchronize: true would do (DANGEROUS):
ALTER TABLE "users" DROP COLUMN "phone";
ALTER TABLE "users" ADD COLUMN "mobile" VARCHAR(20);
-- All phone data is lost!

-- What a migration does (SAFE):
ALTER TABLE "users" RENAME COLUMN "phone" TO "mobile";
-- Data preserved. Column renamed.
```

Migration이 `synchronize: true`를 앞서는 이유는 세 가지입니다.

1. **안전성** — DB에 실행될 SQL을 직접 정해 놓습니다.
2. **이력** — 모든 스키마 변경이 코드처럼 버전 관리됩니다.
3. **되돌리기** — 문제가 생기면 변경을 거꾸로 돌릴 수 있습니다.

---

## Migration 파일 만들기

Migration은 메서드가 두 개인 클래스입니다.

- **`up()`** — 변경을 적용 (앞으로)
- **`down()`** — 변경을 되돌림 (뒤로)

엘리베이터처럼 생각하면 편해요. `up()`은 다음 층으로 올라가는 버튼, `down()`은 이전 층으로 내려오는 버튼.

```typescript
// migrations/001_CreateUsersTable.ts
import { Migration, MigrationContext } from "@stingerloom/orm";

export class CreateUsersTable extends Migration {
  async up(context: MigrationContext) {
    await context.query(`
      CREATE TABLE IF NOT EXISTS "users" (
        "id" SERIAL PRIMARY KEY,
        "name" VARCHAR(100) NOT NULL,
        "email" VARCHAR(255) NOT NULL UNIQUE,
        "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  async down(context: MigrationContext) {
    await context.query(`DROP TABLE IF EXISTS "users"`);
  }
}
```

`MigrationContext` 객체는 두 가지를 제공해요:

| Property | 설명 |
|----------|------|
| `context.query(sql)` | SQL 문을 실행해요 |
| `context.driver` | 데이터베이스 드라이버에 접근해요 (DDL 헬퍼, 식별자 이스케이프 등) |

---

## Migration 예제

### 컬럼 추가

지난주에 users 테이블을 배포했어요. 이번에 기획팀이 전화번호 필드를 원해요. 원래 migration을 수정하는 게 아니라, 새 migration을 만들어요.

```typescript
// migrations/002_AddPhoneToUsers.ts
export class AddPhoneToUsers extends Migration {
  async up(context: MigrationContext) {
    await context.query(
      `ALTER TABLE "users" ADD COLUMN "phone" VARCHAR(20) NULL`
    );
  }

  async down(context: MigrationContext) {
    await context.query(
      `ALTER TABLE "users" DROP COLUMN "phone"`
    );
  }
}
```

`up()` 실행 시 생성되는 SQL:

```sql
ALTER TABLE "users" ADD COLUMN "phone" VARCHAR(20) NULL;
```

`down()` (롤백) 실행 시 생성되는 SQL:

```sql
ALTER TABLE "users" DROP COLUMN "phone";
```

### 인덱스 추가

email로 필터링하는 쿼리가 느려요. 인덱스를 추가해요:

```typescript
// migrations/003_AddEmailIndex.ts
export class AddEmailIndex extends Migration {
  async up(context: MigrationContext) {
    await context.query(
      `CREATE INDEX "idx_users_email" ON "users" ("email")`
    );
  }

  async down(context: MigrationContext) {
    await context.query(
      `DROP INDEX "idx_users_email"`
    );
  }
}
```

`up()` SQL:

```sql
CREATE INDEX "idx_users_email" ON "users" ("email");
```

### 초기 데이터 삽입

Migration은 스키마 변경에만 쓰는 게 아니에요. Seed 데이터 삽입도 가능해요:

```typescript
// migrations/004_SeedRoles.ts
export class SeedRoles extends Migration {
  async up(context: MigrationContext) {
    await context.query(`
      INSERT INTO "roles" ("name", "description") VALUES
      ('admin', 'Administrator'),
      ('user', 'Regular user'),
      ('guest', 'Guest')
    `);
  }

  async down(context: MigrationContext) {
    await context.query(
      `DELETE FROM "roles" WHERE "name" IN ('admin', 'user', 'guest')`
    );
  }
}
```

---

## Migration 추적 방식

Migration을 처음 실행하면, Stingerloom이 `__migrations`라는 특수 테이블을 자동으로 만들어요. 이 테이블이 어떤 migration이 이미 적용됐는지 기록해요.

PostgreSQL / SQLite의 경우:

```sql
CREATE TABLE IF NOT EXISTS "__migrations" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL UNIQUE,
  "executed_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

MySQL의 경우:

```sql
CREATE TABLE IF NOT EXISTS `__migrations` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL UNIQUE,
  `executed_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

Migration이 성공적으로 실행될 때마다 행이 삽입돼요:

```sql
INSERT INTO "__migrations" ("name") VALUES ('CreateUsersTable');
```

다시 migration을 실행하면, runner가 먼저 이 테이블을 조회해요:

```sql
SELECT "name" FROM "__migrations" ORDER BY "id" ASC;
-- Returns: ['CreateUsersTable', 'AddPhoneToUsers']
```

그리고 등록된 migration 목록과 비교해서 아직 실행되지 않은 것만 실행해요. 이 방식 덕분에 migration은 **멱등적**(idempotent)이에요 -- `migrate:run`을 두 번 실행해도 같은 migration이 중복 적용되지 않아요.

롤백할 때는 해당 행이 삭제돼요:

```sql
DELETE FROM "__migrations" WHERE "name" = 'AddPhoneToUsers';
```

---

## Migration 실행하기

Migration을 실행하는 방법은 두 가지예요: 내장 **CLI** (가장 간단)와 **프로그래밍 방식 API** (커스텀 설정용).

### 내장 CLI 사용 (권장)

Stingerloom은 설정 파일을 읽고 터미널에서 직접 migration을 실행하는 CLI를 제공해요.

```bash
# Run all pending migrations
npx stingerloom migrate:run

# Roll back the last migration
npx stingerloom migrate:rollback

# Show executed and pending migrations
npx stingerloom migrate:status

# Auto-generate a migration from schema diff (see below)
npx stingerloom migrate:generate
```

#### 설정 파일

CLI는 프로젝트 루트에서 설정 파일을 자동으로 찾아요. 다음 순서로 검색해요:

1. `stingerloom.config.ts`
2. `stingerloom.config.js`
3. `stingerloom.config.mjs` / `stingerloom.config.cjs`
4. `ormconfig.ts`
5. `ormconfig.js`
6. `ormconfig.mjs` / `ormconfig.cjs`

```typescript
// stingerloom.config.ts
import { User } from "./src/entities/user.entity";
import { Post } from "./src/entities/post.entity";
import { CreateUsersTable } from "./migrations/001_CreateUsersTable";
import { AddPhoneToUsers } from "./migrations/002_AddPhoneToUsers";

export default {
  connection: {
    type: "postgres",
    host: "localhost",
    port: 5432,
    username: "postgres",
    password: "password",
    database: "mydb",
    entities: [User, Post],
  },
  migrations: [
    new CreateUsersTable(),
    new AddPhoneToUsers(),
  ],
};
```

CLI 플래그로 설정 경로와 옵션을 지정할 수 있어요:

```bash
npx stingerloom migrate:run --config ./config/prod.config.ts
npx stingerloom migrate:generate --output ./src/migrations --name AddEmailIndex
```

| Flag | 설명 |
|------|------|
| `--config <path>` | 설정 파일 경로 (기본값: 자동 탐지) |
| `--output <dir>` | 생성된 migration 출력 디렉토리 (기본값: `./migrations`) |
| `--name <suffix>` | 생성되는 파일의 migration 이름 접미사 |
| `--help` | 도움말 표시 |

> CLI는 `ts-node`나 `tsx`를 통해 TypeScript 설정 파일을 기본 지원해요. 둘 다 설치되어 있지 않으면 `.js` 설정 파일을 사용하세요.

### Advisory Lock을 통한 동시성 안전

여러 서버가 동시에 시작될 때 (Kubernetes 배포에서 흔한 상황), migration을 동시에 실행하려고 할 수 있어요. 이러면 테이블 중복 생성 에러가 발생할 수 있어요.

Stingerloom은 **advisory lock**으로 이 문제를 방지해요. Migration을 실행하기 전에 데이터베이스 수준의 잠금을 획득해요:

```
Server A: acquireAdvisoryLock("stingerloom_migration_lock") -> acquired!
Server B: acquireAdvisoryLock("stingerloom_migration_lock") -> waiting...
Server A: runs migrations, releases lock
Server B: acquireAdvisoryLock("stingerloom_migration_lock") -> acquired!
Server B: checks __migrations table, finds nothing pending, exits
```

타임아웃 (기본값: 10초) 내에 잠금을 획득하지 못하면 `AdvisoryLockError`가 발생해요.

### MigrationCli 사용 (프로그래밍 방식)

더 세밀한 제어가 필요하면 커스텀 migration 스크립트를 만들 수 있어요. 환경 변수에서 설정을 가져오거나 migration 전후에 커스텀 로직이 필요할 때 유용해요.

```typescript
// src/migrate.ts
import { MigrationCli } from "@stingerloom/orm";
import { CreateUsersTable } from "./migrations/001_CreateUsersTable";
import { AddPhoneToUsers } from "./migrations/002_AddPhoneToUsers";
import { AddEmailIndex } from "./migrations/003_AddEmailIndex";

const migrations = [
  new CreateUsersTable(),
  new AddPhoneToUsers(),
  new AddEmailIndex(),
];

const cli = new MigrationCli(migrations, {
  type: "postgres",
  host: process.env.DB_HOST ?? "localhost",
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USER ?? "postgres",
  password: process.env.DB_PASS ?? "password",
  database: process.env.DB_NAME ?? "mydb",
  entities: [],
});

async function main() {
  await cli.connect();

  const command = process.argv[2]; // "migrate:run" | "migrate:rollback" | "migrate:status"
  try {
    const result = await cli.execute(command as any);
    console.log(result);
  } finally {
    await cli.close();
  }
}

main().catch(console.error);
```

편의를 위해 package.json에 스크립트를 등록하세요:

```json
{
  "scripts": {
    "migrate:run": "ts-node ./src/migrate.ts migrate:run",
    "migrate:rollback": "ts-node ./src/migrate.ts migrate:rollback",
    "migrate:status": "ts-node ./src/migrate.ts migrate:status",
    "migrate:generate": "ts-node ./src/migrate.ts migrate:generate"
  }
}
```

---

## Migration 결과 확인

각 migration은 성공 여부를 담은 결과 객체를 반환해요:

```typescript
const results = await cli.migrateRun();

for (const result of results) {
  if (result.success) {
    console.log(`[OK] ${result.name}`);
  } else {
    console.error(`[FAIL] ${result.name}: ${result.error}`);
  }
}
```

Migration이 실패하면 runner가 즉시 멈춰요 -- 이후 migration은 실행하지 않아요. 실패한 migration에 의존하는 경우가 대부분이기 때문이에요.

---

## 파일 네이밍 규칙

Migration은 배열에 등록된 순서대로 실행돼요. 파일명에 순번을 붙여서 순서를 명확하게 하세요:

```
migrations/
├── 001_CreateUsersTable.ts
├── 002_CreatePostsTable.ts
├── 003_AddPhoneToUsers.ts
├── 004_AddEmailIndex.ts
└── 005_SeedRoles.ts
```

---

## Schema Diff -- 자동 Migration 생성

간단한 변경은 migration 파일을 직접 작성해도 되지만, 복잡한 변경은 번거로워요. Schema Diff는 엔티티 정의와 실제 데이터베이스 스키마를 비교해서 필요한 migration 코드를 자동으로 생성해요.

### Schema Diff 동작 과정

`SchemaDiff.diff()` 내부에서 일어나는 일을 단계별로 설명할게요:

**Step 1: 엔티티 정의 읽기.** Diff 엔진이 `reflect-metadata`를 사용해서 모든 `@Entity` 클래스와 `@Column` 정의를 추출해요 -- 테이블명, 컬럼명, 타입, 길이, nullable 여부 등.

**Step 2: 실제 데이터베이스 조회.** `information_schema` 쿼리를 실행해서 현재 존재하는 테이블과 컬럼을 확인해요:

```sql
-- PostgreSQL
SELECT column_name, data_type, is_nullable, character_maximum_length
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'users';

-- MySQL
SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users';
```

**Step 3: 비교.** 각 엔티티에 대해 확인해요:
- 데이터베이스에 테이블이 있는지? 없으면 `addTables`에 추가.
- 엔티티의 각 컬럼이 데이터베이스에 있는지? 없으면 `addColumns`에 추가.
- 데이터베이스의 각 컬럼이 엔티티에 있는지? 없으면 `dropColumns`에 추가.
- 둘 다 존재하면, 타입과 길이가 일치하는지? 불일치하면 `alterColumns`에 추가.

**Step 4: 이름 변경 감지.** 확정하기 전에 컬럼 이름 변경 가능성을 확인해요 (아래에서 자세히 설명).

**Step 5: Migration 코드 생성.** `SchemaDiffMigrationGenerator`가 diff 결과를 받아서 적절한 `up()`과 `down()` 메서드를 가진 migration 클래스를 생성해요.

### CLI 사용

Migration을 생성하는 가장 간단한 방법이에요:

```bash
npx stingerloom migrate:generate
```

이 명령은:
1. 설정 파일을 사용해서 데이터베이스에 연결해요.
2. 등록된 모든 엔티티에 대해 `SchemaDiff.diff()`를 실행해요.
3. 차이가 발견되면 타임스탬프가 붙은 migration 파일을 생성해요.
4. 스키마가 이미 동기화되어 있으면 "No schema changes"를 출력하고 종료해요.

### 프로그래밍 방식 API

```typescript
import { SchemaDiff, SchemaDiffMigrationGenerator } from "@stingerloom/orm";

// Step 1: Compare entity definitions with the live database
const schemaDiff = new SchemaDiff();
const diff = await schemaDiff.diff(
  [User, Post, Comment],   // your entity classes
  queryRunner,              // something with a .query() method
  "postgres",               // dialect: "postgres" | "mysql" | "sqlite"
);

console.log(diff.addTables);      // ["comment"]
console.log(diff.dropTables);     // []
console.log(diff.addColumns);     // [{ tableName: "users", columnName: "phone", ... }]
console.log(diff.renamedColumns); // [{ tableName: "users", oldColumnName: "phone", newColumnName: "mobile", ... }]

// Step 2: Generate migration code from the diff
if (diff.addTables.length === 0 &&
    diff.dropTables.length === 0 &&
    diff.addColumns.length === 0 &&
    diff.dropColumns.length === 0 &&
    diff.alterColumns.length === 0 &&
    (diff.renamedColumns?.length ?? 0) === 0) {
  console.log("No schema changes");
  return;
}

const generator = new SchemaDiffMigrationGenerator();
const content = generator.generate(diff, "postgres");
await generator.save(content, "./migrations");
```

::: warning SQLite 컬럼 변경
SQLite는 컬럼의 타입이나 nullability를 `ALTER`할 수 없습니다. diff에 해당 변경이 있고 dialect가 `"sqlite"`이면 `generate()`와 `dryRun()` 모두 영향받는 컬럼 목록과 함께 `ORM_UNSUPPORTED_OPERATION`을 던집니다. 변경을 조용히 건너뛴 마이그레이션을 만들지 않아요. 이 경우에는 테이블을 재구축하는 수동 마이그레이션을 작성해야 합니다: 원하는 스키마로 새 테이블을 만들고, 데이터를 복사한 뒤, 기존 테이블을 삭제하고 새 테이블의 이름을 바꿉니다.
:::

### 예제: 컬럼 추가

User 엔티티에 `phone` 컬럼을 추가해요:

```typescript
@Entity()
class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 100 })
  name!: string;

  @Column({ type: "varchar", length: 20 })  // NEW
  phone!: string;
}
```

`migrate:generate`를 실행하면 `phone`이 엔티티에는 있지만 데이터베이스에는 없다는 걸 감지하고, 다음과 같은 migration을 생성해요:

```typescript
class SchemaDiff_1708000000000 extends Migration {
  async up(context: MigrationContext) {
    await context.query(
      `ALTER TABLE "users" ADD COLUMN "phone" VARCHAR(20) NULL`
    );
  }
  async down(context: MigrationContext) {
    await context.query(
      `ALTER TABLE "users" DROP COLUMN "phone"`
    );
  }
}
```

### 컬럼 이름 변경 감지

Schema Diff에서 가장 영리한 부분이에요. 컬럼 이름을 변경하면, 단순한 접근법으로는 "삭제"와 "추가"로 인식해요 -- 이전 이름이 사라지고 새 이름이 나타났으니까요. 하지만 diff 엔진은 **휴리스틱**을 사용해서 이름 변경을 감지하고 데이터 손실을 방지해요.

휴리스틱 동작 방식이에요:

1. 각 테이블에서 **삭제될** 컬럼 (DB에 있지만 엔티티에 없는 것)과 **추가될** 컬럼 (엔티티에 있지만 DB에 없는 것)을 수집해요.
2. 삭제될 각 컬럼에 대해, 같은 테이블에 **호환되는 타입**의 추가될 컬럼이 있는지 확인해요.
3. 1:1 매칭이 발견되면 (삭제될 컬럼 하나가 타입 기준으로 추가될 컬럼 하나와 매칭), drop + add 대신 **이름 변경**으로 처리해요.

예를 들어 `phone`을 `mobile`로 이름을 바꾸면:

```typescript
// Before
@Column({ type: "varchar", length: 20 })
phone!: string;

// After
@Column({ type: "varchar", length: 20 })
mobile!: string;
```

Diff 엔진이 보는 것:
- 삭제: `phone` (타입: VARCHAR)
- 추가: `mobile` (타입: VARCHAR)
- 같은 테이블, 호환되는 타입, 1:1 매칭 -- 이름 변경으로 판단.

생성된 migration은 `DROP` + `ADD` 대신 `RENAME COLUMN`을 사용해요:

```typescript
class SchemaDiff_1708000000000 extends Migration {
  async up(context: MigrationContext) {
    await context.query(
      `ALTER TABLE "users" RENAME COLUMN "phone" TO "mobile"`
    );
  }
  async down(context: MigrationContext) {
    await context.query(
      `ALTER TABLE "users" RENAME COLUMN "mobile" TO "phone"`
    );
  }
}
```

호환되는 타입으로 후보를 좁히기 때문에 이름 변경 감지가 잘 동작해요. `phone` (VARCHAR)의 이름을 바꾸면서 동시에 `age` (INT)를 추가해도, VARCHAR와 INT는 호환되지 않는 타입이라 혼동하지 않아요.

> Schema Diff는 테이블과 컬럼의 추가, 삭제, 이름 변경을 감지해요. 컬럼 타입 변경 (예: VARCHAR를 TEXT로 변경)은 diff 결과의 `alterColumns`로 감지되지만, 안전을 위해 수동 migration으로 작성하는 걸 권장해요.

### ENUM 값 동기화 (PostgreSQL)

대부분의 스키마 변경은 **테이블 수준**에서 일어나요. 하지만 PostgreSQL에는 특이한 점이 있어요: ENUM 타입은 테이블 외부에 존재하는 **별도의 데이터베이스 객체**예요. `@Column({ type: "enum", enumValues: ["admin", "user"] })`로 정의하면, PostgreSQL이 named type (예: `users_role_enum`)을 만들고 컬럼이 그 타입을 참조해요.

문제는 이거예요. 새 역할을 추가한다고 해봐요:

```typescript
@Column({
  type: "enum",
  enumValues: ["admin", "user", "moderator"],  // "moderator" is new
})
role!: string;
```

일반적인 `ALTER TABLE`로는 이 변경을 감지할 수 없어요. 컬럼 타입은 여전히 `users_role_enum`이라 변하지 않았거든요. 변한 건 **enum 타입 정의 자체**예요. 자동 동기화가 없으면 직접 이렇게 작성해야 해요:

```sql
ALTER TYPE "users_role_enum" ADD VALUE IF NOT EXISTS 'moderator';
```

SchemaDiff가 PostgreSQL에서 이걸 자동으로 처리해줘요.

**동작 방식.** Diff 단계에서 테이블과 컬럼을 비교한 후, PostgreSQL enum 타입에 대한 추가 검사를 실행해요:

1. 엔티티의 각 `@Column({ type: "enum" })`에 대해, 데이터베이스의 `pg_enum`과 `pg_type`에서 현재 enum 값을 읽어요.
2. 엔티티 정의의 값과 데이터베이스의 값을 비교해요.
3. 새 값은 `addValues`, 제거된 값은 `removeValues`에 들어가요.

결과는 diff의 `enumChanges` 배열에 저장돼요:

```typescript
interface EnumChange {
  enumName: string;        // e.g. "users_role_enum"
  addValues: string[];     // values to add
  removeValues: string[];  // values that were removed
  isNew: boolean;          // true if the entire enum type needs to be created
}
```

**생성되는 migration -- 값 추가:**

enum에 `"moderator"`를 추가하면, migration 생성기가 다음을 생성해요:

```typescript
class AutoMigration_1708000000000 extends Migration {
  async up({ query }: MigrationContext): Promise<void> {
    await query(`ALTER TYPE "users_role_enum" ADD VALUE IF NOT EXISTS 'moderator'`);
  }

  async down({ query }: MigrationContext): Promise<void> {
    // WARNING: Cannot reverse ALTER TYPE ADD VALUE for "users_role_enum".
    // Recreate the type manually if needed.
  }
}
```

`IF NOT EXISTS` 절 덕분에 여러 번 실행해도 안전해요 -- 값이 이미 있으면 PostgreSQL이 조용히 건너뛰어요.

**생성되는 migration -- 값 제거:**

PostgreSQL의 근본적인 제약이 있어요: 기존 enum 타입에서 **값을 제거할 수 없어요**. 유일한 방법은 타입 전체를 drop하고 다시 만드는 건데, 그 타입을 참조하는 모든 컬럼을 업데이트해야 해요. Migration 생성기는 안전하지 않은 DDL 대신 경고 주석을 남겨요:

```sql
-- WARNING: Cannot remove enum values from "users_role_enum": guest.
-- Recreate the type manually if needed.
```

의도적으로 신중하게 처리한 거예요. Enum 타입을 drop하고 다시 만드는 건 다단계 작업이고, 제거한 값을 가진 행이 있으면 실패할 수 있어요. 직접 프로세스를 제어하는 수동 migration이 더 안전해요.

**MySQL은?**

MySQL은 enum을 다르게 처리해요 -- enum 값이 컬럼 정의 자체에 포함돼요 (`role ENUM('admin','user','moderator')`). MySQL에서 enum 값을 변경하면, SchemaDiff가 `alterColumns`의 일반적인 컬럼 타입 수정으로 감지해요. 생성된 migration은 `MODIFY COLUMN`으로 전체 컬럼 정의를 업데이트해요. 별도의 enum 처리가 필요 없어요.

---

## 마이그레이션 훅

MigrationRunner는 마이그레이션 실행 중 모니터링, 로깅, 에러 처리를 위한 라이프사이클 훅을 지원해요.

### 사용 가능한 훅

```typescript
interface MigrationHooks {
  beforeAll?(context: MigrationContext): Promise<void> | void;
  afterAll?(context: MigrationContext, results: MigrationResult[]): Promise<void> | void;
  beforeEach?(migration: Migration, context: MigrationContext): Promise<void> | void;
  afterEach?(migration: Migration, context: MigrationContext, durationMs: number): Promise<void> | void;
  onError?(migration: Migration, error: Error, context: MigrationContext): Promise<void> | void;
}
```

| 훅 | 발생 시점 | 파라미터 |
|-----|----------|---------|
| `beforeAll` | 첫 번째 마이그레이션 실행 전 | MigrationContext |
| `afterAll` | 모든 마이그레이션 완료 후 | MigrationContext, results 배열 |
| `beforeEach` | 개별 마이그레이션 실행 전 | Migration, MigrationContext |
| `afterEach` | 개별 마이그레이션 성공 후 | Migration, MigrationContext, 소요 시간(ms) |
| `onError` | 마이그레이션 실패 시 | Migration, error, MigrationContext |

### 예제: 실패 시 Slack 알림

```typescript
import { MigrationRunner } from "@stingerloom/orm";

const runner = new MigrationRunner(driver, migrations, {
  hooks: {
    beforeAll(ctx) {
      console.log("Starting migrations...");
    },
    afterEach(migration, ctx, durationMs) {
      console.log(`Completed ${migration.constructor.name} in ${durationMs}ms`);
    },
    onError(migration, error, ctx) {
      notifySlack(`Migration failed: ${migration.constructor.name} -- ${error.message}`);
    },
    afterAll(ctx, results) {
      console.log(`All done. ${results.length} migrations applied.`);
    },
  },
});

await runner.runAll();
```

모든 훅은 비동기(Promise 반환)이거나 동기(즉시 반환)일 수 있어요.

---

## MigrationRunner API

| Method | 설명 |
|--------|------|
| `run(migrations?)` | 대기 중인 migration을 순서대로 실행해요 |
| `rollback(n?)` | 마지막 n개 migration을 롤백해요 (기본값: 1) |
| `status()` | `{ executed: string[], pending: string[] }`을 반환해요 |
| `runAll()` | 대기 중인 모든 migration을 실행해요 |
| `runUp(migration)` | 단일 migration을 적용해요 |
| `runDown(migration)` | 단일 migration을 되돌려요 |
| `revertLast()` | 마지막 migration을 되돌려요 |
| `getPendingMigrations()` | 대기 중인 migration 목록을 반환해요 |
| `getExecutedMigrations()` | 실행된 migration 목록을 반환해요 |

---

## 다음 단계

- [Configuration](./configuration.md) -- 풀링, 타임아웃, Read Replica 설정
- [Multi-Tenancy](./multi-tenancy.md) -- 테넌트별 자동 스키마 프로비저닝
- [Events & Subscribers](./events.md) -- 라이프사이클 훅과 엔티티 이벤트 시스템
