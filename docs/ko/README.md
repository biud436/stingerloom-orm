# Stingerloom ORM

**Stingerloom ORM**은 TypeScript 데코레이터로 데이터베이스를 다루는 가벼운 ORM입니다. 엔티티 클래스를 정의하면 테이블 생성, CRUD, 관계 매핑, 트랜잭션을 자동으로 처리합니다.

```typescript
// user.entity.ts
import { Entity, PrimaryGeneratedColumn, Column } from "@stingerloom/orm";

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
import "reflect-metadata";
import { EntityManager } from "@stingerloom/orm";
import { User } from "./user.entity";

const em = new EntityManager();
await em.register({
  type: "postgres",
  host: "localhost",
  port: 5432,
  username: "postgres",
  password: "postgres",
  database: "app",
  entities: [User],
  synchronize: true, // 프로덕션에서는 비활성화하세요
});

// 생성
const user = await em.save(User, { name: "John Doe", email: "john@example.com" });

// 조회
const users = await em.find(User, { where: { name: "John Doe" } });

// 종료 시 풀/리스너를 항상 정리하세요
await em.propagateShutdown();
```

이게 Stingerloom ORM의 전부입니다. 클래스를 정의하고, 연결하고, 사용하세요.

## 기여자/개발자세요?

프로젝트에 기여하거나 내부 아키텍처를 이해하고 싶으시다면 **[기여자 온보딩 가이드](https://biud436.github.io/stingerloom-orm/ko/onboarding.html)**를 읽어주세요. 로컬 환경 셋업, 아키텍처 개요, 코드 흐름, 새 기능을 추가하는 방법까지 다룹니다.

## 어디서부터 시작할까요?

ORM을 사용하는 것이 목표라면 **시작하기** 가이드부터 시작하세요. 5분 만에 첫 CRUD를 완성할 수 있습니다.

| 순서 | 문서 | 학습 내용 |
|------|------|---------|
| 1 | [시작하기](https://biud436.github.io/stingerloom-orm/ko/getting-started.html) | 설치, 첫 엔티티, 첫 CRUD |
| 2 | [엔티티](https://biud436.github.io/stingerloom-orm/ko/entities.html) | 컬럼, 인덱스, 생명주기 훅, 검증 |
| 3 | [관계](https://biud436.github.io/stingerloom-orm/ko/relations.html) | ManyToOne, OneToMany, ManyToMany |
| 4 | [EntityManager](https://biud436.github.io/stingerloom-orm/ko/entity-manager.html) | find, save, delete, 집계, 페이지네이션 |

## 더 깊이 알아보기

기본을 익혔다면 필요한 주제를 골라 보세요.

| 문서 | 언제 필요할까요? |
|------|----------------|
| [쿼리 빌더](https://biud436.github.io/stingerloom-orm/ko/query-builder.html) | 타입 안전 쿼리, JOIN, GROUP BY, UNION, CTE, 윈도우 함수 |
| [트랜잭션](https://biud436.github.io/stingerloom-orm/ko/transactions.html) | 작업 그룹화, 격리 수준, 데드락 재시도 |
| [마이그레이션](https://biud436.github.io/stingerloom-orm/ko/migrations.html) | 프로덕션에서 안전하게 스키마 변경, CLI (`npx stingerloom`) |
| [설정 가이드](https://biud436.github.io/stingerloom-orm/ko/configuration.html) | 풀링, 타임아웃, Read Replica, CJS/ESM |
| [고급 기능](https://biud436.github.io/stingerloom-orm/ko/advanced.html) | 스트리밍, 이벤트 구독, N+1 감지, 쿼리 빌더 |
| [플러그인](https://biud436.github.io/stingerloom-orm/ko/plugins.html) | 플러그인 시스템과 WriteBuffer (Unit of Work) |
| [WriteBuffer](https://biud436.github.io/stingerloom-orm/ko/write-buffer.html) | Identity Map, 더티 체킹, 캐스케이드, 비관적 잠금 |
| [멀티테넌시](https://biud436.github.io/stingerloom-orm/ko/multi-tenancy.html) | 단일 앱에서 여러 고객 데이터 격리 |
| [API 레퍼런스](https://biud436.github.io/stingerloom-orm/ko/api-reference.html) | 메서드 시그니처 빠른 조회 |

## 지원 데이터베이스

| DB | 상태 |
|----|------|
| PostgreSQL | 완전 지원 (스키마 격리, ENUM, RETURNING) |
| MySQL / MariaDB | 완전 지원 |
| SQLite | 지원 (파일 기반, 풀링 없음) |

## 설치

```bash
pnpm add @stingerloom/orm reflect-metadata
```

> **힌트** 데코레이터 메타데이터를 위해 `reflect-metadata`가 필요합니다. 애플리케이션 진입점 최상단에 `import "reflect-metadata"`를 추가하세요.
