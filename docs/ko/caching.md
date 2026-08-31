# 쿼리 결과 캐시

ORM은 모든 쿼리에 오버헤드를 얹지만, 가장 빠른 쿼리는 애초에 데이터베이스까지 가지 않는 쿼리입니다. 쿼리 결과 캐시는 개별 읽기를 짧은 수명의 캐시에 opt-in 방식으로 태울 수 있게 해줍니다. 동일한 읽기가 반복되면 DB 왕복 자체가 사라지고, 같은 `EntityManager`를 통한 쓰기는 영향을 받는 엔트리를 자동으로 무효화합니다.

캐시는 **쿼리 단위 opt-in**이며 기본값은 꺼짐입니다. 요청하지 않은 쿼리는 아무것도 달라지지 않습니다.

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

// 쿼리 빌더 터미널도 동일하게 동작합니다
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

`find`, `findOne`, `findBy`, `findOneBy`, `findOneOrFail`, `findAndCount`, `findWithPage`, `findWithCursor`에서 쓸 수 있고, `SelectQueryBuilder`에서는 `.cache()`로 켭니다(`getMany`, `getOne`, `getRawMany`, `getPartialMany`, `getCount`, 집계 스칼라, `exists`에 적용).

## 정확히 무엇이 캐시되는가

캐시에 저장되는 것은 **원시 행 집합**이지 엔티티 인스턴스가 아닙니다. 캐시 히트는 저장된 행을 평소의 하이드레이션 파이프라인에 다시 태우기 때문에, 히트든 미스든 매 호출은 새 엔티티 인스턴스를 돌려받고, 컬럼 트랜스포머가 실행되고, `afterLoad` 구독자가 발화하고, lazy 로딩 프록시가 설치됩니다 — DB를 읽었을 때와 정확히 같습니다. 반환된 엔티티를 변형해도 캐시는 오염되지 않습니다.

`find` 한 번이 SQL 여러 개를 발행할 수 있는데(루트 쿼리 + `relations: [...]`의 관계 로더 쿼리), 각 문장의 행 집합이 같은 정책 아래 개별 캐시됩니다. 그래서 관계를 실은 `find`가 전부 캐시에 올라 있으면 DB를 전혀 건드리지 않고 해석됩니다.

## 무효화

캐시된 행 집합은 그 읽기가 접근할 수 있었던 테이블들로 인덱싱됩니다: 엔티티 자신의 테이블, 상속 패밀리(STI/TPT/TPC), eager·요청된 관계의 대상, 다대다 조인 테이블까지요.

같은 `EntityManager`를 통한 쓰기 — `save`, `update`, `updateMany`, `delete`, `softDelete`, `restore`, `upsert`, `insertMany`, `increment` 등 — 는 그 쓰기가 닿을 수 있는 테이블로 태깅된 엔트리를 전부 무효화합니다. `ON DELETE CASCADE` 외래 키로 도달 가능한 자식 테이블도 포함되므로, 캐시된 "posts를 실은 authors" 결과는 post 하나만 수정해도 함께 떨어집니다.

캐시가 **볼 수 없는 것**:

- **다른 프로세스의 쓰기** (다른 서버 인스턴스, 수동 SQL 세션). 이건 TTL로만 제한됩니다 — 기본 TTL이 1초인 이유입니다. TTL은 쿼리 빈도가 아니라 "이 읽기는 몇 초까지 낡아도 되는가"로 정하세요.
- **`em.query(...)`를 통한 raw SQL 쓰기**. raw 문장에서 테이블명을 파싱하지 않습니다. 이런 쓰기 뒤에는 수동으로 무효화하세요.

수동 제어는 언제든 가능합니다.

```typescript
await em.queryCache?.invalidate(Product);        // 엔티티로 (쓰기 클로저)
await em.queryCache?.invalidate("dashboard");    // 사용자 태그로
await em.queryCache?.clear();                     // 전체
em.queryCache?.stats;                             // { hits, misses, entries }
```

사용자 태그는 한꺼번에 떨어뜨리고 싶은 쿼리 묶음에 이름을 붙입니다.

```typescript
await em.find(Product, { where: { featured: true }, cache: { ttl: 60_000, tag: "storefront" } });
await em.find(Banner, { cache: { ttl: 60_000, tag: "storefront" } });

// CMS 발행 후:
await em.queryCache?.invalidate("storefront");
```

## 일관성 규칙

캐시는 "지금 당장 정확해야 하는" 쿼리의 시맨틱을 절대 바꾸지 않습니다.

- **트랜잭션 안의 읽기는 캐시를 우회합니다** — 트랜잭션은 자신의 미커밋 쓰기를 봐야 하니까요. `@Transactional`, `em.transaction()`, 명시적 세션 위의 읽기 모두 해당합니다.
- **잠금 읽기는 캐시를 우회합니다** — `lock: PESSIMISTIC_WRITE`(그리고 쿼리 빌더의 잠금 절)는 항상 DB에 도달합니다. 아무것도 잠그지 않는 잠금은 정확성 버그입니다.
- **캐시를 요청하지 않은 읽기는 캐시를 읽지도, 채우지도 않습니다.**

알아둘 주의점 하나: 트랜잭션 안의 쓰기는 커밋 시점이 아니라 즉시 무효화합니다. 무효화와 커밋 사이에 동시 실행 중인 캐시 읽기가 커밋 전 상태로 엔트리를 다시 채울 수 있는데, 그 엔트리의 수명은 TTL이 제한합니다.

## 설정

쿼리 단위 opt-in은 설정 없이 바로 동작합니다. 연결 옵션으로는 기본값을 조정합니다.

```typescript
await em.register({
  type: "postgres",
  // ...
  cache: {
    ttl: 5_000,        // `cache: true`의 기본 TTL (기본값 1000)
    maxEntries: 5_000, // 인메모리 스토어 용량 (기본값 1000 엔트리)
  },
});
```

`cache: false`는 kill switch입니다. 모든 쿼리 단위 `cache` 요청이 무시됩니다. 호출부를 건드리지 않고 테스트 환경에서 캐시를 끄고 싶을 때 유용합니다.

### 커스텀 스토어

기본 스토어는 `EntityManager` 전용 인메모리 LRU(엔트리별 TTL)입니다. 여러 프로세스가 하나의 캐시를 공유하려면(예: Redis) `QueryCacheStore`를 구현하세요.

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

스토어 작성 시 참고:

- 키는 평문 문자열입니다(네임스페이스 + SQL 텍스트 + 바인드 값). 짧은 키가 필요한 백엔드라면 스토어 쪽에서 해시하세요.
- `value`는 불투명한 스냅샷입니다. `set`으로 받은 것을 그대로 돌려주면 됩니다.
- 태그 무효화는 주어진 태그 중 하나라도 달린 엔트리를 전부 떨어뜨려야 합니다.
- 실패하면 throw하세요. ORM이 경고를 한 번 남기고 DB로 폴백합니다 — 고장 난 캐시는 "캐시 없음"으로 강등될 뿐, 에러가 되지 않습니다.

`register` 시점에 스토어를 설정하면 즉시 생성됩니다. 쓰기만 하는 프로세스도 공유 백엔드로 무효화를 밀어 넣을 수 있게 하기 위해서입니다.

## 멀티테넌시

캐시 키는 커넥션 이름, 스키마, 현재 테넌트(`MetadataContext`)로 네임스페이스가 나뉩니다. `search_path` 기반 스키마 테넌시처럼 두 테넌트가 바이트 단위로 동일한 SQL을 발행해도, 서로의 행을 캐시에서 읽는 일은 일어날 수 없습니다.

무효화는 의도적으로 더 넓게 잡았습니다. 쓰기는 해당 커넥션의 모든 테넌트에 걸쳐 영향받는 테이블을 무효화합니다. 테넌트 A의 쓰기가 같은 테이블에 대한 테넌트 B의 엔트리도 떨어뜨리니 과잉이지만, 항상 안전한 방향의 과잉입니다.

## 언제 쓰면 좋은가

잘 맞는 곳:

- 읽기 위주의 뜨거운 쿼리: 내비게이션 트리, 설정, 피처 플래그, 상품 목록, 대시보드 카운터.
- 요청마다 다시 계산되는 비싼 집계(`findAndCount` 쌍, `getCount`).
- "최대 N초 낡아도 된다"가 계약으로 허용되는 엔드포인트.

맞지 않는 곳:

- 대역 외 쓰기 직후에 읽는 데이터(raw SQL을 쓰는 큐 컨슈머, DB를 공유하는 다른 서비스) — TTL이 그 지연을 흡수할 만큼 짧지 않다면요.
- 파라미터가 반복되지 않는 쿼리(자유 입력 검색) — 매 호출이 미스인데 스냅샷 비용만 붙습니다.

반복되지만 항상 **최신**이어야 하는 쿼리에는 [사전 컴파일 쿼리](/ko/query-builder-execution)를 쓰세요. SQL 조립 오버헤드는 건너뛰되 DB는 매번 조회합니다. 둘은 상호 보완적입니다 — 컴파일드 쿼리는 CPU를, 캐시된 쿼리는 왕복을 아낍니다.
