# 마이그레이션 (Migrations)

개발할 때는 `synchronize: true`가 편리하지만, 프로덕션에서는 위험합니다. 이미 데이터가 있는 테이블을 엔티티 정의만으로 자동 변경하면 데이터가 손실될 수 있습니다.

**마이그레이션**은 스키마 변경을 코드로 작성하여 버전 관리하는 방법입니다. "언제, 무엇이 변경되었는지" 추적할 수 있고, 문제가 생기면 되돌릴 수도 있습니다.

## 마이그레이션 파일 만들기

마이그레이션은 `Migration` 클래스를 상속하여 `up()`과 `down()` 메서드를 구현합니다.

- **`up()`** — 변경 적용 (예: 테이블 생성, 컬럼 추가)
- **`down()`** — 변경 되돌리기 (예: 테이블 삭제, 컬럼 삭제)

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

`MigrationContext`는 두 가지를 제공합니다.

| 속성 | 설명 |
|------|------|
| `context.query(sql)` | 임의의 SQL을 실행합니다 |
| `context.driver` | DB 드라이버에 접근합니다 (DDL 헬퍼 등) |

## 마이그레이션 더 만들어보기

### 컬럼 추가

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

### 인덱스 추가

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

### 초기 데이터 삽입

```typescript
// migrations/004_SeedRoles.ts
export class SeedRoles extends Migration {
  async up(context: MigrationContext) {
    await context.query(`
      INSERT INTO "roles" ("name", "description") VALUES
      ('admin', '관리자'),
      ('user', '일반 사용자'),
      ('guest', '게스트')
    `);
  }

  async down(context: MigrationContext) {
    await context.query(
      `DELETE FROM "roles" WHERE "name" IN ('admin', 'user', 'guest')`
    );
  }
}
```

## 마이그레이션 실행하기

### MigrationCli 사용 (권장)

`MigrationCli`는 DB 연결과 마이그레이션 실행을 한 번에 처리합니다.

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
  host: "localhost",
  port: 5432,
  username: "postgres",
  password: "password",
  database: "mydb",
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

package.json에 스크립트를 등록하면 편리합니다.

```json
{
  "scripts": {
    "migrate:run": "ts-node ./src/migrate.ts migrate:run",
    "migrate:rollback": "ts-node ./src/migrate.ts migrate:rollback",
    "migrate:status": "ts-node ./src/migrate.ts migrate:status"
  }
}
```

이제 터미널에서 실행합니다.

```bash
# 미실행 마이그레이션 모두 적용
pnpm migrate:run

# 마지막 마이그레이션 되돌리기
pnpm migrate:rollback

# 현재 상태 확인
pnpm migrate:status
```

Stingerloom은 `__migrations` 테이블을 자동 생성하여 어떤 마이그레이션이 실행되었는지 추적합니다.

## 마이그레이션 결과 확인

각 마이그레이션의 성공/실패 여부를 확인할 수 있습니다.

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

## 파일 명명 규칙

마이그레이션은 배열에 등록한 순서대로 실행됩니다. 파일명에 순번을 붙여 순서를 명확하게 표현하세요.

```
migrations/
├── 001_CreateUsersTable.ts
├── 002_CreatePostsTable.ts
├── 003_AddPhoneToUsers.ts
├── 004_AddEmailIndex.ts
└── 005_SeedRoles.ts
```

## Schema Diff — 마이그레이션 자동 생성

마이그레이션 파일을 수동으로 작성하는 대신, 엔티티 정의와 실제 DB 스키마를 비교하여 자동으로 생성할 수 있습니다.

### 1단계: 차이 비교

```typescript
import { SchemaDiff } from "@stingerloom/orm";

const diff = await SchemaDiff.compare(em, [User, Post, Comment]);

console.log(diff.addedTables);    // ["comment"] — 새로 추가된 테이블
console.log(diff.droppedTables);  // [] — 삭제된 테이블
console.log(diff.modifiedTables); // [{ tableName: "user", addedColumns: [...] }]
```

### 2단계: 마이그레이션 생성 및 실행

```typescript
import { SchemaDiff, SchemaDiffMigrationGenerator } from "@stingerloom/orm";

// 차이 비교
const diff = await SchemaDiff.compare(em, [User, Post]);

// 변경 사항이 없으면 종료
if (diff.addedTables.length === 0 &&
    diff.droppedTables.length === 0 &&
    diff.modifiedTables.length === 0) {
  console.log("스키마 변경 없음");
  return;
}

// 마이그레이션 자동 생성
const generator = new SchemaDiffMigrationGenerator();
const migrations = generator.generate(diff);

console.log(`${migrations.length}개 마이그레이션 생성됨`);
```

예를 들어 User 엔티티에 `phone` 컬럼을 추가했다면, 다음과 같은 마이그레이션이 자동으로 생성됩니다.

```typescript
// 자동 생성된 마이그레이션
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

> **Hint** Schema Diff는 테이블과 컬럼의 추가/삭제를 감지합니다. 컬럼 타입 변경은 지원하지 않으므로 수동 마이그레이션으로 작성하세요.

## MigrationRunner API

| 메서드 | 설명 |
|--------|------|
| `run(migrations?)` | 미실행 마이그레이션 순서대로 실행 |
| `rollback(n?)` | 최근 n개 마이그레이션 되돌리기 (기본값: 1) |
| `status()` | `{ executed: string[], pending: string[] }` 반환 |
| `runAll()` | 미실행 마이그레이션 전체 실행 |
| `runUp(migration)` | 단일 마이그레이션 적용 |
| `runDown(migration)` | 단일 마이그레이션 되돌리기 |
| `revertLast()` | 마지막 마이그레이션 되돌리기 |
| `getPendingMigrations()` | 미실행 목록 반환 |
| `getExecutedMigrations()` | 실행된 목록 반환 |

## 다음 단계

- [설정 가이드](./configuration.md) — 풀링, 타임아웃, Read Replica 설정
- [멀티테넌시](./multi-tenancy.md) — 테넌트별 스키마 자동 프로비저닝
- [EntityManager](./entity-manager.md) — CRUD API 전체 보기
