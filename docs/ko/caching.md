# 쿼리 결과 캐시

ORM은 모든 쿼리에 오버헤드를 더합니다. 하지만 가장 빠른 쿼리는 데이터베이스까지 가지 않는 쿼리입니다. 쿼리 결과 캐시는 원하는 읽기의 결과만 골라 수명이 짧은 캐시에 저장합니다. 같은 읽기가 반복되면 데이터베이스 라운드 트립이 생략됩니다. 같은 `EntityManager`로 실행한 쓰기는 영향을 받는 엔트리를 자동으로 무효화합니다.

캐시는 쿼리마다 직접 켜는 opt-in 방식이고 기본값은 꺼짐입니다. 캐시를 요청하지 않은 쿼리의 동작은 그대로입니다.

## 빠른 시작

```typescript
// 기본 TTL(1초)로 캐시
const featured = await em.find(Product, {
  where: { featured: true },
  cache: true,
});

// 30초 캐시
const stats = await em.findAndCount(Order, {
  where: { status: "paid" },
  cache: 30_000,
});

// 쿼리 빌더의 실행 메서드도 같은 방식으로 동작합니다
const top = await em
  .createQueryBuilder(Product, "p")
  .where("featured", true)
  .orderBy({ score: "DESC" })
  .limit(10)
  .cache(30_000)
  .getMany();
```

`cache` 옵션은 세 가지 형태를 받습니다.

| 형태 | 의미 |
|------|------|
| `true` | 연결 수준 기본 TTL로 캐시 (설정하지 않으면 1000ms) |
| `number` | 해당 밀리초만큼 캐시 |
| `{ ttl?, tag? }` | TTL 오버라이드 + 수동 무효화용 사용자 태그 |

`find`, `findOne`, `findBy`, `findOneBy`, `findOneOrFail`, `findAndCount`, `findWithPage`, `findWithCursor`는 `cache` 옵션을 받습니다. `SelectQueryBuilder`에서는 `.cache()`로 켭니다. `.cache()`는 `getMany`, `getOne`, `getRawMany`, `getPartialMany`, `getCount`, 집계 스칼라, `exists`에 적용됩니다.

## 캐시 대상

캐시에는 엔티티 인스턴스가 아니라 원시 행 집합을 저장합니다. 캐시 히트가 나면 저장된 행을 평소의 하이드레이트 파이프라인에 다시 통과시킵니다. 그래서 히트든 미스든 호출할 때마다 새 엔티티 인스턴스를 반환합니다. 컬럼 트랜스포머와 `afterLoad` 구독자도 실행되고 지연 로딩 프록시도 설치됩니다. 데이터베이스를 읽었을 때와 정확히 같습니다. 반환된 엔티티를 수정해도 캐시는 오염되지 않습니다.

`find` 한 번이 SQL 문 여러 개를 실행하기도 합니다. 루트 쿼리와 `relations: [...]`의 관계 로더 쿼리가 그 예입니다. 각 SQL 문의 행 집합은 같은 정책으로 따로 캐시됩니다. 그래서 관계를 로드하는 `find`도 모든 SQL 문이 캐시에 있으면 데이터베이스에 전혀 접근하지 않습니다.

## 무효화

캐시된 행 집합에는 그 읽기가 접근했을 가능성이 있는 테이블이 모두 태그로 붙습니다. 대상은 아래와 같습니다.

- 엔티티 자신의 테이블
- 상속 계열(STI/TPT/TPC)의 테이블
- 즉시 로딩 관계와 요청한 관계의 대상 테이블
- 다대다 조인 테이블
- 읽기의 `where`나 관계 자체의 `where`에 쓴 관계 필터(`some` / `none` / `every` / `is` / `isNot`)가 읽는 테이블

같은 `EntityManager`로 실행한 쓰기는 그 쓰기가 영향을 줄 수 있는 테이블의 태그가 붙은 엔트리를 모두 무효화합니다. `save`, `update`, `updateMany`, `delete`, `softDelete`, `restore`, `upsert`, `insertMany`, `increment` 같은 쓰기가 모두 해당합니다. `ON DELETE CASCADE` 외래 키로 이어진 자식 테이블도 포함됩니다. 그래서 "posts를 함께 로드한 authors" 결과는 post 하나만 수정해도 캐시에서 삭제됩니다.

캐시가 감지하지 못하는 쓰기는 아래와 같습니다.

- **다른 프로세스의 쓰기**: 다른 서버 인스턴스나 수동 SQL 세션의 쓰기입니다. 이런 쓰기가 남긴 낡은 엔트리는 TTL이 지나야 사라집니다. 기본 TTL이 1초로 짧은 것도 이 때문입니다. TTL은 쿼리를 실행하는 빈도가 아니라 "이 읽기가 몇 초까지 낡아도 되는가"를 기준으로 정하세요.
- **`em.query(...)`로 실행한 raw SQL 쓰기**: ORM은 raw SQL 문에서 테이블 이름을 파싱하지 않습니다. 이런 쓰기 뒤에는 직접 무효화하세요.

아래 메서드로 캐시를 언제든 직접 제어합니다.

```typescript
await em.queryCache?.invalidate(Product);        // 엔티티로 (쓰기 클로저)
await em.queryCache?.invalidate("dashboard");    // 사용자 태그로
await em.queryCache?.clear();                     // 전체
em.queryCache?.stats;                             // { hits, misses, entries }
```

사용자 태그는 한꺼번에 무효화할 쿼리 묶음에 붙이는 이름입니다.

```typescript
await em.find(Product, { where: { featured: true }, cache: { ttl: 60_000, tag: "storefront" } });
await em.find(Banner, { cache: { ttl: 60_000, tag: "storefront" } });

// CMS 발행 후:
await em.queryCache?.invalidate("storefront");
```

## 일관성 규칙

캐시는 항상 최신 값을 읽어야 하는 쿼리의 의미를 바꾸지 않습니다.

- **트랜잭션 안의 읽기는 캐시를 우회합니다.** 트랜잭션은 자신이 아직 커밋하지 않은 쓰기를 읽어야 하기 때문입니다. `@Transactional`, `em.transaction()`, 명시적 세션에서 실행하는 읽기가 모두 해당합니다.
- **잠금 읽기는 캐시를 우회합니다.** `lock: PESSIMISTIC_WRITE`와 쿼리 빌더의 잠금 절은 항상 데이터베이스에서 실행됩니다. 아무것도 잠그지 않는 잠금은 정확성 버그이기 때문입니다.
- **캐시를 요청하지 않은 읽기는 캐시를 읽지도 채우지도 않습니다.**

무효화도 같은 원칙을 따릅니다. 쓰기의 무효화는 그 쓰기가 확정되기 전에 실행되지 않습니다.

- **쓰기는 트랜잭션이 끝날 때 무효화합니다.** `em.transaction()`, `@Transactional`, 또는 cascade가 걸린 `save()` / `delete()`가 스스로 여는 트랜잭션 안에서는 무효화를 보류합니다. 보류한 무효화는 COMMIT 뒤에 실행하고 ROLLBACK 뒤에도 실행합니다. PostgreSQL과 MySQL에서는 트랜잭션이 열려 있는 동안 바깥의 캐시 읽기가 트랜잭션이 바꾸고 있는 이전 행으로 엔트리를 채우기도 합니다. 하지만 그 엔트리는 트랜잭션이 끝나면 함께 무효화됩니다. SQLite에서는 모든 세션이 연결 하나를 공유하므로 읽기가 트랜잭션이 끝날 때까지 대기합니다. 트랜잭션 밖의 쓰기는 반환되는 즉시 무효화합니다. 실패한 쓰기도 마찬가지입니다.
- **테이블이 무효화되는 동안 실행 중이던 읽기는 저장하지 않습니다.** 그래서 COMMIT 직전에 조회한 행이 COMMIT 뒤에 캐시에 들어가는 일이 없습니다.
- **트랜잭션 안의 `invalidate()`와 `clear()`는 즉시 실행하고 트랜잭션이 끝날 때 한 번 더 실행합니다.**

`em.transaction()`은 보류한 무효화가 끝난 뒤에 반환합니다. 그래서 `em.transaction()`이 반환된 뒤의 읽기는 트랜잭션 때문에 낡은 엔트리를 읽지 않습니다.

## 설정

쿼리 단위 opt-in은 설정 없이 바로 동작합니다. 기본값은 연결 옵션으로 조정합니다.

```typescript
await em.register({
  type: "postgres",
  // ...
  cache: {
    ttl: 5_000,        // `cache: true`의 기본 TTL (기본값 1000)
    maxEntries: 5_000, // 인메모리 저장소 용량 (기본값 1000 엔트리)
  },
});
```

`cache: false`는 kill switch입니다. 쿼리마다 넘긴 `cache` 요청을 모두 무시합니다. 호출부를 고치지 않고 테스트 환경에서 캐시를 끌 때 유용합니다.

### 커스텀 저장소

기본 저장소는 엔트리마다 TTL을 두는 인메모리 LRU입니다. 이 저장소는 그 `EntityManager`만 사용합니다. Redis처럼 여러 프로세스가 공유하는 캐시를 쓰려면 `QueryCacheStore`를 구현하세요.

```typescript
import { QueryCacheStore } from "@stingerloom/orm";

class RedisQueryCacheStore implements QueryCacheStore {
  async get(key: string) { /* ... */ }
  async set(key: string, value: unknown, ttlMs: number, tags: readonly string[]) { /* ... */ }
  async invalidateTags(tags: readonly string[]) { /* ... */ }
  async clear() { /* ... */ }
}

await em.register({
  // ...
  cache: { store: new RedisQueryCacheStore() },
});
```

저장소를 직접 구현할 때 참고할 점입니다.

- 키는 네임스페이스, SQL 텍스트, 바인드 값으로 만든 평문 문자열입니다. 짧은 키가 필요한 백엔드라면 저장소 쪽에서 해시하세요.
- `value`는 불투명한 스냅샷입니다. `set`으로 받은 값을 그대로 반환하면 됩니다.
- 태그 무효화는 주어진 태그 중 하나라도 붙은 엔트리를 모두 삭제해야 합니다.
- 실패하면 에러를 던지세요. ORM은 경고를 한 번 남기고 데이터베이스로 폴백합니다. 고장 난 캐시는 "캐시 없음"으로 강등될 뿐이고 에러로 이어지지 않습니다.
- 트랜잭션에 보류된 `invalidateTags` 호출은 COMMIT이나 ROLLBACK 뒤에 실행됩니다. `em.transaction()`은 그 호출이 끝나기를 기다린 뒤에 반환합니다. 저장소가 느리면 반환이 늦어질 뿐이고 커밋은 늦어지지 않습니다.

`register` 시점에 저장소를 설정하면 ORM은 캐시를 그 자리에서 생성합니다. 그래서 쓰기만 하는 프로세스도 무효화를 공유 백엔드에 전달합니다.

`propagateShutdown()`은 기본 인메모리 저장소를 비웁니다. 커스텀 저장소는 그대로 둡니다. 커스텀 저장소는 다른 프로세스와 함께 쓸 수도 있고 애플리케이션이 직접 관리하는 대상이기 때문입니다. 종료 뒤에도 EntityManager를 계속 쓰면 캐시는 빈 상태에서 시작해 이전처럼 동작합니다.

## 멀티테넌시

캐시 키의 네임스페이스는 연결 이름, 스키마, 현재 테넌트(`MetadataContext`)로 나뉩니다. `search_path` 기반 스키마 테넌시에서는 두 테넌트가 바이트 단위로 같은 SQL을 실행합니다. 그래도 한 테넌트가 다른 테넌트의 행을 캐시에서 읽는 일은 없습니다.

무효화 범위는 일부러 더 넓게 잡았습니다. 쓰기는 그 연결의 모든 테넌트에서 영향받는 테이블을 무효화합니다. 그래서 테넌트 A의 쓰기가 같은 테이블을 읽은 테넌트 B의 엔트리까지 삭제합니다. 필요 이상으로 무효화하지만 항상 안전한 방향입니다.

## 사용 시점

캐시가 잘 맞는 쿼리는 아래와 같습니다.

- 자주 실행되는 읽기 위주의 쿼리: 내비게이션 트리, 설정, 피처 플래그, 상품 목록, 대시보드 카운터
- 요청마다 다시 계산되는 비싼 집계: `findAndCount` 쌍, `getCount`
- "최대 N초 낡아도 된다"가 계약으로 허용되는 엔드포인트

캐시가 맞지 않는 쿼리는 아래와 같습니다.

- 캐시가 감지하지 못하는 쓰기 직후에 읽는 데이터: raw SQL로 쓰는 큐 컨슈머나 데이터베이스를 공유하는 다른 서비스의 쓰기가 그 예입니다. 다만 TTL이 그 지연을 흡수할 만큼 짧다면 캐시를 써도 됩니다.
- 자유 입력 검색처럼 파라미터가 반복되지 않는 쿼리: 호출할 때마다 미스가 나고 스냅샷 비용만 늘어납니다.

반복되지만 항상 최신이어야 하는 쿼리에는 [사전 컴파일 쿼리](/ko/query-builder-execution)를 쓰세요. 사전 컴파일 쿼리는 SQL 조립 오버헤드는 건너뛰지만 데이터베이스는 매번 조회합니다. 두 기능은 서로 보완합니다. 사전 컴파일 쿼리는 CPU를 아끼고 캐시된 쿼리는 라운드 트립을 아낍니다.
