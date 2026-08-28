# 데이터베이스 시딩

## 시딩이 필요한 이유

마이그레이션은 데이터베이스에 구조를 부여합니다 -- 테이블, 컬럼, 인덱스, 외래 키 등이죠. 하지만 구조만으로는 충분하지 않습니다. 새 개발자가 프로젝트를 클론하고 마이그레이션을 실행하면 빈 데이터베이스가 만들어집니다. 로그인할 관리자 계정도, 기본 역할도, 테스트할 샘플 데이터도 없죠. 작업을 시작하기도 전에 모든 걸 직접 세팅해야 합니다.

새 아파트로 이사 가는 상황을 떠올려 보세요. 마이그레이션은 시공팀입니다 -- 벽을 세우고, 배관을 깔고, 전기 배선을 합니다. 그런데 입주하면 모든 방이 텅 비어 있습니다. 시딩은 가구 배송입니다. 실제로 그 공간에서 살아가는 데 필요한 것들 -- 침대, 책상, 식탁 -- 로 방을 채워주죠.

시딩은 다음과 같은 실제 문제를 해결합니다:

- **개발 환경 세팅.** 새 개발자가 명령 한 번으로 테스트 사용자, 샘플 게시물, 기본 카테고리가 들어있는 작동 가능한 데이터베이스를 얻습니다.
- **테스트 픽스처.** 테스트 스위트는 예측 가능한 데이터로 실행되어야 합니다. 시더가 이를 제공합니다.
- **데모 환경.** 영업 팀에게는 사실적으로 보이는 데모 데이터베이스가 필요합니다. 시더가 이를 채웁니다.
- **멀티테넌트 초기 데이터.** 새 테넌트를 프로비저닝할 때 기본 역할, 설정, 템플릿이 필요합니다.

Stingerloom은 마이그레이션과 분리된 전용 시딩 시스템을 제공합니다. 이 분리가 중요한 이유는 마이그레이션은 스키마(데이터의 형태)를 다루는 반면, 시더는 콘텐츠(데이터 자체)를 다루기 때문입니다. 둘을 섞으면 각각을 독립적으로 추론하기가 어려워집니다.

---

## 시더 만들기

시더는 추상 클래스 `Seeder`를 상속받는 클래스입니다. 필수 메서드는 하나, `run()`입니다. 이 메서드는 `EntityManager`가 담긴 `SeederContext`를 받으므로, 데이터를 삽입할 때 ORM API 전체를 그대로 사용할 수 있습니다.

```typescript
import { Seeder, SeederContext } from "@stingerloom/orm";
import { User } from "./entities/user.entity";

class AdminUserSeeder extends Seeder {
  async run(ctx: SeederContext): Promise<void> {
    await ctx.em.save(User, {
      name: "Admin",
      email: "admin@example.com",
      role: "admin",
    });
  }
}
```

여기서 무슨 일이 일어나는지 따라가 봅시다:

1. `SeederRunner`가 `EntityManager`를 담은 `SeederContext`를 만듭니다.
2. `seeder.run(ctx)`를 호출합니다.
3. `run()` 안에서 `ctx.em.save()`를 사용해 관리자 사용자를 삽입합니다 -- ORM의 다른 곳에서 쓰는 것과 정확히 같은 API입니다.
4. 시더가 종료됩니다. 러너는 `AdminUserSeeder`가 실행되었음을 기록합니다.

시더의 `name` 속성은 기본적으로 클래스명(`"AdminUserSeeder"`)이 됩니다. 이 이름이 추적에 사용되므로, 각 시더 클래스는 고유한 이름을 가져야 합니다.

### SeederContext

컨텍스트는 의도적으로 단순하게 설계되었습니다:

| 속성 | 타입 | 설명 |
|------|------|------|
| `em` | `EntityManager` | 데이터베이스에 연결된 EntityManager 인스턴스 |

EntityManager API 전체에 접근할 수 있습니다: `save()`, `find()`, `delete()`, `query()` 등 모두. 즉, 시더 안에서 관계, 트랜잭션, 그 외 모든 ORM 기능을 사용할 수 있습니다.

---

## 시더 실행하기

`SeederRunner`는 시더의 실행을 관리합니다. `MigrationRunner`와 비슷하게 동작합니다 -- 어떤 시더가 실행되었는지 추적하고, 미실행 상태인 것만 실행합니다.

### 기본 셋업

```typescript
import { EntityManager, SeederRunner, Seeder, SeederContext } from "@stingerloom/orm";

// 시더 정의
class RoleSeeder extends Seeder {
  async run(ctx: SeederContext): Promise<void> {
    for (const name of ["admin", "editor", "viewer"]) {
      await ctx.em.save(Role, { name });
    }
  }
}

class DefaultUserSeeder extends Seeder {
  async run(ctx: SeederContext): Promise<void> {
    await ctx.em.save(User, {
      name: "Admin",
      email: "admin@example.com",
      role: "admin",
    });
  }
}

// 러너 생성
const seeders = [new RoleSeeder(), new DefaultUserSeeder()];
const runner = new SeederRunner(seeders, em, { query: (sql) => driver.query(sql) });

// 추적 테이블이 존재하는지 확인
await runner.ensureSeedTable();

// 미실행 시더 모두 실행
const results = await runner.runAll();

for (const result of results) {
  if (result.success) {
    console.log(`[OK] ${result.name}`);
  } else {
    console.error(`[FAIL] ${result.name}: ${result.error}`);
  }
}
```

### 추적 동작 방식

`ensureSeedTable()`을 호출하면 러너가 데이터베이스에 `__seeds` 테이블을 만듭니다. 이는 `__migrations` 테이블의 시더 버전입니다 -- 어떤 시더가 실행되었는지 기록해 두 번 실행되지 않도록 합니다.

PostgreSQL의 경우:

```sql
CREATE TABLE IF NOT EXISTS "__seeds" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(255) NOT NULL UNIQUE,
  "executed_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

SQLite의 경우 (`SERIAL`은 SQLite에서 자동 증가 타입이 아니므로 rowid 별칭 형태를 사용합니다):

```sql
CREATE TABLE IF NOT EXISTS "__seeds" (
  "id" INTEGER PRIMARY KEY AUTOINCREMENT,
  "name" VARCHAR(255) NOT NULL UNIQUE,
  "executed_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

MySQL의 경우:

```sql
CREATE TABLE IF NOT EXISTS `__seeds` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(255) NOT NULL UNIQUE,
  `executed_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

시더가 성공적으로 실행되면 행이 삽입됩니다:

```sql
INSERT INTO "__seeds" ("name") VALUES ('RoleSeeder');
```

다음번에 `runAll()`을 호출하면 러너가 이 테이블을 확인해 이미 실행된 `RoleSeeder`를 건너뜁니다. (대기 상태인) `DefaultUserSeeder`만 실행됩니다.

### 상태 확인

어떤 시더가 실행되었고 어떤 것이 대기 중인지 확인할 수 있습니다:

```typescript
const status = await runner.status();

console.log("Executed:", status.executed);
// ["RoleSeeder"]

console.log("Pending:", status.pending);
// ["DefaultUserSeeder"]
```

### 단일 시더 실행

특정 시더 하나만 실행하고 싶다면(개발 중에 유용합니다) `runOne()`을 사용하세요:

```typescript
const result = await runner.runOne(new DefaultUserSeeder());
console.log(result.success); // true
```

`runOne()`도 추적 테이블에 실행을 기록한다는 점을 기억하세요. 즉, 이후 `runAll()`은 이 시더를 다시 실행하지 않습니다.

### 추적 비활성화

매번 시더를 실행하고 싶을 때도 있습니다 -- 예를 들어, 테스트마다 드롭하고 다시 만드는 테스트 데이터베이스를 채울 때입니다. `trackExecution: false`를 설정하세요:

```typescript
const runner = new SeederRunner(seeders, em, queryRunner, {
  trackExecution: false,
});

// 이전 실행과 무관하게 매번 모든 시더를 실행
await runner.runAll();
```

### 사용자 정의 테이블명

`__seeds`가 스키마의 다른 이름과 충돌한다면 변경할 수 있습니다:

```typescript
const runner = new SeederRunner(seeders, em, queryRunner, {
  tableName: "_seed_history",
});
```

---

## 되돌릴 수 있는 시더

시더는 선택적으로 `revert()` 메서드를 구현할 수 있습니다. 이를 통해 시드 데이터를 되돌릴 수 있습니다 -- 개발 데이터베이스를 초기화하거나 데모 후 정리할 때 유용합니다.

```typescript
class RoleSeeder extends Seeder {
  private readonly roles = ["admin", "editor", "viewer"];

  async run(ctx: SeederContext): Promise<void> {
    for (const name of this.roles) {
      await ctx.em.save(Role, { name });
    }
  }

  async revert(ctx: SeederContext): Promise<void> {
    for (const name of this.roles) {
      await ctx.em.delete(Role, { name });
    }
  }
}
```

가장 최근에 실행된 시더를 되돌리려면:

```typescript
const result = await runner.revertLast();

if (result === null) {
  console.log("Nothing to revert.");
} else if (result.success) {
  console.log(`Reverted: ${result.name}`);
} else {
  console.error(`Revert failed: ${result.error}`);
}
```

시더가 되돌려지면 `__seeds` 테이블에서 해당 행이 제거됩니다. 즉, 다음 `runAll()` 호출 때 다시 실행됩니다.

시더가 `revert()`를 구현하지 않았다면, 그 시더가 가장 최근 실행된 상태에서 `revertLast()`를 호출하면 설명 메시지가 담긴 실패 결과를 반환합니다. 다음 시더로 넘어가지 않으므로 이 경우는 명시적으로 처리해야 합니다.

---

## 시더는 원자적이지 않습니다

`SeederRunner`는 `run()`을 트랜잭션으로 감싸지 **않습니다**. `run()` 안의 각 문장은 독립적으로 실행되고 커밋되므로, 중간에 실패한 시더는 그 이전의 쓰기를 데이터베이스에 남깁니다. 게다가 실패하면 `__seeds`에 실행 기록이 남지 않으므로, 다음 `runAll()`이 같은 시더를 처음부터 다시 실행합니다.

여러 연관 행이 함께 저장되어야 하는(전부 아니면 전무) 시더라면, 본문을 `em.transaction()`으로 감싸서 직접 원자성을 확보하세요:

```typescript
class OrderFixtureSeeder extends Seeder {
  async run(ctx: SeederContext): Promise<void> {
    await ctx.em.transaction(async (txEm) => {
      const customer = await txEm.save(Customer, { name: "Fixture Co." });
      await txEm.save(Order, { customerId: customer.id, status: "pending" });
      await txEm.save(Order, { customerId: customer.id, status: "paid" });
      // 여기서 예외가 발생하면 세 개의 쓰기가 모두 함께 롤백됩니다.
    });
  }
}
```

이렇게 감싸면 실패 시 시더의 쓰기가 전부 롤백되고, 버그를 고친 뒤의 재실행은 깨끗한 상태에서 시작합니다. 가능하다면 시더를 **멱등**하게 작성하는 것도 좋습니다(insert 전 존재 확인 또는 `upsert()` 사용). 감싸지 않은 시더가 부분 실패하더라도 다음 실행에서 중복이 생기지 않게요.

실행 추적 기록도 별도의 문장이라는 점에 유의하세요. `run()`은 성공했는데 `__seeds` 기록이 실패하면, 러너는 critical 경고를 로그로 남기고 데이터는 이미 쓰였음에도 해당 시더를 실패로 보고합니다.

---

## API 레퍼런스

### Seeder (추상 클래스)

| 속성 / 메서드 | 설명 |
|-------------|------|
| `name` | 시더 이름 (기본값은 클래스명). 추적에 사용됩니다. |
| `run(ctx)` | **필수.** 시드 데이터를 삽입합니다. EntityManager가 담긴 `SeederContext`를 받습니다. |
| `revert(ctx)` | **선택.** 시드 데이터를 제거합니다. `revertLast()`에서 호출됩니다. |

### SeederContext

| 속성 | 타입 | 설명 |
|------|------|------|
| `em` | `EntityManager` | 연결된 EntityManager 인스턴스 |

### SeederRunner

| 메서드 | 시그니처 | 설명 |
|-------|---------|------|
| `ensureSeedTable()` | `(): Promise<void>` | 추적 테이블이 없으면 생성 |
| `runAll()` | `(): Promise<SeederResult[]>` | 미실행 시더를 순서대로 모두 실행. 첫 실패 시 중단. |
| `runOne(seeder)` | `(seeder: Seeder): Promise<SeederResult>` | 단일 시더 실행 |
| `revertLast()` | `(): Promise<SeederResult \| null>` | 가장 최근 실행된 시더를 되돌립니다. 실행된 시더가 없으면 null 반환. |
| `status()` | `(): Promise<{ executed: string[]; pending: string[] }>` | 실행/대기 시더 표시 |
| `getExecutedSeeds()` | `(): Promise<string[]>` | 실행된 시더 이름 반환 |

### SeederRunnerOptions

| 옵션 | 타입 | 기본값 | 설명 |
|------|------|--------|------|
| `trackExecution` | `boolean` | `true` | `__seeds` 테이블에 실행 여부를 추적할지 |
| `tableName` | `string` | `"__seeds"` | 시드 추적 테이블 이름 |

### SeederResult

| 속성 | 타입 | 설명 |
|------|------|------|
| `name` | `string` | 시더 이름 |
| `direction` | `"run" \| "revert"` | 실행/되돌림 작업 구분 |
| `success` | `boolean` | 작업 성공 여부 |
| `error` | `string \| undefined` | 작업 실패 시 에러 메시지 |

---

## 다음 단계

- [마이그레이션](./migrations.md) -- 버전 관리되는 스키마 변경
- [EntityManager](./entity-manager.md) -- 시더 안에서 사용하는 전체 CRUD API
- [설정](./configuration.md) -- 데이터베이스 연결 설정
