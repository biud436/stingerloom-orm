# Migration CLI

## 마이그레이션이 필요한 이유

개발 중에는 `synchronize: true`가 편해요. 엔티티를 바꾸고 앱을 재시작하면 ORM이 알아서 DB 스키마를 맞춰주니까요. 하지만 프로덕션에서는 위험해요. 컬럼 이름을 바꾸는 변경을 배포하면 `synchronize`는 기존 컬럼(과 데이터)을 삭제하고 빈 컬럼을 새로 만들어요.

마이그레이션은 DB 변경을 **명시적이고 리뷰 가능하게** 만들어줘요. ORM이 몰래 스키마를 바꾸는 대신, 정확히 무엇이 바뀌는지 파일로 남겨요. 리뷰하고, 테스트하고, 그 다음에 프로덕션에 적용하면 돼요. 문제가 생기면 롤백도 가능해요.

DB 스키마의 버전 관리라고 생각하면 돼요. 각 마이그레이션은 스키마를 앞으로(또는 뒤로) 이동시키는 하나의 커밋이에요.

## 마이그레이션 워크플로우

전체 흐름을 처음부터 끝까지 살펴볼게요.

**1. 엔티티를 변경해요.** `User` 클래스에 `phone` 컬럼을 추가해요:

```typescript
@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Column()
  email!: string;

  @Column({ nullable: true })  // <-- new column
  phone!: string;
}
```

**2. 마이그레이션을 생성해요.** CLI가 엔티티 정의와 실제 DB를 비교해서 마이그레이션 파일을 만들어요:

```bash
npx stingerloom migrate:generate --name add_phone_to_users
```

`migrations/1711234567892_add_phone_to_users.ts` 같은 파일이 생겨요:

```typescript
import { Migration, MigrationContext } from "@stingerloom/orm";

export class AddPhoneToUsers1711234567892 extends Migration {
  async up({ query, driver }: MigrationContext) {
    await query(
      `ALTER TABLE ${driver.escapeIdentifier("user")} ADD COLUMN ${driver.escapeIdentifier("phone")} VARCHAR(255)`
    );
  }

  async down({ query, driver }: MigrationContext) {
    await query(
      `ALTER TABLE ${driver.escapeIdentifier("user")} DROP COLUMN ${driver.escapeIdentifier("phone")}`
    );
  }
}
```

**3. 마이그레이션을 리뷰해요.** 파일을 열어서 SQL을 확인하고, 의도한 대로인지 검토해요. 이게 안전장치예요.

**4. 마이그레이션을 적용해요.**

```bash
npx stingerloom migrate:run
```

CLI가 `up()` 메서드를 실행하고, 다시 실행되지 않도록 tracking 테이블에 기록해요.

**5. 문제가 생기면 롤백해요.**

```bash
npx stingerloom migrate:rollback
```

`down()` 메서드를 호출해서 변경을 되돌려요.

## 설치

CLI는 `@stingerloom/orm` 패키지에 포함되어 있고, `stingerloom` 바이너리로 등록돼요.

```bash
npx stingerloom <command> [options]
```

## 명령어

### migrate:run

대기 중인 모든 마이그레이션을 순서대로 실행해요.

```bash
npx stingerloom migrate:run
```

advisory lock으로 동시 실행을 방지해요(자세한 내용은 아래 참고). 성공적으로 적용된 마이그레이션은 `__migrations` tracking 테이블에 기록돼요.

### migrate:rollback

마지막으로 적용된 마이그레이션 하나를 되돌려요.

```bash
npx stingerloom migrate:rollback
```

가장 최근에 실행된 마이그레이션의 `down()` 메서드를 호출하고 tracking 테이블에서 해당 기록을 삭제해요. 한 번에 하나의 마이그레이션만 롤백돼요 -- 더 되돌리려면 여러 번 실행하면 돼요.

### migrate:status

어떤 마이그레이션이 실행됐고, 어떤 것이 대기 중인지 보여줘요.

```bash
npx stingerloom migrate:status
```

출력 예시:

```
Migration Status
================

Executed:
  [2026-03-01 14:23:01]  CreateUsersTable
  [2026-03-05 09:15:32]  AddPhoneToUsers

Pending:
  CreatePostsTable
  AddCategoryToPosts

Summary: 2 executed, 2 pending
```

"Executed" 목록은 이미 적용된 마이그레이션과 실행 시각이에요. "Pending" 목록은 코드에는 있지만 아직 이 DB에 적용되지 않은 마이그레이션이에요. `migrate:run`을 실행하면 순서대로 적용돼요.

### migrate:generate

엔티티 정의와 현재 DB 스키마를 비교해서 마이그레이션 파일을 자동 생성해요.

```bash
npx stingerloom migrate:generate --output ./migrations --name add_posts
```

`SchemaDiff`를 실행해서 변경 사항을 감지하고, `up()`과 `down()` 메서드가 포함된 타임스탬프 파일을 생성해요.

## CLI 옵션

| Flag | 설명 | 기본값 |
|------|------|--------|
| `--config <path>` | 설정 파일 경로 | 자동 감지 |
| `--output <dir>` | 생성된 마이그레이션 출력 디렉토리 | `./migrations` |
| `--name <suffix>` | 생성된 마이그레이션 파일의 이름 접미사 | `auto_migration` |
| `--help`, `-h` | 도움말 표시 | -- |

## 설정 파일

CLI는 다음 순서로 설정 파일을 자동 감지해요:

1. `stingerloom.config.ts`
2. `stingerloom.config.js`
3. `stingerloom.config.mjs` / `stingerloom.config.cjs`
4. `ormconfig.ts`
5. `ormconfig.js`
6. `ormconfig.mjs` / `ormconfig.cjs`

또는 `--config`로 직접 지정할 수 있어요. ES 모듈 설정 파일은 지원하는 모든 Node 버전에서 동작합니다 — `"type": "module"` 프로젝트의 `.js` 설정(`export default {...}`)은 `require()`가 처리하지 못하면 동적 `import()`로 로드됩니다.

### 설정 파일 구조

```typescript
// stingerloom.config.ts
import { CreateUsersTable } from "./migrations/CreateUsersTable";
import { AddPhoneToUsers } from "./migrations/AddPhoneToUsers";
import { User } from "./entities/User";
import { Post } from "./entities/Post";

export default {
  connection: {
    type: "postgres",           // "postgres" | "mysql" | "sqlite"
    host: "localhost",
    port: 5432,
    username: "postgres",
    password: "password",
    database: "mydb",
    entities: [User, Post],     // Required for migrate:generate
  },
  migrations: [
    new CreateUsersTable(),
    new AddPhoneToUsers(),
  ],
};
```

`entities` 배열은 `migrate:generate`에서만 필요해요 -- CLI가 스키마가 어떤 모습이어야 하는지 파악하는 데 사용돼요. `migrations` 배열은 실행 순서대로 마이그레이션 클래스를 나열해요.

`connection` 래퍼 없이 평면 `DatabaseClientOptions` 객체도 그대로 사용할 수 있습니다: `export default { type: "sqlite", database: "./app.sqlite", migrations: [] }`.

> **Note** TypeScript 설정 파일은 `ts-node` 또는 `tsx`가 설치되어 있어야 해요. CLI는 먼저 `ts-node/register`를 시도하고, 실패하면 `tsx/cjs`로 fallback해요.

## 마이그레이션 작성

각 마이그레이션은 `Migration`을 확장하고 `up()`과 `down()`을 구현하는 클래스예요:

```typescript
import { Migration, MigrationContext } from "@stingerloom/orm";

export class CreateUsersTable extends Migration {
  async up({ query, driver }: MigrationContext) {
    await query(`
      CREATE TABLE ${driver.escapeIdentifier("users")} (
        ${driver.escapeIdentifier("id")} SERIAL PRIMARY KEY,
        ${driver.escapeIdentifier("name")} VARCHAR(255) NOT NULL,
        ${driver.escapeIdentifier("email")} VARCHAR(255) NOT NULL UNIQUE,
        ${driver.escapeIdentifier("created_at")} TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  }

  async down({ query, driver }: MigrationContext) {
    await query(`DROP TABLE IF EXISTS ${driver.escapeIdentifier("users")}`);
  }
}
```

`MigrationContext`가 제공하는 것들:

| Property | Type | 설명 |
|----------|------|------|
| `driver` | `ISqlDriver` | `escapeIdentifier()`와 DDL 헬퍼를 제공하는 DB 드라이버 |
| `query` | `(sql: string) => Promise<any>` | 임의의 SQL 실행 |

`driver.escapeIdentifier()`를 쓰는 이유는 DB마다 인용 방식이 달라서예요. PostgreSQL은 `"double quotes"`, MySQL은 `` `backticks` ``를 써요. `escapeIdentifier()`를 사용하면 마이그레이션이 여러 DB에서 동작하고, 예약어(`user`, `order` 등)도 안전하게 이스케이프돼요.

## 마이그레이션 추적

CLI는 적용된 마이그레이션을 추적하기 위해 `__migrations` 테이블을 자동으로 생성해요:

```sql
CREATE TABLE "__migrations" (
  "id"          SERIAL PRIMARY KEY,
  "name"        VARCHAR(255) NOT NULL UNIQUE,
  "executed_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

이 테이블이 기준이에요. `migrate:run`을 실행하면 CLI가 이 테이블을 읽어서 이미 적용된 마이그레이션을 건너뛰고, `migrate:rollback`을 실행하면 마지막 항목을 찾아서 되돌려요.

## 동시성 안전 -- Advisory Lock

### 동시 마이그레이션이 위험한 이유

클러스터의 두 서버가 동시에 배포하면서 둘 다 마이그레이션을 실행한다고 생각해 보세요. 서버 A가 `posts` 테이블을 생성하기 시작하고, 서버 B도 모르고 같은 테이블을 생성하려고 해요. 결과는 DB 에러, 반쯤 적용된 마이그레이션, 그리고 큰 문제예요.

더 나쁜 경우, 두 프로세스가 서로 다른 마이그레이션을 동시에 실행하면 순서가 꼬여서 스키마가 불일치 상태가 될 수 있어요.

### Advisory Lock이 이를 방지하는 방법

마이그레이션을 실행하기 전에 CLI는 **database advisory lock**을 획득해요 -- 파일이나 메모리가 아닌 DB 자체에 존재하는 협력적 잠금이에요. 같은 잠금을 획득하려는 다른 프로세스는 첫 번째 프로세스가 해제할 때까지 대기해요.

- **PostgreSQL:** `pg_advisory_lock(key)` / `pg_advisory_unlock(key)`
- **MySQL:** `GET_LOCK(name, timeout)` / `RELEASE_LOCK(name)`

고정된 키를 사용하기 때문에 모든 서버의 마이그레이션 프로세스가 DB를 통해 조율돼요. 다른 마이그레이션이 이미 실행 중이면 CLI는 최대 10초간 대기한 후 `AdvisoryLockError`를 던져요.

여러 서버에 동시 배포해도 안전해요 -- 하나만 마이그레이션을 실행하고, 나머지는 대기해요.

## 프로그래밍 API -- MigrationCli

커스텀 툴링이나 CI/CD 파이프라인에서는 `MigrationCli`를 직접 사용할 수 있어요:

```typescript
import { MigrationCli } from "@stingerloom/orm";
import { CreateUsersTable } from "./migrations/CreateUsersTable";

const cli = new MigrationCli(
  [new CreateUsersTable()],
  {
    type: "postgres",
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USER ?? "postgres",
    password: process.env.DB_PASS ?? "password",
    database: process.env.DB_NAME ?? "mydb",
    entities: [],
  },
);

await cli.connect();

// Run pending migrations
const results = await cli.migrateRun();
console.log(results); // [{ name: "CreateUsersTable", direction: "up", success: true }]

// Check status
const status = await cli.migrateStatus();
console.log(status.executed); // ["CreateUsersTable"]
console.log(status.pending);  // []

// Rollback
await cli.migrateRollback();

// Auto-generate from schema diff
cli.setGenerateOptions({ outputDir: "./migrations", name: "add_posts" });
const { filePath, sql } = await cli.migrateGenerate();
console.log(`Generated: ${filePath}`);

await cli.close();
```

### MigrationCli 메서드

| Method | Returns | 설명 |
|--------|---------|------|
| `connect()` | `Promise<void>` | DB 연결 |
| `close()` | `Promise<void>` | DB 연결 종료 |
| `execute(command)` | `Promise<...>` | 명령어 이름으로 실행 |
| `migrateRun()` | `Promise<MigrationResult[]>` | 대기 중인 마이그레이션 실행 |
| `migrateRollback()` | `Promise<MigrationResult[]>` | 마지막 마이그레이션 롤백 |
| `migrateStatus()` | `Promise<{executed, pending}>` | 마이그레이션 상태 조회 |
| `migrateGenerate()` | `Promise<{filePath, sql}>` | 마이그레이션 자동 생성 |
| `setGenerateOptions(opts)` | `this` | 출력 디렉토리와 이름 설정 |

## Schema Diff 자동 생성 -- 동작 과정

`migrate:generate` 명령어는 마이그레이션 시스템에서 가장 강력한 부분이에요. 실행할 때 정확히 무슨 일이 일어나는지 살펴볼게요.

### 시나리오

DB에 `id`, `name`, `email` 컬럼이 있는 `user` 테이블이 있어요. 여기에 세 가지 변경을 해요:

1. `User`에 `phone` 컬럼 추가
2. `email`을 `VARCHAR(255)`에서 `VARCHAR(500)`으로 변경
3. 새로운 `Post` 엔티티 생성

### SchemaDiff가 하는 일

`npx stingerloom migrate:generate --name schema_update`를 실행하면:

**Step 1: 엔티티 메타데이터 읽기.** `entities` 배열을 스캔하고 모든 `@Entity()`와 `@Column()` 데코레이터를 읽어서 스키마가 *어떤 모습이어야 하는지* 파악해요.

**Step 2: 실제 DB 읽기.** `information_schema.tables`와 `information_schema.columns`를 쿼리해서 스키마가 *현재 어떤 모습인지* 파악해요.

**Step 3: 둘을 비교.** `SchemaDiff`가 모든 엔티티와 컬럼을 순회하면서 차이를 확인해요:

| 확인 항목 | 감지 내용 |
|----------|----------|
| 코드에는 있지만 DB에 없는 엔티티 | **새 테이블** -- `CREATE TABLE` 필요 |
| DB에는 있지만 코드에 없는 테이블 | *감지 안 함* -- `migrate:generate`는 `DROP TABLE`을 제안하지 않아요 |
| 엔티티에는 있지만 테이블에 없는 컬럼 | **추가된 컬럼** -- `ALTER TABLE ADD COLUMN` 필요 |
| 테이블에는 있지만 엔티티에 없는 컬럼 | **삭제된 컬럼** -- `ALTER TABLE DROP COLUMN` 필요 |
| 컬럼의 타입/길이/nullable이 다른 경우 | **변경된 컬럼** -- `ALTER TABLE ALTER COLUMN` 필요 |
| 같은 타입의 컬럼이 하나 삭제되고 하나 추가된 경우 | **이름 변경된 컬럼** -- `ALTER TABLE RENAME COLUMN` 필요 |

**Step 4: 마이그레이션 파일 생성.** 위 예시의 경우 생성되는 파일:

```typescript
import { Migration, MigrationContext } from "@stingerloom/orm";

export class SchemaUpdate1711234567892 extends Migration {
  async up({ query, driver }: MigrationContext) {
    // New table: Post
    await query(`
      CREATE TABLE ${driver.escapeIdentifier("post")} (
        ${driver.escapeIdentifier("id")} SERIAL PRIMARY KEY,
        ${driver.escapeIdentifier("title")} VARCHAR(255),
        ${driver.escapeIdentifier("content")} TEXT,
        ${driver.escapeIdentifier("createdAt")} TIMESTAMP
      )
    `);

    // Added column: user.phone
    await query(
      `ALTER TABLE ${driver.escapeIdentifier("user")} ADD COLUMN ${driver.escapeIdentifier("phone")} VARCHAR(255)`
    );

    // Altered column: user.email VARCHAR(255) -> VARCHAR(500)
    await query(
      `ALTER TABLE ${driver.escapeIdentifier("user")} ALTER COLUMN ${driver.escapeIdentifier("email")} TYPE VARCHAR(500)`
    );
  }

  async down({ query, driver }: MigrationContext) {
    // Revert: user.email back to VARCHAR(255)
    await query(
      `ALTER TABLE ${driver.escapeIdentifier("user")} ALTER COLUMN ${driver.escapeIdentifier("email")} TYPE VARCHAR(255)`
    );

    // Revert: drop user.phone
    await query(
      `ALTER TABLE ${driver.escapeIdentifier("user")} DROP COLUMN ${driver.escapeIdentifier("phone")}`
    );

    // Revert: drop post table
    await query(`DROP TABLE IF EXISTS ${driver.escapeIdentifier("post")}`);
  }
}
```

`down()` 메서드는 모든 변경을 역순으로 되돌려서 깔끔한 undo를 만들어요.

### Rename 감지

SchemaDiff는 휴리스틱으로 컬럼 이름 변경을 감지해요. `email`을 `emailAddress`로 바꿨다면(같은 타입, 같은 테이블, 하나 삭제되고 하나 추가), 다음을 생성해요:

```sql
ALTER TABLE "user" RENAME COLUMN "email" TO "emailAddress"
```

`email`을 삭제하고 `emailAddress`를 추가하는 대신(기존 데이터가 사라져요) rename을 사용해요.

### 감지 요약

`migrate:generate` 명령어가 엔티티 정의와 실제 DB를 비교해서 감지하는 것들:

- **새 테이블** -- DB에 아직 없는 엔티티
- **추가된 컬럼** -- 새로운 `@Column()` 데코레이터
- **삭제된 컬럼** -- 엔티티에서 제거된 컬럼
- **변경된 컬럼** -- 타입, 길이, nullable, precision 변경
- **이름 변경된 컬럼** -- 타입과 테이블로 지능적으로 매칭 (drop + add 대신 `RENAME COLUMN` 생성)

테이블 삭제는 여기에 포함되지 않습니다. DB에는 엔티티 목록이 모르는 테이블(다른 서비스, 다른 커넥션, 마이그레이션 기록용 테이블)이 흔히 함께 있기 때문에, "이 테이블에 대응하는 엔티티가 없다"가 곧 "쓸모없는 테이블이다"는 아니에요. `migrate:generate`는 `DROP TABLE`을 제안하지 않고, `synchronize`도 어떤 모드에서든 테이블을 삭제하지 않습니다. 테이블 삭제는 직접 마이그레이션으로 작성해 주세요.

## 다음 단계

- [Migrations](./migrations.md) -- 마이그레이션 개념과 `synchronize`에서 전환하기
- [Production Guide](./production-guide.md) -- 무중단 마이그레이션 전략
- [Configuration](./configuration.md) -- DB 연결 옵션
