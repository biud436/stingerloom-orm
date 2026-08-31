# 2.0 업그레이드

2.0은 대체로 정직해지는 릴리스입니다. 겉으로 드러나지 않던 오작동이 이제 곧바로 드러나고, 잘못 저장되던 컬럼 표기 하나가 바로잡혔습니다. 대부분의 애플리케이션은 버전 숫자만 올리면 끝납니다. 이 문서는 깨질 수 있는 것 전부와 그때 무엇을 하면 되는지를 정리합니다.

```bash
pnpm add @stingerloom/orm@2
```

## 먼저 할 일

배포 전에 로깅을 켜고 테스트를 한 번 돌리세요. 2.0의 파괴적 변경은 거의 전부 겉으로 드러나지 않던 동작을 예외나 경고로 바꾼 것이라, 테스트 한 번이면 대부분 드러납니다.

```typescript
await em.register({ /* ... */, logging: true });
```

## 컴파일이 깨지는 것

### 루트 배럴이 공개 API만 내보냅니다

예전에는 `@stingerloom/orm`이 모듈을 통째로 재수출해서, 루트에서 673개의 심볼을 가져올 수 있었습니다. 엔진 내부(`SchemaRegistrar`, `CascadeHandler`, `EntityManagerInternals`), 표현식 배관(`buildAbs`, `renderSubquery`), 내부 타입 가드까지요. 이제 배럴은 내보낼 심볼을 이름으로 명시합니다.

import가 풀리지 않는다면 그 심볼이 내부 구현이었다는 뜻입니다. 엔진 내부에 대한 대체 경로는 제공하지 않으니, 필요한 용도가 있다면 이슈로 알려 주세요. 공개 진입점은 그대로입니다. `@stingerloom/orm`, `@stingerloom/orm/nestjs`, `@stingerloom/orm/prisma-import`, 그리고 다이얼렉트 서브패스.

### 커스텀 드라이버는 `escapeIdentifier()`를 구현해야 합니다

`ISqlDriver`에 `escapeIdentifier(name: string): string`가 선언됐습니다. 문서의 마이그레이션 예제는 전부터 이 메서드를 호출하고 있었는데 정작 어느 드라이버에도 없었습니다. 그래서 그 예제들은 컴파일도 되지 않았고 런타임에서도 죽었죠. 내장 드라이버 세 개는 이미 구현했고, 직접 만든 `ISqlDriver`에는 추가가 필요합니다.

```typescript
escapeIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
```

### `ColumnMetadata.name`과 `EntityScannerMetadata.name`이 필수입니다

두 필드는 타입상 선택이었지만 실제 생성 경로에서는 항상 채워졌습니다. 이 메타데이터 객체를 직접 만드는 코드, 예컨대 커스텀 스캐너나 스키마 도구라면 이제 `name`을 넣어야 합니다.

## 이제 예외를 던지는 것

아래는 전부 예전에 아무 표시 없이 틀린 답을 주던 자리입니다.

| 작성한 코드 | 1.x | 2.0 |
| --- | --- | --- |
| 커넥션 `entities`에 없는 엔티티 | 첫 SQL에서 드라이버 에러로 사망 | 진입점에서 `EntityMetadataNotFoundError` |
| `where: { emial: "…" }` (오타) | 원본 키를 드라이버로 전달, 방언별 "no such column" | 컬럼명과 가장 가까운 후보를 알려 주는 `InvalidQueryError` |
| `relations: ["autor"]` (오타) | 쿼리는 성공하고 관계 프로퍼티만 `undefined` | 해석 가능한 관계 목록을 담은 `InvalidQueryError` |
| PK가 어느 행과도 맞지 않는 `save()` | 성공으로 보고하고 `afterUpdate`까지 발화 | `EntityNotFoundError` |
| `qb.where("status = 'open'")` (raw SQL 문자열) | 조각 전체를 컬럼명으로 취급 | `InvalidQueryError` |
| 표현 불가능한 diff에 대한 `migrate:generate` | `up()`이 TODO 주석뿐인 마이그레이션을 생성 | 예외를 던져 죽은 마이그레이션이 리포지토리에 들어가지 않음 |

이 중 둘은 조금 더 설명이 필요합니다.

**컬럼 식별자.** 검증기는 프로퍼티명, DB 컬럼명, `@RelationColumn` FK 섀도우, `@ComputedColumn` 이름, 단일 테이블 상속의 형제 컬럼까지 받아들입니다. 거부하는 건 엔티티가 매핑하지 않은 물리 컬럼입니다. 예전에는 우연히 동작하던 경로죠. 매핑되지 않은 컬럼으로 필터링해야 한다면 `@Column`으로 선언하거나, `createQueryBuilder()`/`em.query()`로 내려가세요.

**없는 행에 대한 `save()`.** `save()`를 "insert 또는 update"로 쓰고 있었다면 `upsert()`로 의도를 명시하세요. 행이 없을 수도 있다는 걸 정말 전제한 코드라면 `exists()`로 먼저 확인하면 됩니다.

## 결과가 달라지는 것

### `take: 0`과 `limit: 0`은 0행입니다

예전에는 falsy 검사에 걸려 테이블 전체를 반환했습니다. `qb.take(0)`은 늘 `LIMIT 0`이었으니, 이제 둘이 일치합니다. 0이 될 수 있는 페이지 크기를 계산해 넘기면서 "0이면 무제한"에 기대고 있었다면 직접 상한을 두세요.

### `stream()`과 `streamBatch()`가 사용자의 윈도를 존중합니다

내부 배치 로직이 호출자의 `limit`/`take`/`skip`을 덮어썼고, `take`가 배치 크기보다 크면 행이 다시 방출됐습니다. 배치 100에 `take: 150`이면 300건이 나오고 그중 50건이 중복이었죠. 이제 지정한 윈도가 스트림 전체의 윈도입니다. `take`를 넘겼는데도 전부 받아 오던 코드는 이제 요청한 만큼만 받습니다.

### 시간 컬럼은 인스턴트로 기록됩니다

배치 쓰기(`insertMany`, `insertManyAndReturn`, `batchUpsert`)와 자동 `@CreateTimestamp`/`@UpdateTimestamp` 컬럼은 오프셋도 밀리초도 없는 로컬 벽시계 텍스트로 포맷됐고, 단일 행 쓰기는 `Date`를 그대로 바인딩했습니다. 이제 전 경로가 `Date`를 바인딩합니다.

무엇이 달라지냐면,

- 배치 쓰기에서 밀리초가 살아남습니다(컬럼 정밀도가 허용하는 한).
- PostgreSQL `timestamptz`에서 배치 쓰기가 `save()`와 같은 인스턴트를 저장합니다. 애플리케이션 프로세스 타임존과 서버 `TimeZone`이 다르면 둘이 어긋나던 문제였습니다.
- SQLite의 저장 텍스트가 `2026-03-01 21:34:56`이 아니라 ISO-8601 UTC(`2026-03-01T12:34:56.789Z`)입니다.

읽기는 그대로입니다. ORM은 두 표기를 모두 해석하고 있었으니 기존 행의 의미는 유지됩니다. 다만 **저장된 원본 텍스트를 비교**하는 코드, 예를 들어 직접 쓴 SQL이나 익스포트 diff가 있다면 손봐야 합니다. [날짜와 타임존](./timezone.md) 문서를 참고하세요.

### SQLite 소프트 삭제 스탬프

SQLite의 `softDelete()`는 존 표기 없는 UTC인 `datetime('now')`를 썼고, 읽기 쪽은 존 없는 텍스트를 로컬로 해석했습니다. 그래서 `deletedAt`이 프로세스 오프셋만큼 어긋나 돌아왔습니다. 새로 찍히는 값은 `Z` 표기를 답니다.

1.x에서 소프트 삭제된 행은 옛 표기를 그대로 갖고 있습니다. 그 타임스탬프가 "버려진 행인가" 이상의 의미를 가지고 UTC가 아닌 프로세스에서 운영했다면, [날짜와 타임존](./timezone.md#소프트-삭제)에 일회성 보정 문장을 실어 뒀습니다.

## 더 시끄러워지는 것

### `OrmError` 메시지에 제안이 함께 실립니다

실행 가능한 `suggestion`을 갖고 있던 에러는 이제 그 문장을 `message` 끝에 `Suggestion: ...` 줄로 붙입니다. 메시지나 스택을 찍는 로거라면 어디서든 보이게 됩니다. 에러 문자열을 정확히 일치로 단언하는 테스트는 손봐야 하고, `error.suggestion` 자체는 그대로입니다.

### 테넌트 컨텍스트 부재가 보고됩니다

`tenantStrategy: "tenant_column"`에서 `MetadataContext.run()` 밖의 읽기는 모든 테넌트의 행을 아무 경고 없이 훑었습니다. 이제 엔티티 클래스당 한 번 경고합니다. 정책을 명시하세요.

```typescript
await em.register({
  // ...
  tenantStrategy: "tenant_column",
  tenantOnMissingContext: "throw", // "throw" | "warn"(기본) | "allow"
});
```

새 코드에는 `"throw"`를 권장하며, 다음 메이저에서 기본값이 됩니다. 테넌트를 가로지르는 것이 정당한 백그라운드 작업이라면 컨텍스트 부재에 기대지 말고 명시적인 탈출구(`runUnscoped()`, 명시적 `run("public")`, `withoutTenantScope`, `@NonTenantEntity`)를 쓰세요.

### MySQL/MariaDB의 `timestamptz`

두 방언에는 타임존을 아는 `DATETIME`이 없어서 `timestamptz` 컬럼은 `DATETIME`으로 생성되고 오프셋은 저장되지 않습니다. 매핑 자체는 그대로이고, 이제 프로세스당 한 번 경고를 남깁니다.

### 모르는 커넥션 옵션

`register()`가 인식하지 못하는 옵션 키를 무시하지 않고, 가장 가까운 이름을 제안하며 경고합니다.

## 운영에서 달라지는 것

### 마이그레이션 CLI가 실패를 보고합니다

`stingerloom migrate:run`과 `migrate:rollback`은 마이그레이션이 실패하면 종료 코드 **1**을 반환합니다. 예전에는 "0 succeeded, 1 failed"를 info 로그로 찍고 0으로 끝나서, `migrate:run && start` 같은 배포 사슬이 반쯤 마이그레이션된 스키마 위로 그냥 진행됐습니다.

파이프라인을 확인하세요. 실패해도 초록이던 잡이 이제 멈춥니다. 그게 목적이지만, 그동안 티 나지 않게 실패하고 있던 마이그레이션이 드러날 수도 있습니다.

인자 파서도 모르는 플래그, 값이 빠진 옵션, 남는 인자를 그냥 버리지 않고 에러로 보고합니다. 예전에는 `--dry-runn`이 무시됐고, `--ouput ./migrations migrate:run`은 `./migrations`를 커맨드로 실행했습니다.

### NestJS가 종료 시 커넥션 풀을 닫습니다

`StingerloomOrmService.onApplicationShutdown()`이 자신이 연 풀을 닫습니다. `tenantStrategy: "database"`의 테넌트 풀도 전부 포함합니다. Nest의 셧다운 훅 이후에도 커넥션을 쓰던 코드가 있다면 이제 실패하니, 그 작업을 종료 전으로 옮기세요.

## 파괴적이진 않지만 챙길 만한 것

- **쿼리 결과 캐시** — 읽기마다 `cache: true`나 `cache: 30_000`으로 옵트인합니다. 같은 `EntityManager`를 통한 쓰기가 해당 테이블을 무효화합니다. [쿼리 결과 캐시](./caching.md)를 보세요.
- **`defineEntity` 상호 참조** — 코드 우선 엔티티 둘이 `TS7022` 순환 오류 없이 서로를 참조할 수 있습니다. [코드 우선 엔티티](./define-entity.md)를 보세요.
- **`pnpm test:temporal-tz` 패턴** — 시간 관련 동작을 검증하는 스위트가 있다면 `TZ`를 하나로 두지 마세요. UTC에서는 존 없는 기록과 올바른 UTC 기록이 똑같아 보입니다.
