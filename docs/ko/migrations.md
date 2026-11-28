# 마이그레이션

## 마이그레이션이 필요한 이유

개발 중에는 `synchronize: true`를 켜 두면 ORM이 엔티티 정의에 맞춰 테이블을 자동으로 생성하고 변경합니다. 편리한 기능입니다. 하지만 프로덕션에서 그대로 쓰기에는 위험합니다.

예를 들어 보겠습니다. `users` 테이블에 행이 5만 개 있습니다. 엔티티 클래스에서 컬럼 이름 하나를 `phone`에서 `mobile`로 바꿨습니다. `synchronize: true`이면 ORM은 이 변경을 "`phone`이 사라지고 `mobile`이 새로 생겼다"고 읽습니다. 그래서 `phone` 컬럼을 DROP하고 `mobile` 컬럼을 ADD합니다. 전화번호 5만 개가 그 순간 사라집니다.

**마이그레이션**(migration)은 스키마 변경을 버전 관리되는 명시적인 코드로 적어 두는 방식입니다. 무엇이 바뀌었는지 ORM이 추측하게 두지 않고 무엇을 할지 직접 적습니다.

```sql
-- What synchronize: true would do (DANGEROUS):
ALTER TABLE "users" DROP COLUMN "phone";
ALTER TABLE "users" ADD COLUMN "mobile" VARCHAR(20);
-- All phone data is lost!

-- What a migration does (SAFE):
ALTER TABLE "users" RENAME COLUMN "phone" TO "mobile";
-- Data preserved. Column renamed.
```

마이그레이션은 `synchronize: true`가 주지 못하는 세 가지를 줍니다.

1. **안전성**: 데이터베이스에 실행될 SQL을 직접 정합니다.
2. **이력**: 모든 스키마 변경이 코드처럼 버전 관리됩니다.
3. **되돌리기**: 문제가 생기면 변경을 되돌릴 수 있습니다.

---

## 마이그레이션 파일 만들기

마이그레이션은 메서드가 두 개인 클래스입니다.

- **`up()`**: 변경을 적용합니다(앞으로 이동).
- **`down()`**: 변경을 되돌립니다(뒤로 이동).

엘리베이터를 떠올리면 쉽습니다. `up()`은 다음 층으로 올라가는 버튼이고 `down()`은 이전 층으로 내려오는 버튼입니다.

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

`MigrationContext` 객체는 두 가지를 제공합니다.

| 속성 | 설명 |
|----------|------|
| `context.query(sql)` | SQL 문을 실행 |
| `context.driver` | 데이터베이스 드라이버에 접근 (DDL 헬퍼, 식별자 이스케이프 등) |

PostgreSQL과 SQLite에서는 `context.query()`와 `context.driver`의 헬퍼가 모두 마이그레이션의 트랜잭션 안에서 실행됩니다([마이그레이션과 트랜잭션](#마이그레이션과-트랜잭션) 참고).

---

## 마이그레이션 예제

### 컬럼 추가

지난주에 users 테이블을 배포했습니다. 이번에는 기획팀이 전화번호 필드를 요청했습니다. 이때 원래 마이그레이션을 고치지 않고 새 마이그레이션을 만듭니다.

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

`up()`을 실행하면 다음 SQL이 생성됩니다.

```sql
ALTER TABLE "users" ADD COLUMN "phone" VARCHAR(20) NULL;
```

`down()`으로 롤백하면 다음 SQL이 생성됩니다.

```sql
ALTER TABLE "users" DROP COLUMN "phone";
```

### 인덱스 추가

email로 필터링하는 쿼리가 느립니다. 그래서 인덱스를 추가합니다.

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

`up()`의 SQL은 다음과 같습니다.

```sql
CREATE INDEX "idx_users_email" ON "users" ("email");
```

### 초기 데이터 삽입

마이그레이션은 스키마 변경에만 쓰지 않습니다. 시드 데이터를 삽입하는 데에도 씁니다.

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

## 마이그레이션 추적 방식

마이그레이션을 처음 실행하면 Stingerloom이 `__migrations`라는 특수 테이블을 자동으로 생성합니다. 이 테이블에는 이미 적용된 마이그레이션이 기록됩니다.

PostgreSQL / SQLite에서는 테이블이 다음과 같습니다.

```sql
CREATE TABLE IF NOT EXISTS "__migrations" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL UNIQUE,
  "executed_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

MySQL에서는 다음과 같습니다.

```sql
CREATE TABLE IF NOT EXISTS `__migrations` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL UNIQUE,
  `executed_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

마이그레이션이 성공할 때마다 행이 하나 삽입됩니다.

```sql
INSERT INTO "__migrations" ("name") VALUES ('CreateUsersTable');
```

마이그레이션을 다시 실행하면 러너가 먼저 이 테이블을 조회합니다.

```sql
SELECT "name" FROM "__migrations" ORDER BY "id" ASC;
-- Returns: ['CreateUsersTable', 'AddPhoneToUsers']
```

그리고 조회한 목록을 등록된 마이그레이션과 비교해서 테이블에 아직 없는 것만 실행합니다. 그래서 마이그레이션은 **멱등**(idempotent)입니다. `migrate:run`을 두 번 실행해도 같은 마이그레이션이 두 번 적용되지 않습니다.

롤백하면 해당 행이 삭제됩니다.

```sql
DELETE FROM "__migrations" WHERE "name" = 'AddPhoneToUsers';
```

---

## 마이그레이션과 트랜잭션

PostgreSQL과 SQLite에서는 러너가 마이그레이션 하나를 `__migrations` 행과 함께 한 트랜잭션으로 적용합니다.

```sql
BEGIN;
-- up()이 실행하는 SQL 문 전부
INSERT INTO "__migrations" ("name") VALUES ('AddPhoneToUsers');
COMMIT;
```

SQL 문이 하나라도 실패하면 마이그레이션 전체가 롤백됩니다. 바뀐 것은 하나도 남지 않고 추적 행도 기록되지 않습니다. 그래서 `migrate:status`에는 그대로 대기 중으로 나옵니다. 마이그레이션을 고친 뒤 `migrate:run`을 다시 실행하면 깨끗한 상태에서 처음부터 적용됩니다. 되돌릴 때도 같습니다. `down()`과 추적 행의 `DELETE`가 함께 커밋되거나 함께 롤백됩니다.

트랜잭션 안에서 `context.query()`와 `context.driver`의 헬퍼는 트랜잭션이 잡은 연결 하나에서 실행됩니다. 러너를 생성할 때 넘긴 쿼리 러너는 거치지 않습니다. [훅](#마이그레이션-훅)은 트랜잭션 밖에서 호출됩니다. `beforeEach`는 `BEGIN` 전에 호출되고 `afterEach`는 `COMMIT` 뒤에 호출됩니다. `onError`는 `ROLLBACK` 뒤에 호출됩니다.

### MySQL과 MariaDB

MySQL은 스키마 변경을 실행하는 즉시 커밋합니다. 그래서 `CREATE TABLE`이나 `ALTER TABLE`은 트랜잭션으로 되돌릴 수 없습니다. 이 때문에 MySQL에서는 마이그레이션을 SQL 문 단위로 실행합니다. 도중에 실패하면 무엇이 적용된 채로 남았는지 에러 메시지에 나옵니다.

```
Unknown data type: 'NO_SUCH_TYPE'. It ran outside a transaction (MySQL commits each schema change as it runs), so what it ran before failing stays applied, including these 2 statements from context.query:
  CREATE TABLE `orders` (`id` INT PRIMARY KEY, `total` INT)
  ALTER TABLE `orders` ADD COLUMN `note` VARCHAR(20) NOT NULL DEFAULT 'x'
```

다시 실행하기 전에 이 SQL 문을 직접 되돌리세요. 아니면 이미 있는 것은 건너뛰도록 마이그레이션을 고치세요. 목록에는 `context.query()`로 실행한 SQL 문만 나옵니다. 다만 `context.driver` 헬퍼가 실행한 SQL 문도 적용된 채로 남아 있습니다.

`INSERT`, `UPDATE`, `DELETE`처럼 데이터만 바꾸는 마이그레이션은 MySQL에서도 `transaction = true`를 지정하면 원자적으로 실행됩니다.

### 트랜잭션 끄기

트랜잭션 안에서 실행할 수 없는 SQL 문도 있습니다. 그런 SQL 문을 쓰는 마이그레이션에는 `transaction = false`를 지정합니다. 필드로 지정해도 되고 getter로 지정해도 됩니다. 그러면 러너가 SQL 문을 하나씩 보내고 각 SQL 문은 실행되는 즉시 커밋됩니다.

```typescript
export class AddEmailIndex extends Migration {
  readonly transaction = false;

  async up(context: MigrationContext) {
    await context.query(`CREATE INDEX CONCURRENTLY "idx_users_email" ON "users" ("email")`);
  }

  async down(context: MigrationContext) {
    await context.query(`DROP INDEX CONCURRENTLY "idx_users_email"`);
  }
}
```

| SQL 문 | 트랜잭션 안에서는 |
|------|-------------------|
| PostgreSQL `CREATE INDEX CONCURRENTLY`, `DROP INDEX CONCURRENTLY`, `REINDEX ... CONCURRENTLY`, `VACUUM`, PostgreSQL 11 이하의 `ALTER TYPE ... ADD VALUE` | PostgreSQL이 거부합니다("cannot run inside a transaction block"). 마이그레이션은 롤백됩니다. 러너의 에러 메시지에는 `transaction = false`를 지정하라는 안내가 붙습니다. |
| PostgreSQL에서 같은 마이그레이션의 `ALTER TYPE ... ADD VALUE`로 추가한 enum 값을 쓰는 SQL 문 | 값을 추가한 트랜잭션이 커밋되기 전에는 그 값을 쓸 수 없습니다("unsafe use of new value"). 그 값을 쓰는 SQL 문을 다음 마이그레이션으로 옮기세요. 아니면 `transaction = false`를 지정하세요. |
| SQLite `PRAGMA foreign_keys = OFF` / `ON` | SQLite는 트랜잭션 안에서 이 PRAGMA를 무시합니다. 그래서 외래 키를 끄고 테이블을 다시 생성하는 마이그레이션도 외래 키가 켜진 채로 진행됩니다. 그러면 기존 테이블을 DROP할 때 그 테이블을 참조하는 모든 테이블의 `ON DELETE` 동작이 실행됩니다. 이 때문에 러너는 트랜잭션 안에서 이 SQL 문을 거부하고 아무것도 적용하지 않습니다. 트랜잭션 안에서는 `PRAGMA defer_foreign_keys = ON`을 쓰세요. 아니면 `transaction = false`를 지정하세요. |

`transaction`을 지정하지 않으면 데이터베이스에 따라 정해집니다. PostgreSQL과 SQLite는 마이그레이션을 트랜잭션 안에서 실행합니다. MySQL은 트랜잭션 없이 실행합니다. 트랜잭션을 열 수 없는 드라이버에서 `transaction = true`를 지정하면 마이그레이션은 아무것도 실행하지 않고 실패합니다.

---

## 마이그레이션 실행하기

마이그레이션을 실행하는 방법은 두 가지입니다. 가장 간단한 방법은 내장 CLI입니다. 커스텀 설정이 필요하면 프로그래밍 방식 API를 씁니다.

### 내장 CLI 사용 (권장)

Stingerloom에는 CLI 실행 파일이 들어 있습니다. 이 CLI는 설정 파일을 읽고 터미널에서 바로 마이그레이션을 실행합니다.

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

CLI는 프로젝트 루트에서 설정 파일을 자동으로 찾습니다. 검색하는 파일 이름과 순서는 다음과 같습니다.

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

CLI 플래그로 설정 경로를 바꾸고 옵션을 지정할 수 있습니다.

```bash
npx stingerloom migrate:run --config ./config/prod.config.ts
npx stingerloom migrate:generate --output ./src/migrations --name AddEmailIndex
```

| 플래그 | 설명 |
|------|------|
| `--config <path>` | 설정 파일 경로 (기본값: 자동 탐지) |
| `--output <dir>` | 생성된 마이그레이션을 쓸 디렉터리 (기본값: `./migrations`) |
| `--name <suffix>` | 생성되는 파일의 마이그레이션 이름 접미사 |
| `--help` | 도움말 표시 |

> CLI는 `ts-node`나 `tsx`로 TypeScript 설정 파일을 바로 읽습니다. 둘 다 설치되어 있지 않으면 `.js` 설정 파일을 쓰세요.

### 동시성 안전: 어드바이저리 잠금

여러 서버가 동시에 시작되면 마이그레이션을 동시에 실행하려 할 수 있습니다. Kubernetes 배포에서 흔한 상황입니다. 이러면 테이블을 중복으로 생성하는 에러가 나거나 더 나쁜 일이 생길 수 있습니다.

Stingerloom은 **어드바이저리 잠금**(advisory lock)으로 이 문제를 막습니다. 러너는 마이그레이션을 실행하기 전에 데이터베이스 수준의 잠금을 획득합니다.

```
Server A: acquireAdvisoryLock("stingerloom_migration_lock") -> acquired!
Server B: acquireAdvisoryLock("stingerloom_migration_lock") -> waiting...
Server A: runs migrations, releases lock
Server B: acquireAdvisoryLock("stingerloom_migration_lock") -> acquired!
Server B: checks __migrations table, finds nothing pending, exits
```

타임아웃 안에 잠금을 획득하지 못하면 러너가 `AdvisoryLockError`를 던집니다(기본값: 10초). 이 에러로 보고되는 것은 타임아웃이 지났을 때뿐입니다. 잠금을 얻는 중에 다른 실패가 생기면 러너는 그 에러를 그대로 던집니다. 끊긴 연결, 취소된 백엔드, MySQL `GET_LOCK`이 보고한 에러가 그 예입니다.

이 잠금은 데이터베이스 세션에 속합니다. 그래서 러너는 실행하는 동안 풀의 연결 하나를 계속 잡고 있다가 그 연결에서 잠금을 해제합니다. 마이그레이션의 SQL 문은 풀의 나머지 연결을 씁니다. 풀 크기가 1이면 모든 SQL 문이 공유하는 그 연결에서 잠금을 잡습니다. 이때 다른 프로세스는 막지만 같은 프로세스의 두 번째 러너는 막지 못합니다. 애플리케이션 코드에서 마이그레이션을 실행한다면 풀 크기를 2 이상으로 두세요.

### MigrationCli 사용 (프로그래밍 방식)

더 세밀하게 제어하려면 커스텀 마이그레이션 스크립트를 만드세요. 설정을 환경 변수에서 읽을 때 유용합니다. 마이그레이션 전후에 커스텀 로직이 필요할 때도 유용합니다.

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

package.json에 스크립트를 등록해 두면 편합니다.

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

## 마이그레이션 결과 확인

각 마이그레이션은 성공 여부를 담은 결과 객체를 반환합니다.

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

마이그레이션이 실패하면 러너는 즉시 멈추고 이후 마이그레이션을 실행하지 않습니다. 이후 마이그레이션은 대부분 실패한 마이그레이션에 의존하기 때문입니다. PostgreSQL과 SQLite에서는 실패한 마이그레이션이 이미 롤백된 상태입니다. MySQL에서는 적용된 채로 남은 SQL 문이 `result.error`에 나옵니다([마이그레이션과 트랜잭션](#마이그레이션과-트랜잭션) 참고).

---

## 파일 네이밍 규칙

마이그레이션은 배열에 등록한 순서대로 실행됩니다. 파일 이름에 순번을 붙여 순서가 드러나게 하세요.

```
migrations/
├── 001_CreateUsersTable.ts
├── 002_CreatePostsTable.ts
├── 003_AddPhoneToUsers.ts
├── 004_AddEmailIndex.ts
└── 005_SeedRoles.ts
```

---

## Schema Diff: 마이그레이션 자동 생성

간단한 변경은 마이그레이션 파일을 직접 작성해도 됩니다. 하지만 복잡한 변경을 직접 작성하기는 번거롭습니다. Schema Diff는 엔티티 정의를 실제 데이터베이스 스키마와 비교해서 필요한 마이그레이션 코드를 자동으로 생성합니다.

### Schema Diff 동작 과정

`SchemaDiff.diff()` 안에서는 다음 일이 차례로 일어납니다.

**Step 1: 엔티티 정의 읽기.** Diff 엔진은 `reflect-metadata`로 모든 `@Entity` 클래스와 그 `@Column` 정의를 추출합니다. 테이블 이름, 컬럼 이름, 타입, 길이, null 허용 여부가 여기에 들어갑니다.

**Step 2: 실제 데이터베이스 조회.** `information_schema` 쿼리를 실행해서 실제로 존재하는 테이블과 컬럼을 확인합니다.

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

**Step 3: 비교.** 엔티티마다 다음을 확인합니다.
- 데이터베이스에 테이블이 있는지 확인합니다. 없으면 `addTables`에 들어갑니다.
- 엔티티의 각 컬럼이 데이터베이스에 있는지 확인합니다. 없으면 `addColumns`에 들어갑니다.
- 데이터베이스의 각 컬럼이 엔티티에 있는지 확인합니다. 없으면 `dropColumns`에 들어갑니다.
- 컬럼이 양쪽에 다 있으면 타입과 길이가 같은지 확인합니다. 다르면 `alterColumns`에 들어갑니다.

**Step 4: 이름 변경 감지.** 엔진은 결과를 확정하기 전에 증명할 수 있는 이름 변경을 찾습니다. 명시된 `renamedFrom`이 그렇고 이름이 같은 컬럼으로 읽히는 add/drop 쌍도 그렇습니다. 그보다 확실하지 않은 것은 이름 변경 후보로 보고합니다(아래에서 설명).

**Step 5: 마이그레이션 코드 생성.** `SchemaDiffMigrationGenerator`가 diff 결과를 받아 마이그레이션 클래스를 생성합니다. 이 클래스에는 diff에 맞는 `up()`과 `down()` 메서드가 들어 있습니다.

### CLI 사용

마이그레이션을 생성하는 가장 간단한 방법입니다.

```bash
npx stingerloom migrate:generate
```

이 명령은 다음 순서로 동작합니다.
1. 설정 파일로 데이터베이스에 연결합니다.
2. 설정한 엔티티의 관계를 검사합니다. 검사 방식은 `synchronize`로 스키마를 생성할 때 `register()`가 하는 검사와 같습니다. `register()`가 거부할 관계가 있으면 `SCHEMA_ERROR`로 멈추고 파일을 쓰지 않습니다. 복합 기본 키의 일부를 참조하는 외래 키가 그 예입니다.
3. 등록된 모든 엔티티로 `SchemaDiff.diff()`를 실행합니다.
4. 차이가 있으면 타임스탬프가 붙은 마이그레이션 파일을 생성합니다.
5. 스키마가 이미 동기화되어 있으면 "No schema changes"를 출력하고 종료합니다.

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
SQLite는 컬럼의 타입이나 null 허용 여부를 `ALTER`로 바꾸지 못합니다. diff에 이런 변경이 있고 다이얼렉트가 `"sqlite"`이면 `generate()`와 `dryRun()`은 모두 `ORM_UNSUPPORTED_OPERATION`을 던집니다. 에러에는 영향받는 컬럼 목록이 담깁니다. 그 변경을 아무 표시 없이 빼먹은 마이그레이션은 만들지 않습니다. 이때는 테이블을 다시 만드는 수동 마이그레이션을 작성해야 합니다. 원하는 스키마로 새 테이블을 생성하고 데이터를 복사합니다. 그리고 기존 테이블을 삭제한 뒤 새 테이블의 이름을 바꿉니다.
:::

### 예제: 컬럼 추가

User 엔티티에 `phone` 컬럼을 추가합니다.

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

`migrate:generate`를 실행하면 `phone`이 엔티티에는 있지만 데이터베이스에는 없다는 것을 감지합니다. 그리고 다음 마이그레이션을 생성합니다.

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

컬럼 이름을 바꾸면 단순한 방식은 이 변경을 "삭제"와 "추가"로 읽습니다. 이전 이름이 사라지고 새 이름이 나타났기 때문입니다. Schema Diff는 그 쌍을 이름 변경으로 알아보려고 합니다. 하지만 이름 변경과 컬럼 *교체*는 완전히 같은 모양입니다. 그래서 잘못 짚으면 삭제된 컬럼의 데이터가 새 컬럼 이름으로 되살아납니다. 이 때문에 엔진은 확실할 때만 RENAME을 실행합니다.

테이블마다 이런 순서로 판단합니다.

1. **삭제될 컬럼**과 **추가될 컬럼**을 모읍니다. 삭제될 컬럼은 데이터베이스에 있지만 엔티티에 없는 컬럼입니다. 추가될 컬럼은 엔티티에 있지만 데이터베이스에 없는 컬럼입니다.
2. 엔티티가 `@Column({ renamedFrom })`으로 명시한 쌍을 먼저 확정합니다. 명시한 힌트가 항상 우선합니다.
3. 나머지 중에서는 타입이 호환되는 쌍만 남깁니다. 데이터베이스가 길이나 정밀도를 보고하면 그 값까지 같아야 합니다.
4. 두 이름이 같은 컬럼으로 읽히고 양쪽 모두 똑같이 그럴듯한 다른 짝이 없을 때만 이름 변경으로 확정합니다.
5. 나머지는 **이름 변경 후보**로 보고합니다. 그리고 선언된 그대로 drop + add를 적용합니다.

두 이름은 다음 경우에 같은 컬럼으로 읽힙니다.

- 대소문자와 구분자만 다를 때: `user_name` -> `userName`
- 한쪽이 다른 쪽을 포함할 때: `name` -> `fullName`, `legacyNote` -> `note`
- 편집 거리가 짧을 때: `recieved_at` -> `received_at`

`legacyNote` -> `bio`나 `createdAt` -> `updatedAt`처럼 서로 무관한 이름은 이름 변경으로 보지 않습니다.

엔진이 알아보는 이름 변경은 이렇게 처리됩니다.

```typescript
// Before
@Column({ type: "varchar", length: 20 })
phone!: string;

// After
@Column({ type: "varchar", length: 20 })
phoneNumber!: string;
```

Diff 엔진은 이 변경을 다음과 같이 봅니다.
- 삭제: `phone` (타입: VARCHAR(20))
- 추가: `phoneNumber` (타입: VARCHAR(20))
- 같은 테이블, 호환되는 타입, 같은 컬럼으로 읽히는 이름: 이름 변경으로 판단

생성된 마이그레이션은 `DROP` + `ADD` 대신 `RENAME COLUMN`을 씁니다.

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

새 이름이 예전 이름과 아무 관계가 없으면 ORM에 직접 알려 주세요.

```typescript
@Column({ type: "varchar", length: 100, renamedFrom: "legacyNote" })
bio!: string;
```

`renamedFrom`에는 값을 가져올 데이터베이스 컬럼 이름을 적습니다. 이 옵션이 있으면 synchronize와 `migrate:generate`가 `RENAME COLUMN`을 내보냅니다. 옵션이 없으면 `bio`를 빈 컬럼으로 추가하고 `legacyNote`를 삭제합니다. 엔티티가 선언한 내용을 그대로 따른 동작입니다. 그 이름의 컬럼이 더 이상 없으면 이 옵션은 아무 일도 하지 않습니다. 그래서 이름 변경이 모든 환경에 반영된 뒤에 지우면 됩니다. `defineEntity`에서는 `t.varchar(100).renamedFrom("legacyNote")`로 같은 설정을 합니다. `EntitySchema` 컬럼에서는 `renamedFrom: "legacyNote"`로 설정합니다.

#### 거절된 이름 변경의 경고

`synchronize`는 drop + add를 적용하기 전에 쌍마다 경고를 한 줄씩 남깁니다.

```
[sync] profile.bio is being added while the dropped column "legacyNote" has the
same type but an unrelated name. Treating it as a new column: nothing is copied
from legacyNote. If it is a rename, declare
@Column({ renamedFrom: "legacyNote" }) (or write a migration) before this sync runs.
```

`migrate:generate`는 결정한 ADD/DROP을 씁니다. 그리고 그 뒤에 이름 변경을 주석 처리된 대안으로 덧붙입니다.

```typescript
// POSSIBLE RENAME (name differs from the dropped legacyNote) -- uncomment INSTEAD of the ADD/DROP pair above if this is a rename:
// await query(`ALTER TABLE "profile" RENAME COLUMN "legacyNote" TO "bio"`)
```

거절된 쌍은 diff 결과의 `renameCandidates`에도 담깁니다. 각 항목에는 다음이 들어 있습니다.

- 추가될 컬럼
- 그 컬럼에 맞는 삭제될 컬럼들(가장 잘 맞는 것부터)
- `reason`: `"ambiguous"`(여러 개가 맞음) 또는 `"dissimilar-names"`(타입만 맞음)

> 이름 변경에도 `synchronize.failOnDestructiveChange`가 적용됩니다. 이 플래그를 켜면 synchronize는 부팅 중에 데이터를 옮기지 않습니다. 대신 이름 변경을 거부하고 `ORM_SCHEMA_SYNC_DESTRUCTIVE_CHANGE`를 던집니다.

> Schema Diff는 테이블과 컬럼의 추가, 삭제, 이름 변경을 감지합니다. 컬럼 타입 변경은 diff 결과의 `alterColumns`로 감지됩니다(예: VARCHAR를 TEXT로 변경). 하지만 안전을 위해 이런 변경은 수동 마이그레이션으로 작성하세요.

### ENUM 값 동기화 (PostgreSQL)

대부분의 스키마 변경은 테이블 수준에서 일어납니다. 하지만 PostgreSQL에는 특이한 점이 있습니다. ENUM 타입은 테이블 밖에 있는 별도의 데이터베이스 객체입니다. `@Column({ type: "enum", enumValues: ["admin", "user"] })`로 컬럼을 정의하면 PostgreSQL이 `users_role_enum` 같은 이름 있는 타입을 생성합니다. 그리고 컬럼은 그 타입을 참조합니다.

문제는 이렇습니다. 새 역할을 추가한다고 해 봅시다.

```typescript
@Column({
  type: "enum",
  enumValues: ["admin", "user", "moderator"],  // "moderator" is new
})
role!: string;
```

일반적인 `ALTER TABLE`로는 이 변경을 감지하지 못합니다. 컬럼 타입은 여전히 `users_role_enum`이라 바뀌지 않았기 때문입니다. 바뀐 것은 enum 타입 정의 자체입니다. 자동 동기화가 없으면 다음 SQL을 직접 작성해야 합니다.

```sql
ALTER TYPE "users_role_enum" ADD VALUE IF NOT EXISTS 'moderator';
```

SchemaDiff는 PostgreSQL에서 이 작업을 자동으로 처리합니다.

> 힌트: `synchronize`도 부팅할 때 같은 두 작업을 실행합니다. 마이그레이션 파일을 거치지 않고 없는 enum 타입을 생성하고 빠진 값을 추가합니다. 자세한 동작은 [설정](./configuration.md#postgresql-enum-타입)을 참고하세요.

동작 방식은 다음과 같습니다. SchemaDiff는 diff 단계에서 테이블과 컬럼을 비교한 뒤 PostgreSQL enum 타입을 한 번 더 검사합니다.

1. 엔티티의 `@Column({ type: "enum" })`마다 데이터베이스의 `pg_enum`과 `pg_type`에서 현재 enum 값을 읽습니다.
2. 엔티티 정의의 값과 데이터베이스의 값을 비교합니다.
3. 새 값은 `addValues`에 들어가고 제거된 값은 `removeValues`에 들어갑니다.

결과는 diff의 `enumChanges` 배열에 저장됩니다.

```typescript
interface EnumChange {
  enumName: string;        // e.g. "users_role_enum"
  addValues: string[];     // values to add
  removeValues: string[];  // values that were removed
  isNew: boolean;          // true if the entire enum type needs to be created
}
```

**생성되는 마이그레이션: 값 추가**

enum에 `"moderator"`를 추가하면 마이그레이션 생성기가 다음 코드를 생성합니다.

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

`IF NOT EXISTS` 절 덕분에 여러 번 실행해도 안전합니다. 값이 이미 있으면 PostgreSQL이 에러 없이 건너뜁니다.

**생성되는 마이그레이션: 값 제거**

PostgreSQL에는 근본적인 제약이 있습니다. 기존 enum 타입에서는 값을 제거할 수 없습니다. 유일한 방법은 타입 전체를 drop하고 다시 생성하는 것입니다. 그러려면 그 타입을 참조하는 모든 컬럼을 갱신해야 합니다. 그래서 마이그레이션 생성기는 안전하지 않은 DDL 대신 경고 주석을 남깁니다.

```sql
-- WARNING: Cannot remove enum values from "users_role_enum": guest.
-- Recreate the type manually if needed.
```

일부러 신중하게 처리한 것입니다. enum 타입을 drop하고 다시 생성하는 일은 여러 단계로 이루어집니다. 그리고 제거한 값을 가진 행이 있으면 실패할 수 있습니다. 과정을 직접 제어하는 수동 마이그레이션이 더 안전합니다.

**MySQL의 경우**

MySQL은 값을 컬럼 타입 자체에 담습니다(`role ENUM('admin','user','moderator')`). 그런데 diff는 `ENUM`, `enum` 같은 타입 이름만 비교하고 안의 값 목록은 보지 않습니다. 그래서 MySQL / MariaDB에서는 값 목록을 바꿔도 `migrate:generate`와 `synchronize`가 모두 감지하지 못합니다. `MODIFY COLUMN`을 직접 작성하세요.

```sql
ALTER TABLE `users` MODIFY COLUMN `role` ENUM('admin','user','moderator') NOT NULL;
```

### Schema Diff가 비교하지 않는 항목

아직 없는 테이블은 `synchronize`와 생성된 마이그레이션 모두 빠짐없이 생성합니다. 컬럼, 각 관계의 외래 키 컬럼, 인덱스, 외래 키 제약 조건, `@ManyToMany` 관계의 조인 테이블까지 포함합니다. 생성된 `down()`은 같은 것을 역순으로 삭제합니다.

이미 있는 테이블에서 diff가 비교하는 것은 컬럼입니다. 컬럼의 존재 여부, 타입, 길이, 정밀도, null 허용 여부를 봅니다. 이름 변경, 생성 컬럼, PostgreSQL enum 값도 봅니다. `synchronize`는 여기에 더해 엔티티에 새로 생긴 인덱스와 외래 키를 생성합니다. 아래 표의 나머지는 데이터베이스에 있는 그대로 남습니다. 표의 결과는 PostgreSQL, MariaDB, SQLite에서 직접 측정했습니다.

| 기존 테이블의 변경 | `synchronize` | `migrate:generate` |
|--------------------|---------------|--------------------|
| 컬럼 추가·삭제, 타입·길이·nullable 변경 | 적용(모드가 허용하는 만큼) | 생성 |
| 컬럼 이름 변경(`renamedFrom` 또는 같은 컬럼으로 읽히는 이름) | 적용 | 생성 |
| `@ComputedColumn` 추가 | 적용 | 생성 |
| PostgreSQL enum 값 추가 | 적용 | 생성 |
| `@Index`, `@UniqueIndex`, 클래스 레벨 `@Index([...])`, `@FullTextIndex` 추가 | 생성 | 생성 안 함 |
| 관계 추가(`@ManyToOne`, 소유 측 `@OneToOne`) | 컬럼과 제약 조건 생성. SQLite는 기존 테이블에 제약 조건을 추가하지 못하므로 컬럼만 생성 | 컬럼만 |
| `@ManyToMany` 추가(조인 테이블이 없는 경우) | 조인 테이블 생성 | 생성 |
| 관계 제거 | PostgreSQL은 컬럼 삭제. MySQL / MariaDB와 SQLite는 제약 조건이 아직 컬럼을 참조하므로 삭제가 경고와 함께 실패 | `DROP COLUMN`을 주석 처리해서 작성 |
| 엔티티에서 인덱스·고유 인덱스 제거 | 그대로 남음 | 생성 안 함 |
| 같은 이름으로 인덱스 정의 변경 | 예전 정의 그대로 | 생성 안 함 |
| 이름이 자동 생성된 고유 인덱스의 컬럼 변경 | 새 인덱스 생성. 옛 인덱스도 남아 계속 제약을 걺 | 생성 안 함 |
| 컬럼 `default` 추가·변경·제거 | 비교 안 함 | 비교 안 함 |
| 관계 `onDelete` / `onUpdate` 변경 | 비교 안 함 | 비교 안 함 |
| `@ComputedColumn` 표현식 변경 | 비교 안 함 | 비교 안 함 |
| MySQL / MariaDB `ENUM` 값 변경 | 비교 안 함 | 비교 안 함 |
| 엔티티 제거 | 테이블 유지 | 테이블 유지 |

기존 테이블에 추가되는 컬럼은 CREATE TABLE에서처럼 선언한 `default`를 갖고 추가됩니다. 그래서 이미 있던 행에도 그 값이 들어갑니다. 선언한 default가 없으면 NOT NULL 텍스트·숫자·불리언 컬럼은 각각 `''`, `0`, `FALSE`로 채웁니다. 날짜, enum, JSON 같은 그 밖의 NOT NULL 컬럼은 경고와 함께 nullable로 추가합니다. SQLite는 `"(CURRENT_TIMESTAMP)"` 같은 표현식 default로 컬럼을 추가하지 못합니다. 그래서 그 컬럼은 default 없이 추가하고 경고에 컬럼 이름을 남깁니다.

이런 수정 뒤에 재시작하면 동기화가 성공한 것처럼 보이기 쉽습니다. 그래서 `synchronize`와 `migrate:generate`는 모두 이 사실을 알립니다. 이미 있던 테이블이 하나라도 있으면 `synchronize`는 부팅할 때마다 로그를 한 줄 남깁니다. 이 로그에는 엔티티가 실제로 쓰는 종류만 나열됩니다. 예를 들어 `default`는 어떤 컬럼이 선언했을 때만 목록에 들어갑니다.

```
INFO [SchemaRegistrar] [sync] synchronize does not apply these to existing tables: changed column defaults, removed or redefined indexes. Write a migration for them (see docs/migrations.md#what-the-schema-diff-does-not-compare).
```

`migrate:generate`도 실행한 뒤에 같은 로그를 남깁니다. 이때는 목록 맨 앞에 "new indexes and foreign key constraints"가 붙습니다. 이런 변경은 마이그레이션에 직접 작성하세요. 작성 형태는 [인덱스 추가](#인덱스-추가)를 참고하면 됩니다.

---

## 마이그레이션 훅

MigrationRunner는 생명주기 훅을 지원합니다. 이 훅으로 마이그레이션을 실행하는 동안 모니터링, 로깅, 에러 처리를 합니다.

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

`MigrationRunner`는 추상 클래스입니다. 다이얼렉트에 맞는 러너를 생성하세요. `MySqlMigrationRunner`, `PostgresMigrationRunner`, `SqliteMigrationRunner`가 있습니다. 러너는 마이그레이션 목록, 드라이버, 쿼리 러너를 차례로 받고 마지막에 옵션을 받습니다. 쿼리 러너는 `query(sql)` 메서드가 있는 객체면 무엇이든 됩니다.

```typescript
import { PostgresMigrationRunner } from "@stingerloom/orm";

const runner = new PostgresMigrationRunner(migrations, em.getDriver()!, queryRunner, {
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

모든 훅은 비동기(Promise 반환)여도 되고 동기여도 됩니다. 훅은 마이그레이션의 트랜잭션 밖에서 호출됩니다. 그리고 훅이 받는 `context`는 쿼리 러너로 SQL 문을 보냅니다. 그래서 훅이 실행한 SQL 문은 마이그레이션이 롤백돼도 되돌아가지 않습니다.

---

## MigrationRunner API

| 메서드 | 설명 |
|--------|------|
| `run(migrations?)` | 대기 중인 마이그레이션을 순서대로 실행 |
| `rollback(n?)` | 마지막 n개 마이그레이션을 롤백 (기본값: 1) |
| `status()` | `{ executed: string[], pending: string[] }`을 반환 |
| `runAll()` | 대기 중인 모든 마이그레이션을 실행 |
| `runUp(migration)` | 마이그레이션 하나를 적용 |
| `runDown(migration)` | 마이그레이션 하나를 되돌림 |
| `revertLast()` | 마지막 마이그레이션을 되돌림 |
| `getPendingMigrations()` | 대기 중인 마이그레이션 목록을 반환 |
| `getExecutedMigrations()` | 실행된 마이그레이션 목록을 반환 |

---

## 다음 단계

- [설정](./configuration.md): 풀링, 타임아웃, 읽기 레플리카 설정
- [멀티테넌시](./multi-tenancy.md): 테넌트별 자동 스키마 프로비저닝
- [이벤트와 구독자](./events.md): 생명주기 훅과 엔티티 이벤트 시스템
