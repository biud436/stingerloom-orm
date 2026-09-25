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

**Step 4: 이름 변경 감지.** 확정하기 전에 증명 가능한 이름 변경을 찾습니다 -- 명시된 `renamedFrom`, 또는 같은 컬럼으로 읽히는 add/drop 쌍이요. 그보다 확실하지 않은 것은 이름 변경 후보로 보고합니다 (아래에서 자세히 설명).

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
SQLite는 컬럼의 타입이나 nullability를 `ALTER`할 수 없습니다. diff에 해당 변경이 있고 dialect가 `"sqlite"`이면 `generate()`와 `dryRun()` 모두 영향받는 컬럼 목록과 함께 `ORM_UNSUPPORTED_OPERATION`을 던집니다. 변경이 빠진 마이그레이션을 만들어 내지 않아요. 이 경우에는 테이블을 재구축하는 수동 마이그레이션을 작성해야 합니다: 원하는 스키마로 새 테이블을 만들고, 데이터를 복사한 뒤, 기존 테이블을 삭제하고 새 테이블의 이름을 바꿉니다.
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

컬럼 이름을 바꾸면 단순한 접근법은 "삭제"와 "추가"로 읽습니다. 이전 이름이 사라지고 새 이름이 나타났으니까요. Schema Diff는 그 쌍을 이름 변경으로 알아보려고 하지만, 이름 변경과 컬럼 **교체**는 완전히 같은 모양이라 잘못 짚으면 삭제된 컬럼의 데이터가 새 컬럼 이름으로 되살아납니다. 그래서 확실할 때만 RENAME을 실행해요.

테이블마다 이런 순서로 판단합니다.

1. **삭제될** 컬럼 (DB에 있지만 엔티티에 없는 것)과 **추가될** 컬럼 (엔티티에 있지만 DB에 없는 것)을 모읍니다.
2. 엔티티가 `@Column({ renamedFrom })`으로 명시한 쌍을 먼저 확정합니다. 명시 힌트가 항상 이깁니다.
3. 남은 것 중 **타입이 호환되는** 쌍만 남깁니다 (DB가 길이·정밀도를 보고하면 그것까지 같아야 해요).
4. 두 이름이 **같은 컬럼으로 읽히고** 양쪽 모두 다른 후보가 없을 때만 이름 변경으로 확정합니다.
5. 나머지는 **이름 변경 후보**로 보고하고, 선언된 그대로 drop + add를 적용합니다.

같은 컬럼으로 읽히는 경우는 대소문자·구분자만 다를 때 (`user_name` -> `userName`), 한쪽이 다른 쪽을 포함할 때 (`name` -> `fullName`, `legacyNote` -> `note`), 편집 거리가 짧을 때 (`recieved_at` -> `received_at`)입니다. `legacyNote` -> `bio`나 `createdAt` -> `updatedAt`처럼 서로 무관한 이름은 이름 변경으로 보지 않아요.

엔진이 알아보는 이름 변경은 이렇게 처리됩니다.

```typescript
// Before
@Column({ type: "varchar", length: 20 })
phone!: string;

// After
@Column({ type: "varchar", length: 20 })
phoneNumber!: string;
```

Diff 엔진이 보는 것:
- 삭제: `phone` (타입: VARCHAR(20))
- 추가: `phoneNumber` (타입: VARCHAR(20))
- 같은 테이블, 호환되는 타입, 같은 컬럼으로 읽히는 이름 -- 이름 변경으로 판단.

생성된 migration은 `DROP` + `ADD` 대신 `RENAME COLUMN`을 사용해요:

```typescript
class SchemaDiff_1708000000000 extends Migration {
  async up(context: MigrationContext) {
    await context.query(
      `ALTER TABLE "users" RENAME COLUMN "phone" TO "phoneNumber"`
    );
  }
  async down(context: MigrationContext) {
    await context.query(
      `ALTER TABLE "users" RENAME COLUMN "phoneNumber" TO "phone"`
    );
  }
}
```

#### 이름이 전혀 다를 때: `renamedFrom`

새 이름이 예전 이름과 아무 관계가 없다면 ORM에 직접 알려주세요.

```typescript
@Column({ type: "varchar", length: 100, renamedFrom: "legacyNote" })
bio!: string;
```

`renamedFrom`에는 값이 넘어올 **DB 컬럼 이름**을 적습니다. 이 옵션이 있으면 synchronize와 `migrate:generate`가 `RENAME COLUMN`을 내보내고, 없으면 엔티티가 선언한 그대로 `bio`를 빈 컬럼으로 추가하고 `legacyNote`를 삭제합니다. 해당 이름의 컬럼이 더 이상 없으면 옵션은 아무 일도 하지 않으니, 이름 변경이 모든 환경에 반영된 뒤에 지우면 돼요. `defineEntity`에서는 `t.varchar(100).renamedFrom("legacyNote")`, `EntitySchema` 컬럼에서는 `renamedFrom: "legacyNote"`로 같은 설정을 합니다.

#### 거절된 이름 변경은 이렇게 보입니다

`synchronize`는 drop + add를 적용하기 전에 쌍마다 경고를 한 줄씩 남깁니다.

```
[sync] profile.bio is being added while the dropped column "legacyNote" has the
same type but an unrelated name. Treating it as a new column: nothing is copied
from legacyNote. If it is a rename, declare
@Column({ renamedFrom: "legacyNote" }) (or write a migration) before this sync runs.
```

`migrate:generate`는 결정한 ADD/DROP을 쓰고, 그 뒤에 이름 변경을 주석 처리된 대안으로 덧붙입니다.

```typescript
// POSSIBLE RENAME (name differs from the dropped legacyNote) -- uncomment INSTEAD of the ADD/DROP pair above if this is a rename:
// await query(`ALTER TABLE "profile" RENAME COLUMN "legacyNote" TO "bio"`)
```

거절된 쌍은 diff 결과의 `renameCandidates`에도 담깁니다. 추가될 컬럼, 거기에 맞는 삭제될 컬럼들 (유사도 순), 그리고 `reason`이 `"ambiguous"` (여러 개가 맞음) 또는 `"dissimilar-names"` (타입만 맞음)로 들어 있어요.

> 이름 변경은 `synchronize.failOnDestructiveChange`의 영향을 받습니다. 이 플래그를 켜면 synchronize는 부팅 중에 데이터를 옮기는 대신 `ORM_SCHEMA_SYNC_DESTRUCTIVE_CHANGE`를 던지고 멈춥니다.

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

> **힌트** `synchronize`도 부팅 시점에 같은 두 작업을 수행합니다. 마이그레이션 파일을 거치지 않고 없는 enum 타입을 만들고, 빠진 값을 추가해요. 자세한 동작은 [설정](./configuration.md#postgresql-enum-타입)을 참고하세요.

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

`IF NOT EXISTS` 절 덕분에 여러 번 실행해도 안전해요 -- 값이 이미 있으면 PostgreSQL이 그냥 넘어가요.

**생성되는 migration -- 값 제거:**

PostgreSQL의 근본적인 제약이 있어요: 기존 enum 타입에서 **값을 제거할 수 없어요**. 유일한 방법은 타입 전체를 drop하고 다시 만드는 건데, 그 타입을 참조하는 모든 컬럼을 업데이트해야 해요. Migration 생성기는 안전하지 않은 DDL 대신 경고 주석을 남겨요:

```sql
-- WARNING: Cannot remove enum values from "users_role_enum": guest.
-- Recreate the type manually if needed.
```

의도적으로 신중하게 처리한 거예요. Enum 타입을 drop하고 다시 만드는 건 다단계 작업이고, 제거한 값을 가진 행이 있으면 실패할 수 있어요. 직접 프로세스를 제어하는 수동 migration이 더 안전해요.

**MySQL은?**

MySQL은 값을 컬럼 타입 자체에 담습니다(`role ENUM('admin','user','moderator')`). 그런데 diff는 타입 이름(`ENUM`과 `enum`)만 비교하고 안의 값 목록은 보지 않으므로, MySQL / MariaDB에서 값 목록을 바꿔도 `migrate:generate`와 `synchronize` 모두 감지하지 못합니다. `MODIFY COLUMN`을 직접 작성하세요:

```sql
ALTER TABLE `users` MODIFY COLUMN `role` ENUM('admin','user','moderator') NOT NULL;
```

### Schema Diff가 비교하지 않는 것

이미 있는 테이블에서 diff가 비교하는 것은 컬럼입니다. 컬럼의 존재 여부, 타입, 길이, 정밀도, nullable과 함께 이름 변경, 생성 컬럼, PostgreSQL enum 값까지 봅니다. `synchronize`는 여기에 더해 엔티티에 새로 생긴 인덱스와 외래 키를 만듭니다. 아래 표의 나머지는 DB에 있는 그대로 남아요. PostgreSQL, MariaDB, SQLite에서 직접 측정한 결과입니다:

| 기존 테이블의 변경 | `synchronize` | `migrate:generate` |
|--------------------|---------------|--------------------|
| 컬럼 추가·삭제, 타입·길이·nullable 변경 | 적용(모드가 허용하는 만큼) | 생성 |
| 컬럼 이름 변경(`renamedFrom` 또는 같은 컬럼으로 읽히는 이름) | 적용 | 생성 |
| `@ComputedColumn` 추가 | 적용 | 생성 |
| PostgreSQL enum 값 추가 | 적용 | 생성 |
| `@Index`, `@UniqueIndex`, 클래스 레벨 `@Index([...])`, `@FullTextIndex` 추가 | 생성 | **생성 안 함** |
| 관계 추가(`@ManyToOne`, 소유 측 `@OneToOne`) | 컬럼과 제약 생성 -- SQLite는 기존 테이블에 제약을 추가할 수 없어 컬럼만 | **컬럼만** |
| 관계 제거 | PostgreSQL은 컬럼 삭제. MySQL / MariaDB와 SQLite는 제약이 컬럼을 참조하고 있어 삭제가 경고와 함께 실패 | `DROP COLUMN`을 주석 처리해서 작성 |
| 엔티티에서 인덱스·유니크 인덱스 제거 | **그대로 남음** | 생성 안 함 |
| 같은 이름으로 인덱스 정의 변경 | **예전 정의 그대로** | 생성 안 함 |
| 이름이 자동 생성된 유니크 인덱스의 컬럼 변경 | 새 인덱스 생성, **옛 인덱스도 남아 계속 제약을 걺** | 생성 안 함 |
| 컬럼 `default` 추가·변경·제거 | 비교 안 함 | 비교 안 함 |
| 관계 `onDelete` / `onUpdate` 변경 | 비교 안 함 | 비교 안 함 |
| `@ComputedColumn` 표현식 변경 | 비교 안 함 | 비교 안 함 |
| MySQL / MariaDB `ENUM` 값 변경 | 비교 안 함 | 비교 안 함 |
| 엔티티 제거 | 테이블 유지 | 테이블 유지 |

이런 수정 뒤 재시작하면 동기화가 성공한 것처럼 보이기 쉬우므로 두 경로 모두 이를 알립니다. 이미 있던 테이블이 하나라도 있으면 `synchronize`는 부팅마다 한 줄을 남기는데, 엔티티가 실제로 쓰는 종류만 나열합니다. 예를 들어 `default`는 어떤 컬럼이 선언했을 때만 목록에 들어가요:

```
INFO [SchemaRegistrar] [sync] synchronize does not apply these to existing tables: changed column defaults, removed or redefined indexes. Write a migration for them (see docs/migrations.md#what-the-schema-diff-does-not-compare).
```

`migrate:generate`도 실행 후 같은 줄을 남기며, 목록 맨 앞에 "new indexes and foreign key constraints"가 붙습니다. 이런 변경은 migration에 직접 작성하세요. 형태는 [인덱스 추가](#인덱스-추가)를 참고하면 됩니다.

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
