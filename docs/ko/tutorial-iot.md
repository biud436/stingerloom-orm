# Tutorial: IoT 스마트 온도계 백엔드 만들기

## 무엇을 만드나요?

스마트 빌딩을 떠올려 보세요. 벽, 천장, 에어덕트에 작은 온도계 수천 개가 설치되어 있습니다. 각 온도계는 30초마다 중앙 서버로 온도 데이터를 전송합니다. 모바일 앱은 실시간 대시보드를 보여 줍니다. 서버실이 과열되면 알림이 울립니다. 매일 밤 cron job이 데이터를 집계해서 일일 리포트를 만듭니다.

이번에는 서로 다른 회사가 소유한 빌딩 10개가 백엔드 하나에서 동작한다고 가정해 보겠습니다. A회사는 B회사의 데이터를 절대 볼 수 없어야 합니다. 이런 구조를 **멀티테넌시**(multi-tenancy)라고 합니다.

NestJS와 Stingerloom ORM으로 이 백엔드를 처음부터 만들어 보겠습니다. 아키텍처는 아래와 같습니다.

```
┌───────────────┐     ┌───────────────┐
│  Android App  │     │   iOS App     │
└──────┬────────┘     └──────┬────────┘
       │   HTTPS + JWT       │
       └──────────┬──────────┘
                  ▼
       ┌─────────────────────┐
       │   NestJS API Server │
       │  ┌───────────────┐  │
       │  │  Keycloak JWT │  │ ← Authentication
       │  │  Guard        │  │
       │  ├───────────────┤  │
       │  │  Tenant       │  │ ← Multi-tenancy context
       │  │  Middleware    │  │
       │  ├───────────────┤  │
       │  │  Stingerloom  │  │ ← Entity definitions, CRUD,
       │  │  ORM          │  │   aggregation, streaming
       │  └───────────────┘  │
       └──┬─────┬────────┬───┘
          │     │        │
          ▼     ▼        ▼
      ┌──────┐ ┌─────┐ ┌───────┐
      │Postgres│ │Redis│ │BullMQ │
      │(data) │ │(cache)│ │(cron) │
      └──────┘ └─────┘ └───────┘
```

### ORM의 역할 - 그리고 ORM이 아닌 것

코드를 작성하기 전에 ORM이 맡는 범위를 분명히 짚고 넘어가겠습니다. ORM은 TypeScript 객체와 데이터베이스 사이를 변환하는 도구입니다. 캐시도 잡 큐도 인증 시스템도 아닙니다.

| 관심사 | 담당 | 담당하지 않는 것 |
|--------|------|-----------------|
| 엔티티 정의 & 스키마 | Stingerloom ORM | 없음 |
| 멀티테넌트 스키마 라우팅 | Stingerloom ORM (MetadataContext) | 없음 |
| CRUD 연산 | Stingerloom ORM (EntityManager) | 없음 |
| 집계 쿼리 | Stingerloom ORM (avg/min/max/count) | 없음 |
| 대량 데이터 배치 처리 | Stingerloom ORM (stream()) | 없음 |
| JWT 인증 | NestJS + Passport | ORM |
| 응답 캐싱 | Redis (ioredis) | ORM |
| 백그라운드 잡 / cron | BullMQ (@nestjs/bullmq) | ORM |
| 푸시 알림 | FCM / APNs | ORM |

ORM의 범위를 벗어나는 곳에는 `::: tip`이나 `::: warning` 박스를 두고 어떤 도구가 무엇을 맡는지 설명합니다.

---

## Step 0: Docker Compose로 인프라 구성

코드를 작성하기 전에 로컬에서 서비스 세 개를 실행해야 합니다. 데이터 저장용 PostgreSQL, 캐싱용 Redis, JWT 인증용 Keycloak입니다.

프로젝트 루트에 `docker-compose.yml`을 만드세요.

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:15-alpine
    environment:
      POSTGRES_DB: smart_thermo
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres
    ports:
      - "5432:5432"
    volumes:
      - pg_data:/var/lib/postgresql/data

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  keycloak:
    image: quay.io/keycloak/keycloak:24.0
    command: start-dev
    environment:
      KEYCLOAK_ADMIN: admin
      KEYCLOAK_ADMIN_PASSWORD: admin
      KC_DB: postgres
      KC_DB_URL: jdbc:postgresql://postgres:5432/smart_thermo
      KC_DB_USERNAME: postgres
      KC_DB_PASSWORD: postgres
    ports:
      - "8080:8080"
    depends_on:
      - postgres

volumes:
  pg_data:
```

```bash
docker compose up -d
```

세 컨테이너가 모두 healthy 상태가 되면 Keycloak을 설정합니다.

1. `http://localhost:8080`에서 `admin` / `admin`으로 로그인
2. `smart-thermo` 이름의 realm 생성
3. `smart-thermo-api` 이름의 client 생성 (Access Type: confidential)
4. client의 Mappers 탭에서 아래 mapper 추가
   - Name: `tenantId`
   - Mapper Type: User Attribute
   - User Attribute: `tenantId`
   - Token Claim Name: `tenantId`
   - Claim JSON Type: `String`
   - Add to ID token: ON, Add to access token: ON
5. 테스트 사용자를 생성하고 `tenantId` 속성을 `building_a`로 설정

이렇게 설정하면 테넌트 식별자가 JWT에 직접 들어갑니다. 그래서 모바일 앱이 인증하고 받은 토큰에는 사용자가 속한 빌딩 정보가 이미 담겨 있습니다.

---

## Step 1: 프로젝트 설정

### NestJS 프로젝트 생성

```bash
nest new smart-thermo-api
cd smart-thermo-api
```

### 의존성 설치

::: code-group
```bash [pnpm]
pnpm add @stingerloom/orm pg reflect-metadata
pnpm add @nestjs/passport passport passport-jwt jwks-rsa
pnpm add @nestjs/bullmq bullmq
pnpm add @nestjs-modules/ioredis ioredis
pnpm add -D @types/passport-jwt
```
```bash [npm]
npm install @stingerloom/orm pg reflect-metadata
npm install @nestjs/passport passport passport-jwt jwks-rsa
npm install @nestjs/bullmq bullmq
npm install @nestjs-modules/ioredis ioredis
npm install -D @types/passport-jwt
```
:::

### 데코레이터 활성화

`tsconfig.json`에 아래 옵션이 있는지 확인하세요.

```json
{
  "compilerOptions": {
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true
  }
}
```

### ORM 설정

```typescript
// src/app.module.ts
import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { RedisModule } from "@nestjs-modules/ioredis";
import { Device } from "./entities/device.entity";
import { User } from "./entities/user.entity";
import { TemperatureReading } from "./entities/temperature-reading.entity";
import { AlertRule } from "./entities/alert-rule.entity";
import { Alert } from "./entities/alert.entity";
import { DailyStats } from "./entities/daily-stats.entity";

@Module({
  imports: [
    StingerloomOrmModule.forRoot({
      type: "postgres",
      host: process.env.DB_HOST || "localhost",
      port: parseInt(process.env.DB_PORT || "5432"),
      username: process.env.DB_USER || "postgres",
      password: process.env.DB_PASSWORD || "postgres",
      database: process.env.DB_NAME || "smart_thermo",
      entities: [User, Device, TemperatureReading, AlertRule, Alert, DailyStats],
      synchronize: true,
      logging: true,
    }),
    RedisModule.forRoot({
      type: "single",
      url: process.env.REDIS_URL || "redis://localhost:6379",
    }),
    // ... other modules added later
  ],
})
export class AppModule {}
```

`RedisModule.forRoot()`는 글로벌 Redis 연결을 등록합니다. 그래서 어디서든 `@InjectRedis()`로 이 연결을 주입할 수 있습니다. 서비스마다 `new Redis()`를 만들 필요가 없습니다.

::: warning
`synchronize: true`는 개발 중에 편리합니다. ORM이 엔티티에 맞춰 테이블을 자동으로 생성하고 변경하기 때문입니다. 하지만 프로덕션에서는 절대 쓰면 안 됩니다. 프로덕션에서는 [마이그레이션](./migrations.md)을 쓰세요.
:::

---

## Step 2: 엔티티 설계

좋은 엔티티 설계는 도메인을 이해하는 데서 시작합니다. 스마트 온도계 시스템의 핵심 개념은 아래와 같습니다.

- **Users**: 디바이스를 소유한 사람 (온도계를 설치한 사람)
- **Devices**: 물리적 온도계. 온도계마다 시리얼 넘버와 위치 정보가 있습니다.
- **Temperature Readings**: 시계열 데이터 포인트. 디바이스마다 30초에 하나씩 생성됩니다.
- **Alert Rules**: "온도가 35도를 넘으면 알려 줘" 같은 임계값 정의
- **Alerts**: 규칙을 위반했을 때 발생하는 알림
- **Daily Stats**: 평균, 최소, 최대를 미리 계산한 일일 요약. 대시보드를 빠르게 렌더링하는 데 씁니다.

```
┌──────────┐       ┌──────────┐       ┌─────────────────────┐
│   User   │1    * │  Device  │1    * │ TemperatureReading   │
│──────────│───────│──────────│───────│─────────────────────│
│ id       │       │ id       │       │ id                  │
│ name     │       │ serial   │       │ temperatureCelsius  │
│ email    │       │ name     │       │ humidity            │
│ keycloak │       │ location │       │ batteryLevel        │
│ deletedAt│       │ isActive │       │ recordedAt          │
└──────────┘       └──────┬───┘       └─────────────────────┘
                          │
                   ┌──────┴───────────────────┐
                   │1                        1│
                   ▼ *                        ▼ *
           ┌─────────────┐            ┌─────────────┐
           │  AlertRule   │            │  DailyStats  │
           │─────────────│            │─────────────│
           │ condition    │            │ date         │
           │ threshold    │            │ avgTemp      │
           │ isEnabled    │            │ minTemp      │
           └──────┬──────┘            │ maxTemp      │
                  │1                  │ readingCount │
                  ▼ *                 └─────────────┘
           ┌─────────────┐
           │   Alert      │
           │─────────────│
           │ temperature  │
           │ acknowledged │
           │ firedAt      │
           └─────────────┘
```

### User

```typescript
// src/entities/user.entity.ts
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  OneToMany,
  CreateTimestamp,
  DeletedAt,
} from "@stingerloom/orm";
import { Device } from "./device.entity";

@Entity({ name: "users" })
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 100 })
  name!: string;

  @Column({ type: "varchar", length: 255 })
  email!: string;

  @Column({ type: "uuid" })
  keycloakSubjectId!: string;

  @OneToMany(() => Device, { mappedBy: "user" })
  devices!: Device[];

  @CreateTimestamp()
  createdAt!: Date;

  @DeletedAt()
  deletedAt!: Date | null;
}
```

`@DeletedAt()` 데코레이터는 소프트 삭제를 켭니다. `em.delete(User, { id: 1 })`를 호출해도 ORM은 행을 실제로 삭제하지 않습니다. 대신 `deletedAt`에 현재 타임스탬프를 설정합니다. 이후 모든 `find()` 쿼리는 `withDeleted: true`를 넘기지 않는 한 소프트 삭제된 행을 자동으로 제외합니다. 이 기능은 GDPR 준수에 꼭 필요합니다. 화면에서는 사용자를 "삭제"한 것처럼 보이게 하면서 감사 추적은 보존하기 때문입니다.

```sql
-- What the ORM generates for this entity (PostgreSQL)
CREATE TABLE "users" (
  "id" SERIAL PRIMARY KEY,
  "name" VARCHAR(100) NOT NULL,
  "email" VARCHAR(255) NOT NULL,
  "keycloakSubjectId" UUID NOT NULL,
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "deletedAt" TIMESTAMP
);
```

### Device

```typescript
// src/entities/device.entity.ts
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  OneToMany,
  RelationColumn,
  Index,
  CreateTimestamp,
  UpdateTimestamp,
  BeforeInsert,
} from "@stingerloom/orm";
import { User } from "./user.entity";
import { TemperatureReading } from "./temperature-reading.entity";

@Entity({ name: "devices" })
export class Device {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index()
  @Column({ type: "varchar", length: 64 })
  serialNumber!: string;

  @Column({ type: "varchar", length: 100 })
  name!: string;

  @Column({ type: "varchar", length: 200, nullable: true })
  location!: string | null;

  @Column({ type: "boolean" })
  isActive!: boolean;

  @ManyToOne(() => User, (user) => user.devices)
  @RelationColumn({ name: "user_id" })
  user!: User;

  @OneToMany(() => TemperatureReading, { mappedBy: "device" })
  readings!: TemperatureReading[];

  @CreateTimestamp()
  createdAt!: Date;

  @UpdateTimestamp()
  updatedAt!: Date;

  @BeforeInsert()
  setDefaults() {
    if (this.isActive === undefined) this.isActive = true;
    if (!this.name) this.name = `Sensor-${this.serialNumber}`;
  }
}
```

`@BeforeInsert()` 훅은 INSERT SQL을 데이터베이스로 전송하기 전에 실행됩니다. 여기서는 이 훅으로 알맞은 기본값을 설정합니다. 새로 등록한 온도계는 활성 상태여야 합니다. 그리고 이름이 없으면 시리얼 넘버로 이름을 만듭니다.

```sql
-- What the ORM generates for this entity (PostgreSQL)
CREATE TABLE "devices" (
  "id" SERIAL PRIMARY KEY,
  "serialNumber" VARCHAR(64) NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "location" VARCHAR(200),
  "isActive" BOOLEAN NOT NULL,
  "user_id" INTEGER NOT NULL REFERENCES "users"("id"),
  "createdAt" TIMESTAMP DEFAULT NOW(),
  "updatedAt" TIMESTAMP DEFAULT NOW()
);
CREATE INDEX "idx_devices_serialNumber" ON "devices" ("serialNumber");
```

### TemperatureReading

이 엔티티는 행이 수백만 개까지 늘어날 대용량 엔티티입니다. 그래서 설계 결정이 쿼리 성능에 직접 영향을 줍니다.

```typescript
// src/entities/temperature-reading.entity.ts
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  RelationColumn,
  Index,
  CreateTimestamp,
  BeforeInsert,
} from "@stingerloom/orm";
import { Device } from "./device.entity";

@Entity({ name: "temperature_readings" })
export class TemperatureReading {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Device, (d) => d.readings)
  @RelationColumn({ name: "device_id" })
  device!: Device;

  @Index()
  @Column({ type: "float" })
  temperatureCelsius!: number;

  @Column({ type: "float", nullable: true })
  humidity!: number | null;

  @Column({ type: "float", nullable: true })
  batteryLevel!: number | null;

  @Index()
  @Column({ type: "timestamp" })
  recordedAt!: Date;

  @CreateTimestamp()
  createdAt!: Date;

  @BeforeInsert()
  validateTemperature() {
    if (this.temperatureCelsius < -273.15) {
      throw new Error("Temperature cannot be below absolute zero (-273.15°C)");
    }
    if (this.temperatureCelsius > 1000) {
      throw new Error("Temperature exceeds sensor range (1000°C)");
    }
  }
}
```

```sql
-- What the ORM generates for this entity (PostgreSQL)
CREATE TABLE "temperature_readings" (
  "id" SERIAL PRIMARY KEY,
  "device_id" INTEGER NOT NULL REFERENCES "devices"("id"),
  "temperatureCelsius" FLOAT NOT NULL,
  "humidity" FLOAT,
  "batteryLevel" FLOAT,
  "recordedAt" TIMESTAMP NOT NULL,
  "createdAt" TIMESTAMP DEFAULT NOW()
);
CREATE INDEX "idx_temperature_readings_temperatureCelsius" ON "temperature_readings" ("temperatureCelsius");
CREATE INDEX "idx_temperature_readings_recordedAt" ON "temperature_readings" ("recordedAt");
```

`recordedAt`과 `temperatureCelsius`에 `@Index()`가 붙어 있습니다. 인덱스가 없으면 "최근 7일간 최고 온도 찾기" 같은 쿼리가 테이블의 모든 행을 스캔해야 합니다. 인덱스가 있으면 데이터베이스가 해당 날짜 범위로 바로 이동합니다.

`@BeforeInsert()` 훅은 데이터 품질을 검사하는 관문 역할을 합니다. -500도를 보고하는 센서는 분명히 고장 난 센서입니다. 이런 데이터는 데이터베이스에 도달하기 전에 거부합니다.

### AlertRule

```typescript
// src/entities/alert-rule.entity.ts
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  RelationColumn,
  CreateTimestamp,
} from "@stingerloom/orm";
import { Device } from "./device.entity";

@Entity({ name: "alert_rules" })
export class AlertRule {
  @PrimaryGeneratedColumn()
  id!: number;

  // 단방향 관계: Device에 알림 규칙의 역방향 프로퍼티가 없으므로
  // 필수인 두 번째 인자에 () => undefined를 전달합니다.
  @ManyToOne(() => Device, () => undefined)
  @RelationColumn({ name: "device_id" })
  device!: Device;

  @Column({ type: "varchar", length: 20 })
  condition!: string; // "above" | "below"

  @Column({ type: "float" })
  thresholdCelsius!: number;

  @Column({ type: "boolean" })
  isEnabled!: boolean;

  @CreateTimestamp()
  createdAt!: Date;
}
```

```sql
-- What the ORM generates for this entity (PostgreSQL)
CREATE TABLE "alert_rules" (
  "id" SERIAL PRIMARY KEY,
  "device_id" INTEGER NOT NULL REFERENCES "devices"("id"),
  "condition" VARCHAR(20) NOT NULL,
  "thresholdCelsius" FLOAT NOT NULL,
  "isEnabled" BOOLEAN NOT NULL,
  "createdAt" TIMESTAMP DEFAULT NOW()
);
```

### Alert

```typescript
// src/entities/alert.entity.ts
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  RelationColumn,
  CreateTimestamp,
} from "@stingerloom/orm";
import { AlertRule } from "./alert-rule.entity";
import { TemperatureReading } from "./temperature-reading.entity";

@Entity({ name: "alerts" })
export class Alert {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => AlertRule, () => undefined)
  @RelationColumn({ name: "alert_rule_id" })
  rule!: AlertRule;

  @ManyToOne(() => TemperatureReading, () => undefined)
  @RelationColumn({ name: "reading_id" })
  reading!: TemperatureReading;

  @Column({ type: "float" })
  temperatureCelsius!: number;

  @Column({ type: "boolean" })
  acknowledged!: boolean;

  @CreateTimestamp()
  firedAt!: Date;
}
```

```sql
-- What the ORM generates for this entity (PostgreSQL)
CREATE TABLE "alerts" (
  "id" SERIAL PRIMARY KEY,
  "alert_rule_id" INTEGER NOT NULL REFERENCES "alert_rules"("id"),
  "reading_id" INTEGER NOT NULL REFERENCES "temperature_readings"("id"),
  "temperatureCelsius" FLOAT NOT NULL,
  "acknowledged" BOOLEAN NOT NULL,
  "firedAt" TIMESTAMP DEFAULT NOW()
);
```

### DailyStats

이 엔티티는 월간 은행 명세서와 같습니다. 은행은 개별 거래를 모두 나열하지 않고 총 입금액, 총 출금액, 잔액 같은 요약을 줍니다. 온도 데이터도 같은 방식으로 다룹니다. 누군가 대시보드를 열 때마다 원시 데이터 수백만 건을 쿼리하지 않고 일일 요약을 미리 계산해 둡니다.

```typescript
// src/entities/daily-stats.entity.ts
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  RelationColumn,
  Index,
  UpdateTimestamp,
} from "@stingerloom/orm";
import { Device } from "./device.entity";

@Entity({ name: "daily_stats" })
export class DailyStats {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Device, () => undefined)
  @RelationColumn({ name: "device_id" })
  device!: Device;

  @Index()
  @Column({ type: "date" })
  date!: string;

  @Column({ type: "float" })
  avgTemperature!: number;

  @Column({ type: "float" })
  minTemperature!: number;

  @Column({ type: "float" })
  maxTemperature!: number;

  @Column({ type: "int" })
  readingCount!: number;

  @UpdateTimestamp()
  updatedAt!: Date;
}
```

여기서는 `@UpdateTimestamp()` 데코레이터가 중요합니다. 야간 cron job이 오늘의 데이터를 다시 집계하면 ORM이 이 필드를 자동으로 갱신합니다. 그래서 `updatedAt`이 오래되었다면 cron job이 실행되지 않았다는 뜻입니다.

```sql
-- What the ORM generates for this entity (PostgreSQL)
CREATE TABLE "daily_stats" (
  "id" SERIAL PRIMARY KEY,
  "device_id" INTEGER NOT NULL REFERENCES "devices"("id"),
  "date" DATE NOT NULL,
  "avgTemperature" FLOAT NOT NULL,
  "minTemperature" FLOAT NOT NULL,
  "maxTemperature" FLOAT NOT NULL,
  "readingCount" INTEGER NOT NULL,
  "updatedAt" TIMESTAMP DEFAULT NOW()
);
CREATE INDEX "idx_daily_stats_date" ON "daily_stats" ("date");
```

### 설계 결정 설명

#### `recordedAt`와 `temperatureCelsius`에 `@Index()`를 쓰는 이유

PostgreSQL은 기본적으로 인덱스를 B-tree 구조로 저장합니다. `recordedAt`에 B-tree 인덱스가 있으면 데이터베이스는 범위 쿼리(`BETWEEN`, `>=`, `<`)와 `ORDER BY`를 전체 테이블 스캔 없이 처리합니다. "최근 7일간의 데이터"를 찾을 때 모든 행을 읽지 않습니다. 트리를 따라 시작 지점으로 이동한 뒤 거기서부터 순서대로 읽습니다.

인덱스가 없으면 행이 1,000만 개인 테이블에서 순차 스캔을 해야 합니다. 데이터베이스가 모든 행을 읽고 WHERE 조건을 확인합니다. 이 작업은 몇 초가 걸립니다. B-tree 인덱스가 있으면 같은 쿼리가 밀리초 만에 끝납니다. 데이터베이스가 해당 범위로 바로 건너뛰기 때문입니다.

`temperatureCelsius` 인덱스도 같은 목적으로 씁니다. "35도 이상인 데이터 모두 찾기" 같은 임계값 쿼리를 위한 인덱스입니다. Step 6에서는 `explain()`으로 쿼리 플래너가 이 인덱스들을 실제로 쓰는지 확인합니다.

#### `@BeforeInsert()`를 데이터베이스 CHECK 제약조건 대신 쓰는 이유

두 방법 모두 데이터를 검증합니다. 하지만 동작하는 계층이 다릅니다.

- **ORM 훅** (`@BeforeInsert()`): 애플리케이션 코드에서 실행되므로 SQL이 데이터베이스에 도달하기 전에 동작합니다. "Temperature cannot be below absolute zero" 같은 설명적인 에러 메시지를 만들 수 있습니다. 필드 간 검증이나 외부 API 호출 같은 복잡한 비즈니스 로직도 실행할 수 있습니다. 애플리케이션의 에러 처리 파이프라인과도 연결됩니다.

- **데이터베이스 CHECK 제약조건** (`CHECK (temperature_celsius >= -273.15)`): PostgreSQL 내부에서 실행됩니다. 최후의 방어선입니다. raw SQL 스크립트, 마이그레이션, 같은 데이터베이스에 쓰는 다른 애플리케이션처럼 ORM을 우회하는 데이터도 잡아냅니다.

가장 좋은 방법은 둘 다 쓰는 것입니다. 훅으로는 사용자에게 보여 줄 명확한 에러 메시지를 만들고 CHECK 제약조건으로는 데이터 무결성을 지킵니다. 예제 코드는 ORM 기능인 훅만 씁니다. 하지만 프로덕션에서는 마이그레이션 파일에 CHECK 제약조건도 추가하세요.

#### Users에는 `@DeletedAt()` (soft delete)를 쓰고 Readings에는 안 쓰는 이유

Users에는 감사와 규정 준수 요구사항이 있습니다. GDPR 같은 규정에서는 사용자를 보이지 않게 "삭제"하면서도 데이터를 올바르게 처리했음을 증명하는 기록은 보존해야 하기도 합니다. 소프트 삭제가 이 요구를 해결합니다. 사용자는 모든 쿼리 결과에서 사라지지만 행은 감사용으로 남습니다.

Temperature readings는 원시 센서 데이터입니다. 사람을 나타내지 않습니다. 삭제가 필요하면 보통 하나씩 삭제하지 않고 `DELETE FROM temperature_readings WHERE recordedAt < '2025-01-01'`처럼 날짜 범위로 일괄 삭제합니다. 행이 수천만 개인 테이블에 `deletedAt` 컬럼을 추가하면 저장 공간이 크게 낭비됩니다. 그리고 모든 쿼리에 `WHERE deletedAt IS NULL` 필터가 붙습니다. 데이터가 가장 많은 테이블에 불필요한 비용을 더하는 셈입니다.

#### materialized view 대신 별도의 `DailyStats`를 쓰는 이유

PostgreSQL materialized view(`CREATE MATERIALIZED VIEW`)도 비슷한 목적으로 씁니다. 하지만 실제로 쓰기에는 한계가 있습니다.

1. **이식성.** 모든 PostgreSQL 호스팅 업체가 concurrent refresh나 인덱스 같은 materialized view의 기능을 모두 지원하지는 않습니다. 일반 테이블은 모든 업체와 ORM이 지원하는 모든 데이터베이스에서 똑같이 동작합니다.
2. **버전 관리.** `DailyStats` 엔티티는 코드에 정의되고 마이그레이션으로 추적됩니다. 그래서 스키마 변경도 다른 엔티티처럼 PR과 코드 리뷰를 거칩니다.
3. **관측성.** `@UpdateTimestamp()` 데코레이터가 "마지막 갱신" 지표 역할을 합니다. `updatedAt`이 3일 전이라면 집계 cron job이 고장 났다는 뜻입니다.
4. **세밀한 제어.** 전체 뷰를 새로 고치지 않고 특정 디바이스의 통계만 갱신할 수 있습니다. 반면 materialized view는 전체를 한 번에 새로 고치는 방식뿐입니다.

---

## Step 3: 멀티테넌시 -- 하나의 앱, 여러 빌딩

### 비유

집집마다 우편함이 있는 아파트를 떠올려 보세요. 모든 입주민이 같은 복도와 엘리베이터를 공유합니다. 하지만 우편함은 각자의 것입니다. 내 열쇠로는 내 우편함만 열립니다.

멀티테넌시도 같은 원리입니다. 모든 테넌트가 같은 NestJS 서버와 PostgreSQL 인스턴스를 공유합니다. 하지만 각 테넌트의 데이터는 테넌트마다 따로 둔 PostgreSQL 스키마에 저장됩니다. "building_a" 테넌트에는 `building_a.devices`, `building_a.temperature_readings` 같은 테이블이 있습니다. "building_b" 테넌트에도 같은 구성의 테이블이 따로 있습니다. ORM은 쿼리를 올바른 스키마로 자동으로 보냅니다.

```
PostgreSQL Instance
├── public              ← shared (template tables)
├── building_a          ← Tenant A's isolated data
│   ├── users
│   ├── devices
│   ├── temperature_readings
│   └── ...
├── building_b          ← Tenant B's isolated data
│   ├── users
│   ├── devices
│   ├── temperature_readings
│   └── ...
```

### Tenant Middleware

[멀티테넌시](./multi-tenancy.md) 가이드에서는 HTTP 헤더에서 테넌트를 추출합니다. 하지만 실제 프로덕션 시스템에서는 테넌트 식별 정보를 JWT처럼 신뢰할 수 있는 출처에서 가져와야 합니다. 테넌트가 서명된 토큰에 들어 있으면 사용자가 헤더를 바꿔 테넌트를 위조하지 못합니다.

```typescript
// src/tenant/tenant.middleware.ts
import { Injectable, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { MetadataContext } from "@stingerloom/orm";

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  use(req: Request, _res: Response, next: NextFunction) {
    // In production: extract tenantId from the verified JWT (see Step 4).
    // During development without Keycloak: fall back to header.
    const tenantId =
      (req as any).user?.tenantId ||
      (req.headers["x-tenant-id"] as string) ||
      "public";

    MetadataContext.run(tenantId, () => {
      next();
    });
  }
}
```

핵심은 `MetadataContext.run(tenantId, () => { next() })` 줄입니다. 이 호출은 Node.js `AsyncLocalStorage`로 HTTP 요청의 전체 라이프사이클을 테넌트 컨텍스트로 감쌉니다. 그래서 이후 컨트롤러, 서비스, 리포지토리에서 호출하는 모든 ORM 메서드가 자동으로 올바른 스키마를 대상으로 합니다.

```
HTTP Request (JWT: { tenantId: "building_a" })
    │
    ▼
TenantMiddleware
    │  MetadataContext.run("building_a", () => next())
    ▼
Controller → Service → Repository → EntityManager
    │
    ▼
SQL: SELECT * FROM "building_a"."devices" WHERE ...
```

### AsyncLocalStorage가 격리를 보장하는 방법

Node.js는 싱글 스레드에서 실행됩니다. 하지만 이벤트 루프로 많은 HTTP 요청을 동시에 처리합니다. 컨텍스트를 주의해서 관리하지 않으면 동시에 들어온 두 요청의 테넌트 정보가 서로 섞일 위험이 있습니다. `AsyncLocalStorage`는 비동기 실행 체인마다 격리된 저장 공간을 줘서 이 문제를 해결합니다. 같은 스레드에서 작업이 번갈아 실행되어도 마찬가지입니다.

아래는 두 요청이 동시에 처리되는 타임라인입니다.

```
Timeline (single Node.js thread):
──────────────────────────────────────────────
t1: Request A arrives (tenant: building_a)
    -> MetadataContext.run("building_a", ...)
t2: Request B arrives (tenant: building_b)
    -> MetadataContext.run("building_b", ...)
t3: Request A's DB query executes
    -> AsyncLocalStorage resolves -> "building_a"
    -> SQL: SELECT * FROM "building_a"."devices"
t4: Request B's DB query executes
    -> AsyncLocalStorage resolves -> "building_b"
    -> SQL: SELECT * FROM "building_b"."devices"
──────────────────────────────────────────────
```

Request B는 이미 시작되어 t2에서 자기 컨텍스트를 설정했습니다. 그래도 t3 시점에 Request A의 테넌트는 여전히 `building_a`로 올바르게 해석됩니다. `MetadataContext.run()`을 호출할 때마다 독립적인 실행 컨텍스트가 생성되기 때문입니다. 이 컨텍스트는 `await`, Promise, 콜백으로 이어지는 비동기 호출 체인을 따라가고 동시에 실행 중인 다른 컨텍스트로 새지 않습니다.

`AsyncLocalStorage` 없이 `global.currentTenant = tenantId` 같은 단순한 전역 변수를 쓰면 레이스 컨디션이 생깁니다. Request A의 데이터베이스 쿼리가 실행되기 전에 Request B가 테넌트를 `building_b`로 덮어씁니다. 그러면 Request A가 잘못된 스키마를 쿼리합니다. `AsyncLocalStorage`는 이런 전형적인 동시성 버그를 구조적으로 없앱니다.

### 테넌트 컨텍스트가 없을 때 어떻게 되나요?

시작 스크립트나 모듈 초기화 코드처럼 `MetadataContext.run()` 바깥에서 코드가 실행되면 ORM은 `public` 스키마로 폴백합니다. 이는 의도한 동작입니다. public 스키마에는 `ensureSchema()`가 복제하는 템플릿 테이블이 있기 때문입니다.

```typescript
// Outside any MetadataContext — targets "public" schema
const users = await em.find(User, {});
// SQL: SELECT * FROM "public"."users"

// Inside tenant context — targets tenant schema
MetadataContext.run("building_a", async () => {
  const users = await em.find(User, {});
  // SQL: SELECT * FROM "building_a"."users"
});
```

::: warning
public 스키마에 테넌트별 데이터를 절대 저장하지 마세요. public 스키마는 `ensureSchema()`가 복제할 구조 템플릿으로만 존재합니다. 실수로 public 스키마에 데이터를 쓰면 그 데이터는 어떤 테넌트에도 보이지 않습니다. 테넌트 범위의 삭제 작업으로도 정리되지 않습니다.
:::

### Tenant Schema Service

새 테넌트가 처음 요청할 때는 아직 스키마가 없습니다. `TenantSchemaService`가 스키마를 자동으로 생성합니다.

```typescript
// src/tenant/tenant-schema.service.ts
import { Injectable, Inject } from "@nestjs/common";
import {
  EntityManager,
  PostgresTenantMigrationRunner,
  PostgresDriver,
} from "@stingerloom/orm";

@Injectable()
export class TenantSchemaService {
  private runner: PostgresTenantMigrationRunner | null = null;

  constructor(
    @Inject(EntityManager)
    private readonly em: EntityManager,
  ) {}

  async ensureSchema(tenantId: string): Promise<void> {
    if (!this.runner) {
      const driver = this.em.getDriver() as PostgresDriver;
      this.runner = new PostgresTenantMigrationRunner(driver);
    }
    return this.runner.ensureSchema(tenantId);
  }
}
```

`ensureSchema()`는 먼저 스키마가 있는지 확인합니다. 스키마가 없으면 public 스키마의 테이블 구조를 복제해서 새로 생성합니다. 새 테넌트를 위해 빈 테이블 세트를 찍어 내는 것과 같습니다.

### 스키마 프로비저닝이 포함된 업데이트된 Middleware

```typescript
// src/tenant/tenant.middleware.ts (updated)
import { Injectable, Inject, NestMiddleware } from "@nestjs/common";
import { Request, Response, NextFunction } from "express";
import { MetadataContext } from "@stingerloom/orm";
import { TenantSchemaService } from "./tenant-schema.service";

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  constructor(private readonly tenantSchema: TenantSchemaService) {}

  use(req: Request, _res: Response, next: NextFunction) {
    const tenantId =
      (req as any).user?.tenantId ||
      (req.headers["x-tenant-id"] as string) ||
      "public";

    MetadataContext.run(tenantId, async () => {
      try {
        await this.tenantSchema.ensureSchema(tenantId);
        next();
      } catch (err) {
        next(err);
      }
    });
  }
}
```

### Middleware 등록

```typescript
// src/tenant/tenant.module.ts
import { Module, NestModule, MiddlewareConsumer } from "@nestjs/common";
import { TenantMiddleware } from "./tenant.middleware";
import { TenantSchemaService } from "./tenant-schema.service";

@Module({
  providers: [TenantSchemaService],
  exports: [TenantSchemaService],
})
export class TenantModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TenantMiddleware).forRoutes("*");
  }
}
```

`AppModule`의 imports에 `TenantModule`을 추가하세요.

```typescript
// src/app.module.ts (updated imports)
@Module({
  imports: [
    TenantModule,
    StingerloomOrmModule.forRoot({ /* ... same as Step 1 ... */ }),
    // ...
  ],
})
export class AppModule {}
```

이제 모든 요청이 자동으로 올바른 테넌트 범위에서 실행됩니다. 서비스 코드도 깔끔하게 유지됩니다. `withTenant()` 래퍼도 필요 없고 `tenantId` 파라미터를 곳곳에 넘길 필요도 없습니다.

---

## Step 4: Keycloak JWT 인증

::: tip ORM 경계
이 단계는 ORM과 전혀 관계가 없습니다. 인증은 누가 요청하는지 판별하는 전송 계층의 일입니다. ORM은 어떤 데이터를 쿼리할지만 다룹니다. 그래도 이 단계를 넣은 이유는 JWT에 TenantMiddleware로 전달되는 `tenantId` 클레임이 들어 있기 때문입니다.
:::

### JWT Strategy

```typescript
// src/auth/jwt.strategy.ts
import { Injectable } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { Strategy, ExtractJwt } from "passport-jwt";
import { passportJwtSecret } from "jwks-rsa";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      // Keycloak publishes its public keys at this well-known endpoint.
      // jwks-rsa fetches and caches them automatically.
      secretOrKeyProvider: passportJwtSecret({
        cache: true,
        rateLimit: true,
        jwksUri:
          "http://localhost:8080/realms/smart-thermo/protocol/openid-connect/certs",
      }),
      issuer: "http://localhost:8080/realms/smart-thermo",
      algorithms: ["RS256"],
    });
  }

  validate(payload: any) {
    // This returned object becomes `req.user`
    return {
      sub: payload.sub,
      email: payload.email,
      tenantId: payload.tenantId, // Our custom claim from Keycloak mapper
    };
  }
}
```

### Auth Guard

```typescript
// src/auth/jwt-auth.guard.ts
import { Injectable } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";

@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {}
```

### Auth Module

```typescript
// src/auth/auth.module.ts
import { Module } from "@nestjs/common";
import { PassportModule } from "@nestjs/passport";
import { JwtStrategy } from "./jwt.strategy";

@Module({
  imports: [PassportModule.register({ defaultStrategy: "jwt" })],
  providers: [JwtStrategy],
  exports: [PassportModule],
})
export class AuthModule {}
```

`AppModule`의 imports에 `AuthModule`을 추가하세요. 그리고 보호할 라우트에 guard를 적용하세요.

```typescript
@Controller("devices")
@UseGuards(JwtAuthGuard) // Every route in this controller requires a valid JWT
export class DevicesController {
  // ...
}
```

이 단계에서는 ORM 코드를 전혀 고치지 않았습니다. JWT guard가 토큰을 검증합니다. 그러면 Step 3의 TenantMiddleware가 `req.user.tenantId`를 읽어 ORM 컨텍스트를 설정합니다. 두 시스템은 `req.user`로 값을 주고받습니다. NestJS의 표준 패턴입니다.

---

## Step 5: 온도 데이터 수집

이제 애플리케이션의 핵심인 디바이스 온도 데이터 수신을 구현합니다. ORM이 가장 많은 일을 하는 부분입니다.

### 모듈 설정

```typescript
// src/readings/readings.module.ts
import { Module } from "@nestjs/common";
import { StingerloomOrmModule } from "@stingerloom/orm/nestjs";
import { TemperatureReading } from "../entities/temperature-reading.entity";
import { AlertRule } from "../entities/alert-rule.entity";
import { Alert } from "../entities/alert.entity";
import { ReadingsService } from "./readings.service";
import { ReadingsController } from "./readings.controller";

@Module({
  imports: [
    StingerloomOrmModule.forFeature([TemperatureReading, AlertRule, Alert]),
  ],
  controllers: [ReadingsController],
  providers: [ReadingsService],
})
export class ReadingsModule {}
```

### 단일 데이터 수집 -- save()

온도계 하나가 데이터 하나를 보낼 때는 `save()`를 씁니다.

```typescript
// src/readings/readings.service.ts
import { Injectable } from "@nestjs/common";
import { BaseRepository } from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { TemperatureReading } from "../entities/temperature-reading.entity";

@Injectable()
export class ReadingsService {
  constructor(
    @InjectRepository(TemperatureReading)
    private readonly readingRepo: BaseRepository<TemperatureReading>,
  ) {}

  async ingestOne(deviceId: number, data: {
    temperatureCelsius: number;
    humidity?: number;
    batteryLevel?: number;
    recordedAt: Date;
  }): Promise<TemperatureReading> {
    const reading = new TemperatureReading();
    reading.device = { id: deviceId } as any;
    reading.temperatureCelsius = data.temperatureCelsius;
    reading.humidity = data.humidity ?? null;
    reading.batteryLevel = data.batteryLevel ?? null;
    reading.recordedAt = data.recordedAt;

    return this.readingRepo.save(reading);
  }
}
```

```sql
-- The ORM generates (PostgreSQL, tenant "building_a"):
INSERT INTO "building_a"."temperature_readings"
  ("device_id", "temperatureCelsius", "humidity", "batteryLevel", "recordedAt", "createdAt")
VALUES ($1, $2, $3, $4, $5, NOW())
RETURNING *
-- Parameters: [1, 23.5, 45.2, 0.87, '2026-03-28 10:30:00']
```

이 SQL이 실행되기 전에 `@BeforeInsert()` 훅이 실행됩니다. 온도가 절대영도보다 낮으면 훅이 에러를 던집니다. 그래서 INSERT가 데이터베이스에 도달하지 않습니다.

### 배치 수집 -- insertMany()

디바이스가 데이터를 버퍼에 모았다가 한 번에 100개를 보내기도 합니다. `save()`를 루프에서 호출하면 INSERT 문이 100개 생깁니다. `insertMany()`는 이 INSERT를 SQL 문 하나로 묶습니다.

```typescript
async ingestBatch(deviceId: number, readings: Array<{
  temperatureCelsius: number;
  humidity?: number;
  batteryLevel?: number;
  recordedAt: Date;
}>): Promise<{ affected: number }> {
  return this.readingRepo.insertMany(
    readings.map((r) => ({
      device: { id: deviceId },
      temperatureCelsius: r.temperatureCelsius,
      humidity: r.humidity ?? null,
      batteryLevel: r.batteryLevel ?? null,
      recordedAt: r.recordedAt,
    })),
  );
}
```

```sql
-- One statement for 100 readings:
INSERT INTO "building_a"."temperature_readings"
  ("device_id", "temperatureCelsius", "humidity", "batteryLevel", "recordedAt", "createdAt")
VALUES ($1, $2, $3, $4, $5, NOW()),
       ($6, $7, $8, $9, $10, NOW()),
       ...
       ($496, $497, $498, $499, $500, NOW())
```

왕복이 100번에서 1번으로 줄어듭니다. 실제 벤치마크에서는 10~50배 빠릅니다.

::: warning insertMany()는 라이프사이클 훅을 실행하지 않아요
`@BeforeInsert()`와 `@AfterInsert()` 훅은 `save()`와 `saveMany()`에서만 동작합니다. 배치 항목마다 검증해야 한다면 `insertMany()`를 호출하기 전에 애플리케이션 코드에서 검증하세요. 아니면 `saveMany()`를 쓰세요. `saveMany()`는 더 느리지만 훅이 동작합니다.
:::

### EntitySubscriber로 알림 체크

새 데이터가 들어오면 그 데이터가 해당 디바이스의 알림 규칙을 위반했는지 확인해야 합니다. 이 로직을 `ReadingsService.ingestOne()` 안에 넣어도 됩니다. 하지만 그러면 수집 서비스가 알림 시스템에 묶입니다. 대신 **EntitySubscriber**를 씁니다. EntitySubscriber는 특정 엔티티의 이벤트에 반응하는 별도의 클래스입니다.

```typescript
// src/readings/temperature-alert.subscriber.ts
import {
  EntitySubscriber,
  InsertEvent,
  EntityManager,
} from "@stingerloom/orm";
import { TemperatureReading } from "../entities/temperature-reading.entity";
import { AlertRule } from "../entities/alert-rule.entity";
import { Alert } from "../entities/alert.entity";

export class TemperatureAlertSubscriber
  implements EntitySubscriber<TemperatureReading>
{
  constructor(private readonly em: EntityManager) {}

  listenTo() {
    return TemperatureReading;
  }

  async afterInsert(event: InsertEvent<TemperatureReading>) {
    const reading = event.entity;
    if (!reading.device) return;

    // Find enabled rules for this device
    const rules = await this.em.find(AlertRule, {
      where: {
        device: { id: reading.device.id ?? (reading.device as any) },
        isEnabled: true,
      },
    });

    for (const rule of rules) {
      const violated =
        (rule.condition === "above" &&
          reading.temperatureCelsius > rule.thresholdCelsius) ||
        (rule.condition === "below" &&
          reading.temperatureCelsius < rule.thresholdCelsius);

      if (violated) {
        const alert = new Alert();
        alert.rule = rule;
        alert.reading = reading;
        alert.temperatureCelsius = reading.temperatureCelsius;
        alert.acknowledged = false;
        await this.em.save(Alert, alert);
      }
    }
  }
}
```

모듈을 초기화할 때 구독자를 등록하세요.

```typescript
// src/readings/readings.module.ts (updated)
import { Module, OnModuleInit, Inject } from "@nestjs/common";
import { EntityManager } from "@stingerloom/orm";
import { TemperatureAlertSubscriber } from "./temperature-alert.subscriber";
// ... other imports

@Module({ /* same as before */ })
export class ReadingsModule implements OnModuleInit {
  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
  ) {}

  onModuleInit() {
    this.em.addSubscriber(new TemperatureAlertSubscriber(this.em));
  }
}
```

이제 흐름이 완전히 분리됩니다.

```
save(TemperatureReading)
    │
    ├─► @BeforeInsert: validate temperature range
    │
    ├─► SQL: INSERT INTO "temperature_readings" ...
    │
    └─► afterInsert (TemperatureAlertSubscriber):
            │
            ├─► SELECT * FROM "alert_rules" WHERE device_id = ... AND is_enabled = true
            │
            └─► IF violated → INSERT INTO "alerts" ...
```

### REST Controller

```typescript
// src/readings/readings.controller.ts
import { Controller, Post, Body, Param, ParseIntPipe, UseGuards } from "@nestjs/common";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import { ReadingsService } from "./readings.service";

@Controller("devices/:deviceId/readings")
@UseGuards(JwtAuthGuard)
export class ReadingsController {
  constructor(private readonly readingsService: ReadingsService) {}

  @Post()
  ingestOne(
    @Param("deviceId", ParseIntPipe) deviceId: number,
    @Body() body: { temperatureCelsius: number; humidity?: number; batteryLevel?: number; recordedAt: string },
  ) {
    return this.readingsService.ingestOne(deviceId, {
      ...body,
      recordedAt: new Date(body.recordedAt),
    });
  }

  @Post("batch")
  ingestBatch(
    @Param("deviceId", ParseIntPipe) deviceId: number,
    @Body() body: Array<{ temperatureCelsius: number; humidity?: number; batteryLevel?: number; recordedAt: string }>,
  ) {
    return this.readingsService.ingestBatch(
      deviceId,
      body.map((r) => ({ ...r, recordedAt: new Date(r.recordedAt) })),
    );
  }
}
```

---

## Step 6: 모바일 앱을 위한 데이터 조회

모바일 앱에는 여러 종류의 쿼리가 필요합니다. 하나씩 구현하면서 ORM이 생성하는 SQL을 확인해 보겠습니다.

아래 메서드는 모두 각자의 서비스에 있고 `@InjectRepository`로 리포지토리를 주입받습니다.

```typescript
// src/devices/devices.service.ts
import { Injectable } from "@nestjs/common";
import { BaseRepository } from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { Device } from "../entities/device.entity";
import { TemperatureReading } from "../entities/temperature-reading.entity";

@Injectable()
export class DevicesService {
  constructor(
    @InjectRepository(Device)
    private readonly deviceRepo: BaseRepository<Device>,
    @InjectRepository(TemperatureReading)
    private readonly readingRepo: BaseRepository<TemperatureReading>,
  ) {}

  // methods below...
}
```

::: tip @InjectRepository vs @Inject(EntityManager)
표준 CRUD, 페이지네이션, 집계, upsert에는 `@InjectRepository`를 쓰세요. 사용 사례의 90%가 여기에 해당합니다. `@Inject(EntityManager)`는 인프라 수준 작업에만 쓰세요. raw SQL(`em.query()`), 스트리밍(`em.stream()`), 구독자 등록(`em.addSubscriber()`), 드라이버 접근(`em.getDriver()`)이 그런 작업입니다.
:::

### 디바이스별 최신 데이터

앱을 열면 가장 먼저 각 디바이스의 현재 온도가 보입니다.

```typescript
async getLatestReading(deviceId: number): Promise<TemperatureReading | null> {
  return this.readingRepo.findOne({
    where: { device: { id: deviceId } },
    orderBy: { recordedAt: "DESC" },
  });
}
```

```sql
SELECT * FROM "building_a"."temperature_readings"
WHERE "device_id" = $1
ORDER BY "recordedAt" DESC
LIMIT 1
-- Parameters: [1]
```

### 데이터 이력 -- 커서 페이지네이션을 활용한 무한 스크롤

사용자가 디바이스를 탭해서 이력을 보면 앱은 스크롤 목록을 보여 줍니다. 아래로 스크롤하면 데이터가 더 로드됩니다. 이 방식을 **무한 스크롤**이라고 합니다. 무한 스크롤에 가장 알맞은 페이지네이션 전략은 커서 기반입니다.

offset 페이지네이션을 쓰지 않는 이유가 있습니다. 디바이스에 데이터가 100만 건 있다고 가정해 보세요. `OFFSET 500000`으로 500페이지를 요청하면 PostgreSQL이 행 500,000개를 스캔하고 건너뛰어야 합니다. 커서 페이지네이션은 "이 타임스탬프보다 오래된 데이터를 줘"라고 요청합니다. 데이터베이스는 인덱스로 그 지점에 바로 이동합니다. 그래서 1페이지든 10,000페이지든 똑같이 빠릅니다.

```typescript
async getReadingHistory(deviceId: number, cursor?: string) {
  return this.readingRepo.findWithCursor({
    where: { device: { id: deviceId } },
    take: 50,
    orderBy: "recordedAt",
    direction: "DESC",
    cursor,
  });
}
```

```sql
-- First page (no cursor):
SELECT * FROM "building_a"."temperature_readings"
WHERE "device_id" = $1
ORDER BY "recordedAt" DESC
LIMIT 51
-- Parameters: [1]

-- Subsequent pages (with cursor):
SELECT * FROM "building_a"."temperature_readings"
WHERE "device_id" = $1 AND "recordedAt" < $2
ORDER BY "recordedAt" DESC
LIMIT 51
-- Parameters: [1, '2026-03-28 10:00:00']
```

ORM은 요청한 50개보다 하나 많은 51개 행을 조회해서 다음 페이지가 있는지 판단합니다. 51개가 반환되면 `hasNextPage`가 `true`가 되고 추가 행은 버립니다.

응답 형태는 모바일 클라이언트에 잘 맞습니다.

```json
{
  "data": [ /* 50 TemperatureReading objects */ ],
  "hasNextPage": true,
  "nextCursor": "eyJ2IjoiMjAyNi0wMy0yOFQxMDowMDowMC4wMDBaIn0=",
  "count": 50
}
```

클라이언트는 `nextCursor`를 저장해 두었다가 사용자가 아래 끝까지 스크롤하면 다시 넘깁니다.

### 총 개수와 함께 디바이스 목록 조회

"내 디바이스" 화면은 "47개 중 1-10 표시"처럼 총 개수와 함께 페이지네이션된 목록을 보여 줍니다.

```typescript
async getDevices(page: number, pageSize: number) {
  return this.deviceRepo.findAndCount({
    where: { isActive: true },
    relations: ["user"],
    take: pageSize,
    skip: (page - 1) * pageSize,
    orderBy: { name: "ASC" },
  });
}
```

```sql
-- Two queries run in a single transaction:
SELECT * FROM "building_a"."devices"
WHERE "isActive" = $1
ORDER BY "name" ASC
LIMIT $2 OFFSET $3;

SELECT COUNT(*) AS "result" FROM "building_a"."devices"
WHERE "isActive" = $1;
-- Parameters: [true, 10, 0]
```

`findAndCount()`는 `[Device[], number]`를 반환합니다. 데이터와 총 개수를 한 번의 호출로 받습니다.

### 날짜 범위 필터

"3월 1-7일 사이에 온도가 30도 이상인 데이터를 모두 보여 줘"라는 요청을 처리해 보겠습니다.

```typescript
async filterReadings(deviceId: number, from: Date, to: Date, minTemp: number) {
  return this.readingRepo.find({
    where: {
      device: { id: deviceId },
      recordedAt: { between: [from, to] },
      temperatureCelsius: { gte: minTemp },
    },
    orderBy: { recordedAt: "ASC" },
  });
}
```

```sql
SELECT * FROM "building_a"."temperature_readings"
WHERE "device_id" = $1
  AND "recordedAt" BETWEEN $2 AND $3
  AND "temperatureCelsius" >= $4
ORDER BY "recordedAt" ASC
-- Parameters: [1, '2026-03-01', '2026-03-07', 30]
```

`between`과 `gte` 연산자는 SQL `BETWEEN`과 `>=`로 바로 변환됩니다. 문자열을 이어 붙이지 않으므로 SQL 인젝션 위험도 없습니다. 모든 값은 파라미터로 바인딩됩니다.

### EXPLAIN으로 느린 쿼리 진단

쿼리가 예상보다 느리면 `explain()`으로 데이터베이스의 실행 계획을 확인하세요. 실행 계획에는 어떤 인덱스를 쓰는지, 행을 몇 개 스캔하는지, 병목이 어디인지가 나옵니다.

```typescript
async diagnoseSlowQuery(deviceId: number) {
  const plan = await this.readingRepo.explain({
    where: {
      device: { id: deviceId },
      recordedAt: { gte: new Date('2026-01-01') },
    },
    orderBy: { recordedAt: "DESC" },
  });

  console.log(plan);
  // ExplainResult:
  // {
  //   plan: "Index Scan using idx_temperature_readings_recordedAt on temperature_readings",
  //   cost: { startup: 0.43, total: 12.56 },
  //   rows: 2880,
  //   width: 64,
  //   rawPlan: [ ... ]
  // }
}
```

가장 먼저 볼 것은 스캔 방식입니다. **Seq Scan**은 전체 테이블 스캔입니다. 조건에 맞는 행을 찾으려고 테이블의 모든 행을 읽는다는 뜻입니다. 행이 수백만 개인 테이블에서는 느립니다. **Index Scan**이나 **Index Only Scan**은 데이터베이스가 B-tree 인덱스를 써서 필요한 행으로 바로 이동한다는 뜻입니다.

Index Scan을 예상했는데 Seq Scan이 보이면 아래 항목을 확인하세요.
1. 해당 컬럼에 `@Index()` 데코레이터가 있는지
2. `synchronize`나 마이그레이션을 실행해서 인덱스를 실제로 생성했는지
3. 테이블이 작아서 PostgreSQL이 순차 스캔이 더 빠르다고 판단한 것은 아닌지. 쿼리 플래너는 똑똑합니다. 행이 약 1,000개보다 적은 테이블에서는 순차 스캔이 인덱스 조회보다 빠르기도 합니다.

### QueryTracker로 N+1 쿼리 감지

N+1은 ORM에서 가장 흔한 성능 문제입니다. 엔티티 목록을 로드한 뒤 루프를 돌며 관련 엔티티마다 쿼리를 따로 실행할 때 생깁니다.

```typescript
// BAD: N+1 — one query for devices, then one query per device for readings
const devices = await this.deviceRepo.find({ where: { isActive: true } });
for (const device of devices) {
  // This triggers a separate SELECT for each device!
  const latest = await this.readingRepo.findOne({
    where: { device: { id: device.id } },
    orderBy: { recordedAt: "DESC" },
  });
}
// With 100 devices -> 101 queries (1 for devices + 100 for readings)
```

Stingerloom ORM의 `QueryTracker`가 이 패턴을 감지합니다. 보통 개발 환경이나 스테이징 환경에서 ORM 설정의 `logging` 옵션으로 켭니다.

```typescript
StingerloomOrmModule.forRoot({
  // ...Step 1의 연결 옵션
  logging: { nPlusOne: true, slowQueryMs: 500 },
}),
```

같은 엔티티를 100ms 안에 10번 이상 조회하면 tracker가 경고를 로그로 남깁니다.

```
[QueryTracker] [N+1 WARNING] Entity "TemperatureReading" queried 10+ times in 100ms. Consider using eager loading or relations option.
```

해결법은 `relations`로 관계를 즉시 로딩하거나 쿼리 하나로 다시 구성하는 것입니다.

```typescript
// GOOD: single query with join
const devices = await this.deviceRepo.find({
  where: { isActive: true },
  relations: ["readings"],
});
```

`relations: ["readings"]`를 쓰면 ORM이 `LEFT JOIN` 쿼리 하나를 생성합니다. 이 쿼리는 모든 디바이스와 각 디바이스의 데이터를 한 번의 왕복으로 조회합니다. 디바이스가 100개라면 쿼리 101개 대신 1개로 처리됩니다.

---

## Step 7: 집계 -- 일일 통계

### 실시간 집계의 문제점

모바일 앱에 "이번 주 평균 온도"와 "최근 24시간 최고 기록"을 보여 주는 대시보드가 있다고 가정해 보세요. 요청할 때마다 원시 데이터에서 계산하는 방법이 먼저 떠오릅니다.

```typescript
const [avg, max] = await Promise.all([
  this.readingRepo.avg("temperatureCelsius", {
    device: { id: deviceId },
    recordedAt: { gte: sevenDaysAgo },
  }),
  this.readingRepo.max("temperatureCelsius", {
    device: { id: deviceId },
    recordedAt: { gte: oneDayAgo },
  }),
]);
```

```sql
SELECT AVG("temperatureCelsius") AS "result"
FROM "building_a"."temperature_readings"
WHERE "device_id" = $1 AND "recordedAt" >= $2;

SELECT MAX("temperatureCelsius") AS "result"
FROM "building_a"."temperature_readings"
WHERE "device_id" = $1 AND "recordedAt" >= $2;
```

데이터가 10,000건이면 잘 동작합니다. 하지만 1,000만 건이라면 쿼리마다 거대한 범위를 스캔합니다. 사용자 100명이 동시에 대시보드를 열면 데이터베이스가 집계 스캔 200개를 동시에 실행합니다.

### 사전 집계: 월간 은행 명세서 접근법

요청마다 원시 데이터를 스캔하지 않고 일일 요약을 미리 계산합니다. 은행이 개별 거래로 월간 명세서를 만들듯이 디바이스마다 날짜별 `DailyStats` 행을 생성합니다.

```typescript
// src/stats/stats.service.ts
import { Injectable, Inject } from "@nestjs/common";
import { BaseRepository, EntityManager } from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { DailyStats } from "../entities/daily-stats.entity";
import { TemperatureReading } from "../entities/temperature-reading.entity";
import sql from "sql-template-tag";

@Injectable()
export class StatsService {
  constructor(
    @InjectRepository(TemperatureReading)
    private readonly readingRepo: BaseRepository<TemperatureReading>,
    @InjectRepository(DailyStats)
    private readonly statsRepo: BaseRepository<DailyStats>,
    @Inject(EntityManager) private readonly em: EntityManager, // for raw SQL only
  ) {}

  async aggregateDay(deviceId: number, date: string): Promise<void> {
    // Use repository aggregates to compute the summary
    const where = {
      device: { id: deviceId },
      recordedAt: {
        between: [new Date(`${date}T00:00:00`), new Date(`${date}T23:59:59`)],
      },
    };

    const [avg, min, max, count] = await Promise.all([
      this.readingRepo.avg("temperatureCelsius", where),
      this.readingRepo.min("temperatureCelsius", where),
      this.readingRepo.max("temperatureCelsius", where),
      this.readingRepo.count(where),
    ]);

    if (count === 0) return; // No readings for this day

    // Upsert: create if new, update if already aggregated
    await this.statsRepo.upsert({
      device: { id: deviceId },
      date,
      avgTemperature: avg,
      minTemperature: min,
      maxTemperature: max,
      readingCount: count,
    });
  }
}
```

```sql
-- Four aggregate queries run concurrently:
SELECT AVG("temperatureCelsius") AS "result" FROM "building_a"."temperature_readings"
  WHERE "device_id" = $1 AND "recordedAt" BETWEEN $2 AND $3;
SELECT MIN("temperatureCelsius") AS "result" FROM "building_a"."temperature_readings"
  WHERE "device_id" = $1 AND "recordedAt" BETWEEN $2 AND $3;
SELECT MAX("temperatureCelsius") AS "result" FROM "building_a"."temperature_readings"
  WHERE "device_id" = $1 AND "recordedAt" BETWEEN $2 AND $3;
SELECT COUNT(*) AS "result" FROM "building_a"."temperature_readings"
  WHERE "device_id" = $1 AND "recordedAt" BETWEEN $2 AND $3;

-- Then an atomic upsert:
INSERT INTO "building_a"."daily_stats"
  ("device_id", "date", "avgTemperature", "minTemperature", "maxTemperature", "readingCount", "updatedAt")
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT ("id") DO UPDATE SET
  "avgTemperature" = EXCLUDED."avgTemperature",
  "minTemperature" = EXCLUDED."minTemperature",
  "maxTemperature" = EXCLUDED."maxTemperature",
  "readingCount" = EXCLUDED."readingCount",
  "updatedAt" = EXCLUDED."updatedAt"
```

핵심은 `upsert()`입니다. cron job이 같은 날에 두 번 실행되어도 중복 행을 만들지 않고 기존 행을 덮어씁니다. 그래서 이 작업은 처음부터 멱등성(idempotency)을 가집니다.

### 복잡한 집계를 위한 Raw SQL

ORM의 내장 집계 함수로는 부족할 때도 있습니다. 예를 들어 "최근 24시간 동안 시간별 평균 온도"에는 `GROUP BY`와 `date_trunc()`가 필요합니다. 이 쿼리는 ORM의 finder API로 표현하지 못합니다.

이럴 때 `em.query()`를 씁니다.

```typescript
async getHourlyBreakdown(deviceId: number): Promise<Array<{
  hour: string;
  avgTemp: number;
  readingCount: number;
}>> {
  return this.em.query<{ hour: string; avgTemp: number; readingCount: number }>(
    sql`
      SELECT
        date_trunc('hour', "recordedAt") AS "hour",
        AVG("temperatureCelsius")::float AS "avgTemp",
        COUNT(*)::int AS "readingCount"
      FROM "temperature_readings"
      WHERE "device_id" = ${deviceId}
        AND "recordedAt" >= NOW() - INTERVAL '24 hours'
      GROUP BY date_trunc('hour', "recordedAt")
      ORDER BY "hour" ASC
    `,
  );
}
```

::: tip ORM 집계 vs raw SQL 사용 시점

| 필요한 것 | 사용할 것 | 이유 |
|-----------|----------|------|
| 단일 집계 (count, avg, max) | `repo.count()`, `repo.avg()`, `repo.max()` | 더 간단하고 타입이 안전하며 다이얼렉트 사이에서 이식됩니다 |
| GROUP BY, window functions, CTEs | `em.query()` + `sql-template-tag` | ORM finder는 표현식을 쓰는 GROUP BY를 지원하지 않습니다 |
| 애플리케이션 측 집계 | `em.stream()` + loop | ML 스코어링이나 커스텀 알고리즘처럼 데이터베이스가 표현하지 못하는 로직에 씁니다 |

세 경우 모두 ORM이 연결 관리, 파라미터 바인딩, 테넌트 컨텍스트를 처리합니다. 차이는 SQL을 얼마나 직접 작성하느냐입니다.
:::

### 대시보드 엔드포인트

이제 모바일 앱은 원시 데이터 대신 미리 계산한 통계를 쿼리합니다.

```typescript
async getWeeklySummary(deviceId: number) {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const dateStr = sevenDaysAgo.toISOString().split("T")[0];

  return this.statsRepo.find({
    where: {
      device: { id: deviceId },
      date: { gte: dateStr },
    },
    orderBy: { date: "ASC" },
  });
}
```

```sql
SELECT * FROM "building_a"."daily_stats"
WHERE "device_id" = $1 AND "date" >= $2
ORDER BY "date" ASC
-- Parameters: [1, '2026-03-21']
```

이 쿼리는 원시 데이터가 아무리 많아도 최대 7개 행만 스캔합니다.

---

## Step 8: 배치 처리를 위한 스트리밍

### 문제

매일 새벽 2시에 모든 디바이스의 어제 데이터를 집계해야 합니다. 디바이스가 10,000개인 테넌트도 있습니다. 디바이스 하나는 30초마다 데이터를 하나씩 만들어 하루에 약 2,880개를 생성합니다. 그러면 처리할 행이 2,880만 개입니다.

행 2,880만 개를 메모리에 로드하면 Node.js 프로세스가 죽습니다. `em.stream()`은 행을 작은 배치로 나눠 조회해서 이 문제를 해결합니다.

```typescript
// src/stats/aggregation.processor.ts
import { Inject, Injectable } from "@nestjs/common";
import { BaseRepository, EntityManager } from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { Device } from "../entities/device.entity";
import { StatsService } from "./stats.service";

@Injectable()
export class AggregationProcessor {
  constructor(
    @InjectRepository(Device)
    private readonly deviceRepo: BaseRepository<Device>,
    @Inject(EntityManager) private readonly em: EntityManager, // stream() requires EntityManager
    private readonly statsService: StatsService,
  ) {}

  async aggregateYesterday(): Promise<void> {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().split("T")[0];

    const totalDevices = await this.deviceRepo.count({ isActive: true });
    console.log(`Aggregating ${dateStr} for ${totalDevices} devices...`);

    let processed = 0;

    // stream() is an EntityManager-level operation — it handles
    // memory-efficient batched iteration over millions of rows.
    for await (const device of this.em.stream(
      Device,
      { where: { isActive: true } },
      500, // process 500 devices per batch
    )) {
      await this.statsService.aggregateDay(device.id, dateStr);

      processed++;
      if (processed % 100 === 0) {
        console.log(`Progress: ${processed}/${totalDevices}`);
      }
    }

    console.log(`Done. Aggregated ${processed} devices.`);
  }
}
```

```sql
-- The ORM fetches devices in batches of 500:
-- Batch 1:
SELECT * FROM "building_a"."devices" WHERE "isActive" = $1 LIMIT 500 OFFSET 0
-- Batch 2:
SELECT * FROM "building_a"."devices" WHERE "isActive" = $1 LIMIT 500 OFFSET 500
-- Batch 3:
SELECT * FROM "building_a"."devices" WHERE "isActive" = $1 LIMIT 500 OFFSET 1000
-- ...continues until a batch returns fewer than 500 rows
```

어느 시점이든 메모리에는 디바이스 객체가 500개만 있습니다. 각 객체는 처리된 뒤 다음 배치가 도착하면 가비지 컬렉션됩니다.

### BullMQ로 트리거

::: tip ORM 경계
BullMQ는 ORM과 관계없는 잡 큐 라이브러리입니다. 여기서는 새벽 2시에 집계를 시작하는 데만 씁니다. 실제 데이터 처리는 `em.stream()`과 `em.avg()`/`em.min()`/`em.max()`가 맡습니다.
:::

```typescript
// src/stats/aggregation.queue.ts
import { Processor, WorkerHost } from "@nestjs/bullmq";
import { Job } from "bullmq";
import { MetadataContext } from "@stingerloom/orm";
import { AggregationProcessor } from "./aggregation.processor";

@Processor("aggregation")
export class AggregationWorker extends WorkerHost {
  constructor(private readonly processor: AggregationProcessor) {
    super();
  }

  async process(job: Job<{ tenantId: string }>): Promise<void> {
    const { tenantId } = job.data;

    // BullMQ runs outside the HTTP request lifecycle,
    // so there's no TenantMiddleware. We set the context manually.
    await MetadataContext.run(tenantId, async () => {
      await this.processor.aggregateYesterday();
    });
  }
}
```

```typescript
// src/stats/stats.module.ts (registration)
import { Module } from "@nestjs/common";
import { BullModule } from "@nestjs/bullmq";
import { StatsService } from "./stats.service";
import { AggregationProcessor } from "./aggregation.processor";
import { AggregationWorker } from "./aggregation.queue";

@Module({
  imports: [
    BullModule.registerQueue({ name: "aggregation" }),
  ],
  providers: [StatsService, AggregationProcessor, AggregationWorker],
  exports: [StatsService],
})
export class StatsModule {}
```

worker 안에서 `MetadataContext.run(tenantId, ...)`을 호출하는 것이 중요합니다. BullMQ 잡은 HTTP 요청 라이프사이클 바깥에서 실행되므로 TenantMiddleware가 컨텍스트를 설정하지 않습니다. 그래서 직접 설정해야 합니다. ORM의 AsyncLocalStorage 컨텍스트는 HTTP 요청이든 백그라운드 잡이든 똑같이 동작합니다.

---

## Step 9: Redis 캐싱

::: warning ORM 경계
Redis 캐싱은 ORM이 맡는 일이 아닙니다. ORM의 책임은 PostgreSQL에서 끝납니다. 여기서는 ORM의 EntitySubscriber 패턴으로 두 시스템을 연결합니다. 원본 데이터가 바뀌면 캐시를 무효화하는 방식입니다.
:::

### 패턴: Redis 먼저, ORM 폴백

```
Mobile App requests GET /devices/1/stats/weekly
    │
    ├─► Check Redis: GET "stats:building_a:device:1:weekly"
    │     │
    │     ├─► Cache HIT → return immediately (no database query)
    │     │
    │     └─► Cache MISS ↓
    │
    ├─► Query ORM: em.find(DailyStats, { ... })
    │
    ├─► Store in Redis: SET "stats:building_a:device:1:weekly" (TTL: 1 hour)
    │
    └─► Return to client
```

```typescript
// src/stats/cached-stats.service.ts
import { Injectable } from "@nestjs/common";
import { InjectRedis } from "@nestjs-modules/ioredis";
import { BaseRepository, MetadataContext } from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { DailyStats } from "../entities/daily-stats.entity";
import Redis from "ioredis";

@Injectable()
export class CachedStatsService {
  constructor(
    @InjectRepository(DailyStats)
    private readonly statsRepo: BaseRepository<DailyStats>,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  async getWeeklySummary(deviceId: number): Promise<DailyStats[]> {
    const tenant = MetadataContext.getCurrentTenant();
    const cacheKey = `stats:${tenant}:device:${deviceId}:weekly`;

    // 1. Check cache
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    // 2. Cache miss — query the ORM via repository
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const stats = await this.statsRepo.find({
      where: {
        device: { id: deviceId },
        date: { gte: sevenDaysAgo.toISOString().split("T")[0] },
      },
      orderBy: { date: "ASC" },
    });

    // 3. Store in cache (TTL: 1 hour)
    await this.redis.set(cacheKey, JSON.stringify(stats), "EX", 3600);

    return stats;
  }
}
```

코드 어디에도 `new Redis()`가 없습니다. `@InjectRedis()` 데코레이터가 Step 1에서 등록한 `RedisModule`에서 연결을 가져오기 때문입니다. 그래서 모든 Redis 연결은 NestJS의 라이프사이클이 관리합니다. 종료할 때 연결이 제대로 정리되고 설정도 공유됩니다. DI 덕분에 테스트하기도 쉽습니다.

### EntitySubscriber로 캐시 무효화

야간 집계 cron이 새 일일 통계를 계산하면 캐시된 데이터는 더 이상 최신이 아닙니다. `EntitySubscriber`로 관련 캐시 키를 자동으로 무효화합니다.

```typescript
// src/stats/daily-stats-cache.subscriber.ts
import { EntitySubscriber, InsertEvent, UpdateEvent, MetadataContext } from "@stingerloom/orm";
import { DailyStats } from "../entities/daily-stats.entity";
import Redis from "ioredis";

export class DailyStatsCacheSubscriber implements EntitySubscriber<DailyStats> {
  constructor(private readonly redis: Redis) {}

  listenTo() {
    return DailyStats;
  }

  async afterInsert(event: InsertEvent<DailyStats>) {
    await this.invalidate(event.entity);
  }

  async afterUpdate(event: UpdateEvent<DailyStats>) {
    await this.invalidate(event.entity);
  }

  private async invalidate(stats: DailyStats) {
    const tenant = MetadataContext.getCurrentTenant();
    const deviceId = (stats.device as any)?.id ?? (stats as any).device_id;
    if (deviceId) {
      await this.redis.del(`stats:${tenant}:device:${deviceId}:weekly`);
    }
  }
}
```

구독자는 생성자로 Redis 인스턴스를 받습니다. 구독자를 등록할 때 DI가 관리하는 Redis를 넘깁니다.

```typescript
// src/stats/stats.module.ts (subscriber registration)
@Module({ /* ... */ })
export class StatsModule implements OnModuleInit {
  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @InjectRedis() private readonly redis: Redis,
  ) {}

  onModuleInit() {
    this.em.addSubscriber(new DailyStatsCacheSubscriber(this.redis));
  }
}
```

이 패턴에서는 집계 서비스(`StatsService`)가 Redis에 의존하지 않습니다. 캐시 서비스도 집계 스케줄에 의존하지 않습니다. 둘을 잇는 것은 구독자입니다. ORM이 `DailyStats` 행을 쓰면 구독자가 반응해서 오래된 캐시를 삭제합니다. 그래서 두 시스템이 완전히 분리됩니다.

---

## Step 10: 트랜잭션을 활용한 알림 처리

### 시나리오

온도 데이터가 알림 규칙을 위반하면 아래 작업을 해야 합니다.
1. `Alert` 행 생성
2. (선택) 중복 알림을 막기 위해 해당 데이터를 "alerted"로 표시

이 두 작업은 함께 성공하거나 함께 실패해야 합니다. 알림은 생성됐는데 데이터 갱신이 실패하면 유령 알림이 생깁니다. 데이터는 갱신됐는데 알림 생성이 실패하면 알림이 모르는 사이에 사라집니다. 트랜잭션은 바로 이런 경우에 씁니다.

### @Transactional() 사용

```typescript
// src/alerts/alerts.service.ts
import { Injectable } from "@nestjs/common";
import { BaseRepository, Transactional } from "@stingerloom/orm";
import { InjectRepository } from "@stingerloom/orm/nestjs";
import { Alert } from "../entities/alert.entity";
import { AlertRule } from "../entities/alert-rule.entity";
import { TemperatureReading } from "../entities/temperature-reading.entity";

@Injectable()
export class AlertsService {
  constructor(
    @InjectRepository(Alert)
    private readonly alertRepo: BaseRepository<Alert>,
  ) {}

  @Transactional()
  async fireAlert(
    rule: AlertRule,
    reading: TemperatureReading,
  ): Promise<Alert> {
    // Both operations share the same transaction.
    // If either fails, both are rolled back.

    const alert = new Alert();
    alert.rule = rule;
    alert.reading = reading;
    alert.temperatureCelsius = reading.temperatureCelsius;
    alert.acknowledged = false;

    return this.alertRepo.save(alert);
  }
}
```

```sql
-- The ORM wraps both operations in a single transaction:
BEGIN;

INSERT INTO "building_a"."alerts"
  ("alert_rule_id", "reading_id", "temperatureCelsius", "acknowledged", "firedAt")
VALUES ($1, $2, $3, $4, NOW())
RETURNING *;

COMMIT;
-- If any step throws → ROLLBACK instead of COMMIT
```

### 대안: em.transaction() 콜백

트랜잭션 경계를 명시적으로 제어하려면 `em.transaction()` 콜백을 씁니다.

```typescript
async fireAlertExplicit(rule: AlertRule, reading: TemperatureReading): Promise<Alert> {
  return this.em.transaction(async (txEm) => {
    const alert = new Alert();
    alert.rule = rule;
    alert.reading = reading;
    alert.temperatureCelsius = reading.temperatureCelsius;
    alert.acknowledged = false;

    return txEm.save(Alert, alert);
    // COMMIT on successful return
    // ROLLBACK on throw
  });
}
```

두 방법은 같은 SQL을 생성합니다. 단순한 경우에는 `@Transactional()`이 더 깔끔합니다. 조건에 따라 작업을 넣거나 빼야 한다면 명시적으로 제어하는 `em.transaction()`이 알맞습니다.

### 모바일 앱을 위한 알림 조회

```typescript
async getUnacknowledgedAlerts(deviceId: number) {
  return this.alertRepo.find({
    where: {
      rule: { device: { id: deviceId } },
      acknowledged: false,
    },
    relations: ["rule"],
    orderBy: { firedAt: "DESC" },
    take: 50,
  });
}
```

```sql
SELECT "alert".*, "rule".*
FROM "building_a"."alerts" "alert"
LEFT JOIN "building_a"."alert_rules" "rule" ON "alert"."alert_rule_id" = "rule"."id"
WHERE "rule"."device_id" = $1 AND "alert"."acknowledged" = $2
ORDER BY "alert"."firedAt" DESC
LIMIT 50
-- Parameters: [1, false]
```

---

## Step 11: 테스트

### 서비스 유닛 테스트

리포지토리는 `@InjectRepository`로 주입되므로 테스트에서 mock으로 바꿔도 됩니다. 그러면 실행 중인 데이터베이스나 Docker 없이 비즈니스 로직만 떼어 내어 밀리초 만에 테스트합니다.

```typescript
// src/readings/readings.service.spec.ts
import { Test, TestingModule } from "@nestjs/testing";
import { ReadingsService } from "./readings.service";
import { makeInjectRepositoryToken } from "@stingerloom/orm/nestjs";
import { TemperatureReading } from "../entities/temperature-reading.entity";

describe("ReadingsService", () => {
  let service: ReadingsService;
  const mockRepo = {
    save: jest.fn(),
    find: jest.fn(),
    findOne: jest.fn(),
    insertMany: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReadingsService,
        {
          provide: makeInjectRepositoryToken(TemperatureReading),
          useValue: mockRepo,
        },
      ],
    }).compile();

    service = module.get(ReadingsService);
  });

  it("should save a single reading", async () => {
    const mockReading = { id: 1, temperatureCelsius: 23.5 };
    mockRepo.save.mockResolvedValue(mockReading);

    const result = await service.ingestOne(1, {
      temperatureCelsius: 23.5,
      recordedAt: new Date(),
    });

    expect(result).toEqual(mockReading);
    expect(mockRepo.save).toHaveBeenCalledTimes(1);
  });

  it("should reject temperatures below absolute zero", async () => {
    // The @BeforeInsert hook runs inside the ORM, so for unit tests
    // we test the entity method directly
    const reading = new TemperatureReading();
    reading.temperatureCelsius = -300;

    expect(() => reading.validateTemperature()).toThrow(
      "Temperature cannot be below absolute zero"
    );
  });
});
```

### 실제 데이터베이스를 사용한 통합 테스트

트랜잭션, 제약조건, 테넌트 격리처럼 실제 데이터베이스 동작이 필요한 테스트에는 ORM의 테스트 유틸리티를 쓰세요.

```typescript
// test/integration/multi-tenant.spec.ts
import { EntityManager, MetadataContext } from "@stingerloom/orm";
import { Device } from "../../src/entities/device.entity";

describe("Multi-Tenant Isolation", () => {
  let em: EntityManager;

  beforeAll(async () => {
    // Connect to a test database
    em = new EntityManager();
    await em.register({
      type: "postgres",
      host: "localhost",
      port: 5432,
      database: "smart_thermo_test",
      username: "postgres",
      password: "postgres",
      entities: [Device],
      synchronize: true,
    });
  });

  afterAll(async () => {
    await em.propagateShutdown();
  });

  it("tenant A cannot see tenant B data", async () => {
    // Insert device in tenant A
    await MetadataContext.run("tenant_a", async () => {
      await em.save(Device, {
        serialNumber: "SENSOR-A-001",
        name: "Lobby Sensor",
        isActive: true,
      });
    });

    // Query from tenant B — should see nothing
    await MetadataContext.run("tenant_b", async () => {
      const devices = await em.find(Device, {});
      expect(devices).toHaveLength(0);
    });

    // Query from tenant A — should see the device
    await MetadataContext.run("tenant_a", async () => {
      const devices = await em.find(Device, {});
      expect(devices).toHaveLength(1);
      expect(devices[0].serialNumber).toBe("SENSOR-A-001");
    });
  });
});
```

::: tip
테스트에는 항상 별도의 데이터베이스를 쓰세요. `synchronize: true` 옵션은 테이블을 자동으로 생성합니다. 그리고 컬럼을 변경하고 엔티티에서 빠진 컬럼은 삭제합니다. 그러니 테스트를 프로덕션 데이터베이스에 연결하지 마세요.
:::

---

## 완성된 시스템

한 발 물러서서 전체 시스템을 살펴보겠습니다.

| 컴포넌트 | 하는 일 | ORM 관여 여부 |
|----------|---------|--------------|
| Docker Compose | PostgreSQL + Redis + Keycloak 인프라 | 아니요 |
| 6개 엔티티 | 관계, 인덱스, 훅이 포함된 데이터 모델 | 예: 데코레이터 |
| Tenant Middleware | JWT 클레임 기반 스키마별 테넌트 라우팅 | 예: MetadataContext |
| Keycloak JWT 인증 | 토큰 검증, 사용자 식별 | 아니요 |
| 단일 + 배치 수집 | 온도 데이터의 save()와 insertMany() | 예: EntityManager |
| Alert Subscriber | 새 데이터의 알림 조건을 분리해서 확인 | 예: EntitySubscriber |
| 커서 페이지네이션 | 모바일 데이터 이력의 무한 스크롤 | 예: findWithCursor() |
| 집계 | avg/min/max/count와 upsert로 만드는 일일 통계 | 예: 집계 함수 |
| 스트리밍 | 메모리 오버플로 없이 수백만 행 처리 | 예: stream() |
| Redis 캐싱 | 캐시 무효화가 포함된 빠른 대시보드 데이터 | EntitySubscriber로 연결 |
| 트랜잭션 | 원자적 알림 생성 | 예: @Transactional() |
| BullMQ Cron | 야간 집계 트리거 | 아니요 (ORM 코드를 호출) |

ORM은 TypeScript 객체와 PostgreSQL 사이의 모든 일을 처리합니다. Redis, BullMQ, Keycloak은 외부 시스템입니다. ORM은 명확한 경계에서 이 시스템들과 연결됩니다. 캐시 무효화에는 EntitySubscriber를 쓰고 백그라운드 잡에는 MetadataContext.run()을 씁니다.

### 프로덕션 체크리스트

프로덕션에 배포하기 전에 아래 항목을 확인하세요.

| 항목 | 상태 | 비고 |
|------|------|------|
| 프로덕션 설정에서 `synchronize: false` | 필수 | synchronize는 컬럼을 삭제하기도 하므로 마이그레이션 사용 |
| 연결 풀링 설정 | 필수 | ORM 설정에서 `pool: { min: 2, max: 10 }` 설정 |
| 쿼리 타임아웃 설정 | 권장 | `timeout: 30000` (30초)으로 폭주 쿼리 방지 |
| 스테이징에서 N+1 감지 활성화 | 권장 | ORM 설정의 `logging: { nPlusOne: true }` |
| Redis 연결 에러 처리 | 필수 | ioredis는 자동으로 다시 연결하지만 실패는 로그로 남기세요 |
| 테넌트 스키마 마이그레이션 전략 | 필수 | 배포 시 `TenantMigrationRunner.syncTenantSchemas()` 실행 |
| JWT 공개 키 로테이션 | 중요 | jwks-rsa가 키를 캐시합니다. `cache: true, rateLimit: true` 설정 |
| 데이터베이스 백업 스케줄 | 필수 | 테넌트별 백업을 위해 `--schema` 플래그와 함께 pg_dump |
| 그레이스풀 셧다운 | 필수 | NestJS `onModuleDestroy()`에서 `em.propagateShutdown()` 호출 |

### 그레이스풀 셧다운

```typescript
// src/app.module.ts
import { Module, OnModuleDestroy, Inject } from "@nestjs/common";
import { EntityManager } from "@stingerloom/orm";

@Module({ /* ... */ })
export class AppModule implements OnModuleDestroy {
  constructor(@Inject(EntityManager) private readonly em: EntityManager) {}

  async onModuleDestroy() {
    await this.em.propagateShutdown();
    console.log("ORM connections closed gracefully.");
  }
}
```

`propagateShutdown()`은 모든 데이터베이스 연결을 닫습니다. 그리고 이벤트 리스너와 구독자를 정리하고 query tracker 리소스를 해제합니다. 이 호출이 없으면 PostgreSQL 연결이 남아서 프로세스가 종료되지 않고 멈추기도 합니다. Docker나 Kubernetes 같은 컨테이너 환경에서는 남은 연결 때문에 컨테이너가 정상적으로 종료되지 않습니다. 그러면 강제 종료로 이어지고 진행 중인 트랜잭션의 데이터를 잃을 위험이 있습니다.

## 다음 단계

- [Entities & Columns](./entities.md): 모든 데코레이터 옵션 상세 설명
- [Multi-Tenancy](./multi-tenancy.md): 스키마 전략, OverlayFS 메타데이터, 동시성 안전
- [Querying & Pagination](./entity-manager-querying.md): 모든 WHERE 연산자, 스트리밍, 집계
- [Writes & Transactions](./entity-manager-writes.md): 배치 연산, upsert, 데드락 재시도
- [Events & Subscribers](./events.md): 라이프사이클 훅, 글로벌 리스너, 구독자 패턴
- [Transactions](./transactions.md): 격리 수준, 세이브포인트, 중첩 트랜잭션
- [NestJS Integration](./nestjs.md): 모듈 설정, 의존성 주입, 리포지토리 패턴
