# Migration CLI

## 마이그레이션이 필요한 이유

개발 중에는 `synchronize: true`가 편리합니다. 엔티티를 바꾸고 앱을 재시작하면 ORM이 데이터베이스 스키마를 엔티티에 맞춰 바꾸기 때문입니다. 하지만 프로덕션에서는 위험합니다. 컬럼 이름을 바꾸는 변경을 배포한다고 해 봅시다. 그러면 `synchronize`는 기존 컬럼을 그 안의 데이터와 함께 삭제하고 빈 컬럼을 새로 만들게 됩니다.

마이그레이션은 데이터베이스 변경을 명시적이고 리뷰할 수 있는 형태로 만들어 이 문제를 해결합니다. ORM이 알리지 않고 스키마를 바꾸는 대신 무엇이 바뀌는지 정확히 적힌 파일이 생깁니다. 이 파일을 리뷰하고 테스트한 뒤에야 프로덕션에 적용합니다. 문제가 생기면 롤백할 수 있습니다.

마이그레이션은 데이터베이스 스키마의 버전 관리라고 생각하면 됩니다. 마이그레이션 하나하나는 스키마를 한 단계 앞으로 또는 뒤로 옮기는 커밋(commit)입니다.

## 마이그레이션 워크플로우

일반적인 마이그레이션 워크플로는 처음부터 끝까지 다음과 같습니다.

**1. 엔티티를 변경합니다.** `User` 클래스에 `phone` 컬럼을 추가합니다.

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

**2. 마이그레이션을 생성합니다.** CLI가 엔티티 정의와 실제 데이터베이스를 비교해서 마이그레이션 파일을 만듭니다.

```bash
npx stingerloom migrate:generate --name add_phone_to_users
```

그러면 필요한 DDL이 담긴 `migrations/1711234567892_add_phone_to_users.ts` 같은 파일이 생깁니다.

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

**3. 마이그레이션을 리뷰합니다.** 파일을 열어 SQL을 읽고 의도한 대로 동작하는지 확인합니다. 이 리뷰가 안전장치입니다.

**4. 마이그레이션을 적용합니다.**

```bash
npx stingerloom migrate:run
```

CLI는 `up()` 메서드를 실행합니다. 그리고 다시 실행되지 않도록 마이그레이션을 추적 테이블에 기록합니다.

**5. 문제가 생기면 롤백합니다.**

```bash
npx stingerloom migrate:rollback
```

이 명령은 `down()` 메서드를 호출해서 변경을 되돌립니다.

## 설치

CLI는 `@stingerloom/orm` 패키지에 포함되어 있습니다. 바이너리 이름은 `stingerloom`입니다.

```bash
npx stingerloom <command> [options]
```

## 명령어

### migrate:run

대기 중인 마이그레이션을 모두 순서대로 실행합니다.

```bash
npx stingerloom migrate:run
```

마이그레이션은 어드바이저리 잠금(advisory lock)을 건 상태에서 실행되므로 동시에 실행되지 않습니다. 자세한 내용은 아래에 있습니다. 적용에 성공한 마이그레이션은 하나씩 `__migrations` 추적 테이블에 기록됩니다.

### migrate:rollback

마지막으로 적용된 마이그레이션 하나를 되돌립니다.

```bash
npx stingerloom migrate:rollback
```

가장 최근에 실행된 마이그레이션의 `down()` 메서드를 호출하고 추적 테이블에서 그 기록을 삭제합니다. 한 번에 마이그레이션 하나만 롤백됩니다. 더 되돌리려면 이 명령을 여러 번 실행하세요.

### migrate:status

어떤 마이그레이션이 실행됐고 어떤 마이그레이션이 아직 대기 중인지 보여 줍니다.

```bash
npx stingerloom migrate:status
```

출력 예시는 다음과 같습니다.

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

"Executed" 목록에는 이미 적용된 마이그레이션이 실행 시각과 함께 나옵니다. "Pending" 목록에는 코드에는 있지만 아직 이 데이터베이스에 적용되지 않은 마이그레이션이 나옵니다. `migrate:run`을 실행하면 대기 중인 마이그레이션이 순서대로 적용됩니다.

### migrate:generate

엔티티 정의와 현재 데이터베이스 스키마를 비교해서 마이그레이션 파일을 자동으로 생성합니다.

```bash
npx stingerloom migrate:generate --output ./migrations --name add_posts
```

이 명령은 `SchemaDiff`를 실행해서 변경 사항을 감지합니다. 그리고 `up()`과 `down()` 메서드가 모두 들어 있고 이름에 타임스탬프가 붙은 마이그레이션 파일을 생성합니다.

## CLI 옵션

| Flag | 설명 | 기본값 |
|------|------|--------|
| `--config <path>` | 설정 파일 경로 | 자동 감지 |
| `--output <dir>` | 생성된 마이그레이션 출력 디렉토리 | `./migrations` |
| `--name <suffix>` | 생성된 마이그레이션 파일의 이름 접미사 | `auto_migration` |
| `--version` | 설치된 `@stingerloom/orm` 버전 출력 | -- |
| `--help`, `-h` | 도움말 표시 | -- |

`--flag value` 대신 `--flag=value` 형태도 받습니다. 알 수 없는 플래그는 무시되지 않고 에러가 됩니다. 예를 들어 `stingerloom introspect --dry-runn`은 `Unknown option: "--dry-runn"`을 출력하고 중단합니다. 오타를 무시한 채 엔티티 파일을 쓰지 않습니다.

## 종료 코드

| 코드 | 의미 |
|------|------|
| `0` | 명령 성공 |
| `1` | 명령 실패 |

종료 코드 1은 CLI가 감지할 수 있는 모든 실패를 포함합니다. 예외가 아닌 실패도 마찬가지입니다. `up()`이 에러를 던진 마이그레이션은 실패 결과로 기록됩니다. 그리고 `Migration failed: <name> (up) — <error>`로 보고된 뒤 프로세스가 코드 1로 종료됩니다. 이 동작 덕분에 CI에서 흔히 쓰는 아래 명령 연결이 안전합니다.

```bash
npx stingerloom migrate:run && ./deploy.sh   # 모든 마이그레이션이 적용됐을 때만 배포
```

다음 경우에도 종료 코드는 1입니다.

- 설정 파일을 찾거나 읽지 못한 경우
- 설정의 `type`이 없거나 지원하지 않는 값인 경우
- 알 수 없는 명령이나 옵션을 넘겼거나 옵션 값이 빠진 경우

에러는 스택 트레이스가 아니라 메시지로 출력됩니다. 해당하는 해결 힌트가 있으면 함께 출력됩니다. 적용할 마이그레이션이 없는 `migrate:run`과 되돌릴 마이그레이션이 없는 `migrate:rollback`은 성공이며 종료 코드는 0입니다.

실패한 경우를 포함해 모든 경우에 데이터베이스 연결을 닫은 뒤 프로세스가 종료됩니다.

## 설정 파일

CLI는 다음 순서로 설정 파일을 자동으로 찾습니다.

1. `stingerloom.config.ts`
2. `stingerloom.config.js`
3. `stingerloom.config.mjs` / `stingerloom.config.cjs`
4. `ormconfig.ts`
5. `ormconfig.js`
6. `ormconfig.mjs` / `ormconfig.cjs`

`--config`로 설정 파일을 직접 지정할 수도 있습니다. ES 모듈 설정 파일은 지원하는 모든 Node 버전에서 동작합니다. `"type": "module"` 프로젝트에서 `export default {...}`로 쓴 `.js` 설정을 `require()`가 처리하지 못하면 동적 `import()`로 로드합니다.

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

`entities` 배열은 `migrate:generate`에서만 필요합니다. CLI는 이 배열을 보고 스키마가 어떤 모습이어야 하는지 파악합니다. 이 배열은 클래스뿐 아니라 `entities: ["./src/**/*.entity.ts"]` 같은 glob 패턴 문자열도 받습니다. 패턴은 CLI를 실행한 디렉터리를 기준으로 해석됩니다. 패턴에 매칭된 파일을 로드하지 못하면 명령은 `OrmError(ENTITY_GLOB_LOAD_FAILED)`로 멈춥니다. 에러 메시지에는 실패한 파일과 각 파일의 에러가 모두 나옵니다. `register()`에서도 똑같이 동작합니다. `migrations` 배열에는 마이그레이션 클래스를 실행 순서대로 나열합니다.

`connection` 래퍼가 없는 평면 `DatabaseClientOptions` 객체도 그대로 받습니다. 예를 들면 `export default { type: "sqlite", database: "./app.sqlite", migrations: [] }`입니다.

> 참고: TypeScript 설정 파일을 쓰려면 `ts-node`나 `tsx`가 설치되어 있어야 합니다. CLI는 먼저 `ts-node/register`를 시도하고 실패하면 `tsx/cjs`로 넘어갑니다.

## 마이그레이션 작성

마이그레이션은 `Migration`을 확장하고 `up()`과 `down()`을 구현하는 클래스입니다.

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

`MigrationContext`는 다음 속성을 제공합니다.

| Property | Type | 설명 |
|----------|------|------|
| `driver` | `ISqlDriver` | `escapeIdentifier()`와 DDL 헬퍼를 제공하는 데이터베이스 드라이버 |
| `query` | `(sql: string) => Promise<any>` | 임의의 SQL 실행 |

따옴표를 직접 쓰지 않고 `driver.escapeIdentifier()`를 쓰는 이유는 데이터베이스마다 인용 방식이 다르기 때문입니다. PostgreSQL과 SQLite는 `"double quotes"`를 쓰고 MySQL은 `` `backticks` ``를 씁니다. `escapeIdentifier()`를 쓰면 마이그레이션이 여러 데이터베이스에서 동작합니다. 그리고 `user`, `order` 같은 예약어도 안전하게 이스케이프됩니다. 이름 안에 인용 문자가 있으면 그 문자를 두 번 겹쳐 이스케이프합니다. 다만 이름만 인용하고 PostgreSQL 스키마를 앞에 붙이지는 않습니다.

## 마이그레이션 추적

CLI는 적용된 마이그레이션을 추적하려고 `__migrations` 테이블을 자동으로 생성합니다.

```sql
CREATE TABLE "__migrations" (
  "id"          SERIAL PRIMARY KEY,
  "name"        VARCHAR(255) NOT NULL UNIQUE,
  "executed_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

마이그레이션의 적용 여부는 이 테이블을 기준으로 판단합니다. `migrate:run`을 실행하면 CLI는 이 테이블을 읽고 이미 적용된 마이그레이션을 건너뜁니다. `migrate:rollback`을 실행하면 마지막 항목을 찾아 되돌립니다.

## 동시성 안전 -- Advisory Lock

### 동시 마이그레이션이 위험한 이유

클러스터의 서버 두 대가 동시에 배포되면서 둘 다 마이그레이션을 실행한다고 생각해 보세요. 서버 A가 `posts` 테이블을 생성하기 시작합니다. 서버 B는 이 사실을 모르고 같은 테이블을 생성하려고 합니다. 결과는 데이터베이스 에러와 반쯤 적용된 마이그레이션입니다. 수습하기 어려운 상황입니다.

더 나쁜 경우도 있습니다. 두 프로세스가 서로 다른 마이그레이션을 동시에 실행하면 순서가 뒤섞여 스키마가 불일치 상태로 남을 수 있습니다.

### Advisory Lock이 이를 방지하는 방법

CLI는 마이그레이션을 실행하기 전에 데이터베이스 어드바이저리 잠금(database advisory lock)을 획득합니다. 어드바이저리 잠금은 파일이나 메모리가 아니라 데이터베이스 안에 존재하는 협력형 잠금입니다. 같은 잠금을 획득하려는 다른 프로세스는 첫 번째 프로세스가 잠금을 해제할 때까지 대기합니다.

- **PostgreSQL:** `pg_advisory_lock(key)` / `pg_advisory_unlock(key)`
- **MySQL:** `GET_LOCK(name, timeout)` / `RELEASE_LOCK(name)`

잠금은 고정된 키를 씁니다. 그래서 모든 서버의 마이그레이션 프로세스가 데이터베이스를 거쳐 서로 조율됩니다. 다른 마이그레이션 프로세스가 이미 실행 중이면 CLI는 최대 10초간 대기한 뒤 `AdvisoryLockError`를 던집니다.

그러므로 여러 서버에 동시에 배포해도 안전합니다. 서버 하나만 마이그레이션을 실행하고 나머지는 대기합니다.

## 프로그래밍 API -- MigrationCli

자체 도구나 CI/CD 파이프라인에서는 `MigrationCli`를 직접 쓰세요.

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
| `connect()` | `Promise<void>` | 데이터베이스에 연결 |
| `close()` | `Promise<void>` | 데이터베이스 연결 종료 |
| `execute(command)` | `Promise<...>` | 명령어 이름으로 실행 |
| `migrateRun()` | `Promise<MigrationResult[]>` | 대기 중인 마이그레이션 실행 |
| `migrateRollback()` | `Promise<MigrationResult[]>` | 마지막 마이그레이션 롤백 |
| `migrateStatus()` | `Promise<{executed, pending}>` | 마이그레이션 상태 조회 |
| `migrateGenerate()` | `Promise<{filePath, sql}>` | 마이그레이션 자동 생성 |
| `setGenerateOptions(opts)` | `this` | 출력 디렉토리와 이름 설정 |

## Schema Diff 자동 생성 -- 동작 과정

`migrate:generate` 명령은 마이그레이션 시스템에서 가장 강력한 부분입니다. 이 명령을 실행하면 아래 순서로 일이 일어납니다.

### 시나리오

데이터베이스에 `id`, `name`, `email` 컬럼이 있는 `user` 테이블이 있습니다. 그리고 엔티티를 세 군데 바꿉니다.

1. `User`에 `phone` 컬럼 추가
2. `email`을 `VARCHAR(255)`에서 `VARCHAR(500)`으로 변경
3. 새로운 `Post` 엔티티 생성

### SchemaDiff가 하는 일

`npx stingerloom migrate:generate --name schema_update`를 실행하면 CLI는 다음 단계를 거칩니다.

**Step 1: 엔티티 메타데이터 읽기.** `entities` 배열을 스캔합니다. 그리고 모든 `@Entity()`와 `@Column()` 데코레이터를 읽어서 스키마가 *어떤 모습이어야 하는지* 파악합니다.

**Step 2: 실제 데이터베이스 읽기.** `information_schema.tables`와 `information_schema.columns`를 쿼리해서 스키마가 *현재 어떤 모습인지* 파악합니다.

**Step 3: 둘을 비교.** `SchemaDiff`가 모든 엔티티와 컬럼을 하나씩 확인하며 차이를 찾습니다.

| 확인 항목 | 감지 내용 |
|----------|----------|
| 코드에는 있지만 DB에 없는 엔티티 | 새 테이블: `CREATE TABLE` 필요 |
| DB에는 있지만 코드에 없는 테이블 | *감지 안 함*: `migrate:generate`는 `DROP TABLE`을 제안하지 않음 |
| 엔티티에는 있지만 테이블에 없는 컬럼 | 추가된 컬럼: `ALTER TABLE ADD COLUMN` 필요 |
| 테이블에는 있지만 엔티티에 없는 컬럼 | 삭제된 컬럼: `ALTER TABLE DROP COLUMN` 필요 |
| 컬럼의 타입/길이/nullable이 다른 경우 | 변경된 컬럼: `ALTER TABLE ALTER COLUMN` 필요 |
| 같은 타입의 컬럼이 하나 삭제되고 하나 추가된 경우 | 이름 변경된 컬럼: `ALTER TABLE RENAME COLUMN` 필요 |

**Step 4: 마이그레이션 파일 생성.** 위 예시에서는 다음 파일이 생성됩니다.

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

`down()` 메서드는 모든 변경을 역순으로 되돌립니다. 그래서 롤백하면 변경 전 상태로 깔끔하게 돌아갑니다.

### Rename 감지

SchemaDiff는 휴리스틱으로 컬럼 이름 변경을 감지합니다. 예를 들어 `email`을 `emailAddress`로 바꿨다고 해 봅시다. 같은 테이블에서 같은 타입의 컬럼이 하나 삭제되고 하나 추가된 경우입니다. 이때 SchemaDiff는 다음 SQL을 생성합니다.

```sql
ALTER TABLE "user" RENAME COLUMN "email" TO "emailAddress"
```

`email`을 삭제하고 `emailAddress`를 추가하면 기존 데이터가 모두 사라집니다. 그래서 삭제와 추가 대신 이름 변경을 사용합니다.

### 감지 요약

`migrate:generate` 명령은 엔티티 정의와 실제 데이터베이스를 비교해서 다음 항목을 감지합니다.

- **새 테이블**: 데이터베이스에 아직 없는 엔티티
- **추가된 컬럼**: 새로운 `@Column()` 데코레이터
- **삭제된 컬럼**: 엔티티에서 제거된 컬럼
- **변경된 컬럼**: 타입, 길이, nullable, precision 변경
- **이름 변경된 컬럼**: 타입과 테이블을 기준으로 매칭합니다. 삭제와 추가 대신 `RENAME COLUMN`을 생성합니다.

테이블 삭제는 여기에 포함되지 않습니다. 데이터베이스에는 엔티티 목록에 없는 테이블이 흔히 함께 있습니다. 다른 서비스의 테이블, 다른 연결이 쓰는 테이블, 마이그레이션 기록용 테이블이 그 예입니다. 그래서 테이블에 대응하는 엔티티가 없다고 해서 그 테이블이 쓸모없다고 볼 수는 없습니다. `migrate:generate`는 `DROP TABLE`을 제안하지 않습니다. `synchronize`도 어떤 모드에서든 테이블을 삭제하지 않습니다. 테이블 삭제는 마이그레이션을 직접 작성해서 처리하세요.

## 다음 단계

- [Migrations](./migrations.md): 마이그레이션 개념과 `synchronize`에서 전환하는 방법
- [Production Guide](./production-guide.md): 무중단 마이그레이션 전략
- [Configuration](./configuration.md): 데이터베이스 연결 옵션
