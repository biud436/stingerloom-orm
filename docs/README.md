# Stingerloom ORM

**Stingerloom ORM**은 TypeScript 데코레이터로 데이터베이스를 다루는 경량 ORM입니다. 엔티티 클래스를 정의하면 테이블 생성부터 CRUD, 관계 매핑, 트랜잭션까지 자동으로 처리됩니다.

```typescript
// user.entity.ts
import { Entity, PrimaryGeneratedColumn, Column } from "stingerloom-orm";

@Entity()
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @Column()
  email!: string;
}
```

```typescript
// main.ts
const em = new EntityManager();
await em.register({ type: "postgres", /* ... */ entities: [User], synchronize: true });

// 생성
const user = await em.save(User, { name: "홍길동", email: "hong@example.com" });

// 조회
const users = await em.find(User, { where: { name: "홍길동" } });
```

이것이 Stingerloom ORM의 전부입니다. 클래스를 정의하고, 연결하고, 사용하세요.

## 기여자/개발자라면?

프로젝트에 기여하거나 내부 구조를 이해하고 싶다면 **[컨트리뷰터 온보딩 가이드](./onboarding.md)**를 읽어주세요. 로컬 환경 설정, 아키텍처 개요, 코드 흐름, 새 기능 추가 방법을 다룹니다.

## 어디서 시작하나요?

ORM을 사용하는 것이 목적이라면 **시작하기** 문서부터 따라해보세요. 5분이면 첫 번째 CRUD를 완성할 수 있습니다.

| 순서 | 문서 | 배우는 것 |
|------|------|----------|
| 1 | [시작하기](./getting-started.md) | 설치, 첫 엔티티, 첫 CRUD |
| 2 | [엔티티 정의](./entities.md) | 컬럼, 인덱스, 생명주기 훅, 유효성 검사 |
| 3 | [관계 설정](./relations.md) | ManyToOne, OneToMany, ManyToMany |
| 4 | [EntityManager](./entity-manager.md) | find, save, delete, 집계, 페이지네이션 |

## 더 깊이 들어가기

기본을 익혔다면 필요한 주제를 골라 읽으세요.

| 문서 | 언제 필요한가요? |
|------|----------------|
| [쿼리 빌더](./query-builder.md) | JOIN, GROUP BY, 서브쿼리 등 복잡한 SQL이 필요할 때 |
| [트랜잭션](./transactions.md) | 여러 작업을 하나의 단위로 묶어야 할 때 |
| [마이그레이션](./migrations.md) | 프로덕션에서 스키마를 안전하게 변경할 때 |
| [설정 가이드](./configuration.md) | 풀링, 타임아웃, Read Replica 등을 설정할 때 |
| [고급 기능](./advanced.md) | 성능 최적화, 이벤트 구독, N+1 감지가 필요할 때 |
| [멀티테넌시](./multi-tenancy.md) | 하나의 앱에서 여러 고객 데이터를 격리할 때 |
| [API 레퍼런스](./api-reference.md) | 메서드 시그니처를 빠르게 확인할 때 |

## 지원 데이터베이스

| DB | 상태 |
|----|------|
| PostgreSQL | 전체 지원 (스키마 격리, ENUM, RETURNING) |
| MySQL / MariaDB | 전체 지원 |
| SQLite | 지원 (파일 기반, 풀링 미지원) |

## 설치

```bash
pnpm add stingerloom-orm reflect-metadata
```

> **Hint** `reflect-metadata`는 데코레이터 메타데이터에 필요합니다. 앱 진입점 최상단에서 `import "reflect-metadata"`를 추가하세요.
