# Tutorial: IoT 스마트 온도계 백엔드 만들기

## 무엇을 만드나요?

스마트 빌딩을 상상해 보세요. 수천 개의 작은 온도계가 벽, 천장, 에어덕트에 마치 신경 말단처럼 설치되어 있어요. 30초마다 각 온도계가 중앙 서버로 온도 데이터를 전송해요. 모바일 앱에서는 실시간 대시보드를 볼 수 있고, 서버실이 과열되면 알림이 울려요. 매일 밤 cron job이 데이터를 집계해서 일일 리포트를 만들어요.

이제 서로 다른 회사가 소유한 10개의 빌딩이 하나의 백엔드에서 돌아간다고 생각해 보세요. A회사는 B회사의 데이터를 절대 볼 수 없어야 해요. 이게 바로 **멀티테넌시**(multi-tenancy)에요.

이 튜토리얼에서는 NestJS와 Stingerloom ORM으로 이 백엔드를 처음부터 만들어 볼 거예요. 아키텍처는 다음과 같아요:

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

코드를 쓰기 전에 경계를 명확히 해 둘게요. ORM은 TypeScript 객체와 데이터베이스 사이의 번역기예요. 캐시도 아니고, 잡 큐도 아니고, 인증 시스템도 아니에요.

| 관심사 | 담당 | 담당하지 않는 것 |
|--------|------|-----------------|
| 엔티티 정의 & 스키마 | **Stingerloom ORM** | -- |
| 멀티테넌트 스키마 라우팅 | **Stingerloom ORM** (MetadataContext) | -- |
| CRUD 연산 | **Stingerloom ORM** (EntityManager) | -- |
| 집계 쿼리 | **Stingerloom ORM** (avg/min/max/count) | -- |
| 대량 데이터 배치 처리 | **Stingerloom ORM** (stream()) | -- |
| JWT 인증 | NestJS + Passport | ORM |
| 응답 캐싱 | Redis (ioredis) | ORM |
| 백그라운드 잡 / cron | BullMQ (@nestjs/bullmq) | ORM |
| 푸시 알림 | FCM / APNs | ORM |

이 튜토리얼 전체에서 경계를 넘을 때마다 `::: tip` 또는 `::: warning` 박스로 어떤 도구가 무엇을 하는지 알려 드릴게요.

---

## Step 0: Docker Compose로 인프라 구성

코드를 작성하기 전에 세 가지 서비스가 로컬에서 실행되어야 해요: 데이터 저장용 PostgreSQL, 캐싱용 Redis, JWT 인증용 Keycloak이에요.

프로젝트 루트에 `docker-compose.yml`을 만들어 주세요:

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

세 컨테이너 모두 healthy 상태가 되면, Keycloak을 설정해요:

1. `http://localhost:8080`에서 `admin` / `admin`으로 로그인
2. `smart-thermo` 이름의 realm 생성
3. `smart-thermo-api` 이름의 client 생성 (Access Type: confidential)
4. client의 **Mappers** 탭에서 mapper 추가:
   - Name: `tenantId`
   - Mapper Type: User Attribute
   - User Attribute: `tenantId`
   - Token Claim Name: `tenantId`
   - Claim JSON Type: `String`
   - Add to ID token: ON, Add to access token: ON
5. 테스트 사용자를 생성하고 `tenantId` 속성을 `building_a`로 설정

이렇게 하면 테넌트 식별자가 JWT에 직접 포함돼요. 모바일 앱이 인증하면 받는 토큰에 이미 어떤 빌딩에 속하는지 정보가 들어 있어요.

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

`tsconfig.json`에 다음 두 옵션이 있는지 확인하세요:

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

`RedisModule.forRoot()`는 글로벌 Redis 연결을 등록해서 어디서든 `@InjectRedis()`로 주입할 수 있게 해 줘요. 서비스마다 `new Redis()`를 흩뿌릴 필요가 없어요.

::: warning
`synchronize: true`는 개발 중에는 편리해요 -- ORM이 엔티티에 맞춰 테이블을 자동으로 생성하고 변경해 줘요. **프로덕션에서는 절대 사용하면 안 돼요.** 대신 [Migrations](./migrations.md)를 사용하세요.
:::

---

## Step 2: 엔티티 설계

좋은 엔티티 설계는 도메인에 대한 이해에서 시작해요. 스마트 온도계 시스템의 핵심 개념은 다음과 같아요:

- **Users** -- 디바이스를 소유한 사람 (온도계를 설치한 사람)
- **Devices** -- 물리적 온도계, 각각 시리얼 넘버와 위치 정보를 가져요
- **Temperature Readings** -- 시계열 데이터 포인트, 디바이스당 30초마다 하나씩 생성
- **Alert Rules** -- 임계값 정의 ("온도가 35도를 넘으면 알려줘")
- **Alerts** -- 규칙이 위반됐을 때 발생하는 알림
- **Daily Stats** -- 사전 계산된 일일 요약 (평균, 최소, 최대) - 빠른 대시보드 렌더링용

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

`@DeletedAt()` 데코레이터는 **soft delete**를 활성화해요. `em.delete(User, { id: 1 })`를 호출하면 ORM이 실제로 행을 삭제하지 않아요. 대신 `deletedAt`에 현재 타임스탬프를 설정해요. 이후 모든 `find()` 쿼리는 soft delete된 행을 자동으로 제외해요 -- `withDeleted: true`를 전달하지 않는 한. GDPR 준수에 필수적이에요: 사용자의 가시적인 존재는 "삭제"하면서도 감사 추적은 보존할 수 있어요.

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

  @ManyToOne(() => User, (user) => user.devices, { joinColumn: "user_id" })
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

`@BeforeInsert()` 훅은 INSERT SQL이 데이터베이스로 전송되기 전에 실행돼요. 여기서는 합리적인 기본값을 설정하는 데 사용해요 -- 새로 등록된 온도계는 활성 상태여야 하고, 이름이 주어지지 않으면 시리얼 넘버로 자동 생성해요.

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

이건 **대용량 엔티티**예요 -- 수백만 행을 갖게 될 테이블이에요. 설계 결정이 쿼리 성능에 직접적으로 영향을 줘요.

```typescript
// src/entities/temperature-reading.entity.ts
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  Index,
  CreateTimestamp,
  BeforeInsert,
} from "@stingerloom/orm";
import { Device } from "./device.entity";

@Entity({ name: "temperature_readings" })
export class TemperatureReading {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Device, (d) => d.readings, { joinColumn: "device_id" })
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

`recordedAt`와 `temperatureCelsius`에 `@Index()`가 있는 걸 주목하세요. 인덱스가 없으면 "최근 7일간 최고 온도 찾기" 같은 쿼리가 테이블의 모든 행을 스캔해야 해요. 인덱스가 있으면 데이터베이스가 해당 날짜 범위로 바로 점프할 수 있어요.

`@BeforeInsert()` 훅은 데이터 품질 게이트 역할을 해요. -500도를 보고하는 센서는 분명히 오작동 중이에요. 데이터가 데이터베이스에 도달하기도 전에 거부해요.

### AlertRule

```typescript
// src/entities/alert-rule.entity.ts
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  CreateTimestamp,
} from "@stingerloom/orm";
import { Device } from "./device.entity";

@Entity({ name: "alert_rules" })
export class AlertRule {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Device, { joinColumn: "device_id" })
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
  CreateTimestamp,
} from "@stingerloom/orm";
import { AlertRule } from "./alert-rule.entity";
import { TemperatureReading } from "./temperature-reading.entity";

@Entity({ name: "alerts" })
export class Alert {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => AlertRule, { joinColumn: "alert_rule_id" })
  rule!: AlertRule;

  @ManyToOne(() => TemperatureReading, { joinColumn: "reading_id" })
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

이 엔티티를 **월간 은행 명세서**라고 생각해 보세요. 은행이 개별 거래를 모두 나열하는 대신 요약을 제공하듯이 -- 총 입금액, 총 출금액, 잔액 -- 우리도 온도 데이터를 같은 방식으로 처리해요. 누군가 대시보드를 열 때마다 수백만 건의 원시 데이터를 쿼리하는 대신, 일일 요약을 사전 계산해 둬요.

```typescript
// src/entities/daily-stats.entity.ts
import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  ManyToOne,
  Index,
  UpdateTimestamp,
} from "@stingerloom/orm";
import { Device } from "./device.entity";

@Entity({ name: "daily_stats" })
export class DailyStats {
  @PrimaryGeneratedColumn()
  id!: number;

  @ManyToOne(() => Device, { joinColumn: "device_id" })
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

`@UpdateTimestamp()` 데코레이터가 여기서 중요해요. 야간 cron job이 오늘의 데이터를 재집계할 때, ORM이 이 필드를 자동으로 업데이트해요. `updatedAt`이 오래됐다면 cron job이 실행되지 않았다는 걸 바로 알 수 있어요.

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

PostgreSQL은 기본적으로 인덱스를 B-tree 구조로 저장해요. `recordedAt`에 B-tree가 있으면 범위 쿼리(`BETWEEN`, `>=`, `<`)와 `ORDER BY`를 전체 테이블 스캔 없이 처리할 수 있어요. "최근 7일간의 데이터"를 찾기 위해 모든 행을 읽는 대신, 트리에서 시작 지점으로 이동해서 순차적으로 읽어요.

인덱스가 없으면 1,000만 행이 있는 테이블에서 순차 스캔이 필요해요 -- 모든 행을 읽고 WHERE 조건을 확인해야 해요. 이건 초 단위로 걸려요. B-tree 인덱스가 있으면 같은 쿼리가 밀리초 만에 완료돼요. 해당 범위로 직접 건너뛰기 때문이에요.

`temperatureCelsius` 인덱스도 같은 목적이에요 -- "35도 이상인 모든 데이터 찾기" 같은 임계값 쿼리용이에요. Step 6에서 `explain()`을 사용해서 이 인덱스들이 실제로 쿼리 플래너에 의해 사용되는지 확인할 거예요.

#### `@BeforeInsert()`를 데이터베이스 CHECK 제약조건 대신 쓰는 이유

둘 다 데이터를 검증하지만, 서로 다른 레이어에서 동작해요:

- **ORM 훅** (`@BeforeInsert()`)은 애플리케이션 코드에서, SQL이 데이터베이스에 도달하기 전에 실행돼요. 설명적인 에러 메시지("Temperature cannot be below absolute zero")를 생성하고, 복잡한 비즈니스 로직(교차 필드 검증, 외부 API 호출)을 실행하고, 애플리케이션의 에러 처리 파이프라인과 통합할 수 있어요.

- **데이터베이스 CHECK 제약조건** (`CHECK (temperature_celsius >= -273.15)`)은 PostgreSQL 내부에서 실행돼요. 이건 최후의 방어선이에요 -- ORM을 우회하는 데이터도 잡아내요 (raw SQL 스크립트, 마이그레이션, 같은 DB에 쓰는 다른 애플리케이션).

이상적인 접근법은 둘 다 사용하는 거예요: 명확한 에러 메시지를 위한 훅 + 데이터 무결성을 위한 CHECK 제약조건. 이 튜토리얼에서는 ORM 기능 시연이 목적이라 훅에 집중하지만, 프로덕션에서는 마이그레이션 파일에 CHECK 제약조건을 추가하세요.

#### Users에는 `@DeletedAt()` (soft delete)를 쓰고 Readings에는 안 쓰는 이유

Users에는 감사 및 규정 준수 요구사항이 있어요. GDPR 같은 규정에서는 사용자의 가시적인 존재를 "삭제"하면서도 데이터를 올바르게 처리했음을 증명하는 기록을 보존해야 할 수 있어요. Soft delete가 이걸 해결해요 -- 모든 쿼리에서 사용자가 사라지지만, 행은 감사용으로 남아 있어요.

Temperature readings는 원시 센서 데이터예요. 사람을 나타내지 않아요. 삭제가 필요하면 보통 날짜 범위로 일괄 삭제해요 (`DELETE FROM temperature_readings WHERE recordedAt < '2025-01-01'`). 수천만 행이 있는 테이블에 `deletedAt` 컬럼을 추가하면 상당한 스토리지가 낭비되고, 모든 쿼리에 `WHERE deletedAt IS NULL` 필터가 추가돼요 -- 가장 볼륨이 큰 테이블에 불필요한 비용이에요.

#### materialized view 대신 별도의 `DailyStats`를 쓰는 이유

PostgreSQL materialized view(`CREATE MATERIALIZED VIEW`)도 비슷한 목적으로 쓸 수 있지만, 실용적인 한계가 있어요:

1. **이식성.** 모든 PostgreSQL 호스팅 제공자가 materialized view의 모든 기능(concurrent refresh, indexes)을 지원하는 건 아니에요. 일반 테이블은 모든 제공자와 ORM이 지원하는 모든 데이터베이스에서 동일하게 동작해요.
2. **버전 관리.** `DailyStats` 엔티티는 코드에 정의되고 마이그레이션으로 추적돼요. 스키마 변경이 PR과 코드 리뷰를 거쳐요.
3. **관측성.** `@UpdateTimestamp()` 데코레이터가 내장 "마지막 갱신" 지표를 제공해요. `updatedAt`이 3일 전이면 집계 cron job이 고장났다는 걸 바로 알 수 있어요.
4. **세밀한 제어.** 전체 뷰를 새로고침하지 않고 특정 디바이스의 통계만 업데이트할 수 있어요. Materialized view refresh는 전부-아니면-전무예요.

---

## Step 3: 멀티테넌시 -- 하나의 앱, 여러 빌딩

### 비유

우편함이 있는 아파트를 상상해 보세요. 모든 입주민이 같은 복도와 엘리베이터를 공유하지만, 각 우편함은 비공개예요 -- 내 키로는 내 우편함만 열 수 있어요.

멀티테넌시도 같은 원리예요. 모든 테넌트가 같은 NestJS 서버와 PostgreSQL 인스턴스를 공유하지만, 각 테넌트의 데이터는 자체 **PostgreSQL 스키마**에 살아요. "building_a" 테넌트는 `building_a.devices`, `building_a.temperature_readings` 등을 갖고 있어요. "building_b" 테넌트도 자체적으로 동일한 테이블 세트를 갖고 있어요. ORM이 자동으로 올바른 스키마로 쿼리를 라우팅해요.

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

기존 [Multi-Tenancy](./multi-tenancy.md) 가이드에서는 HTTP 헤더에서 테넌트를 추출해요. 실제 프로덕션 시스템에서는 테넌트 식별정보가 **신뢰할 수 있는 소스** -- JWT에서 와야 해요. 서명된 토큰에 포함되어 있으면 사용자가 헤더를 변경해서 테넌트를 위조할 수 없어요.

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

핵심 라인은 `MetadataContext.run(tenantId, () => { next() })`예요. 이게 **전체 HTTP 요청 라이프사이클**을 Node.js `AsyncLocalStorage`를 사용해서 테넌트 컨텍스트로 감싸요. 이후 컨트롤러, 서비스, 리포지토리에서의 모든 ORM 호출이 자동으로 올바른 스키마를 대상으로 해요.

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

Node.js는 싱글 스레드에서 실행되지만, 이벤트 루프를 통해 많은 동시 HTTP 요청을 처리해요. 주의 깊은 컨텍스트 관리가 없으면, 두 개의 동시 요청이 서로의 테넌트 식별정보를 간섭할 수 있어요. `AsyncLocalStorage`는 각 비동기 실행 체인에 자체 격리된 저장소를 제공해서 이 문제를 해결해요 -- 같은 스레드에서 작업이 인터리빙되더라도요.

두 개의 동시 요청이 있는 구체적인 타임라인이에요:

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

t3 시점에서, Request B가 이미 시작되어 t2에서 자체 컨텍스트를 설정했더라도, Request A는 여전히 `building_a`로 올바르게 해석돼요. 각 `MetadataContext.run()` 호출은 `await`, Promise, 콜백을 통해 비동기 호출 체인을 따르는 독립적인 실행 컨텍스트를 생성해요 -- 다른 동시 컨텍스트로 누출되지 않아요.

`AsyncLocalStorage` 없이 단순한 전역 변수 접근법(예: `global.currentTenant = tenantId`)을 쓰면 레이스 컨디션이 발생해요: Request A의 DB 쿼리가 실행되기 전에 Request B가 테넌트를 `building_b`로 덮어쓰면, Request A가 잘못된 스키마를 쿼리하게 돼요. `AsyncLocalStorage`는 이런 동시성 버그를 설계적으로 제거해요.

### 테넌트 컨텍스트가 없을 때 어떻게 되나요?

`MetadataContext.run()` 바깥에서 코드가 실행되면 -- 예를 들어 시작 스크립트나 모듈 초기화에서 -- ORM은 `public` 스키마로 폴백해요. 이건 의도된 동작이에요: public 스키마는 `ensureSchema()`가 복제하는 템플릿 테이블을 보관하는 곳이에요.

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
public 스키마에 테넌트별 데이터를 절대 저장하지 마세요. public 스키마는 `ensureSchema()`가 복제할 구조적 템플릿으로만 존재해요. 실수로 public 스키마에 데이터를 쓰면, 어떤 테넌트에도 보이지 않고, 테넌트 범위의 삭제 작업으로도 정리되지 않아요.
:::

### Tenant Schema Service

새 테넌트가 처음 요청하면 아직 스키마가 존재하지 않아요. `TenantSchemaService`가 자동으로 생성해요:

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

`ensureSchema()`는 두 가지를 해요: 스키마가 존재하는지 확인하고, 없으면 public 스키마의 테이블 구조를 복제해서 생성해요. 새 테넌트를 위해 빈 테이블 세트를 인쇄하는 것과 같아요.

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

`AppModule` imports에 `TenantModule`을 추가하세요:

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

이제 모든 요청이 자동으로 올바른 테넌트로 스코핑돼요. 서비스 코드가 깔끔하게 유지돼요 -- `withTenant()` 래퍼도 없고, 매번 `tenantId` 파라미터를 전달할 필요도 없어요.

---

## Step 4: Keycloak JWT 인증

::: tip ORM 경계
이 단계는 **ORM과 전혀 관련이 없어요**. 인증은 전송 계층의 관심사예요 -- *누가* 요청하는지를 판별해요. ORM은 *어떤 데이터*를 쿼리할지만 신경 써요. 이 단계를 포함하는 이유는 JWT가 TenantMiddleware에 전달되는 `tenantId` 클레임을 가지고 있기 때문이에요.
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

`AppModule` imports에 `AuthModule`을 추가하세요. 그리고 보호할 라우트에 guard를 적용하세요:

```typescript
@Controller("devices")
@UseGuards(JwtAuthGuard) // Every route in this controller requires a valid JWT
export class DevicesController {
  // ...
}
```

ORM을 전혀 건드리지 않았어요. JWT guard가 토큰을 검증하고, TenantMiddleware(Step 3)가 `req.user.tenantId`를 읽어서 ORM 컨텍스트를 설정해요. 이 두 시스템은 `req.user`를 통해 소통해요 -- NestJS의 표준 패턴이에요.

---

## Step 5: 온도 데이터 수집

이제 애플리케이션의 핵심이에요: 디바이스에서 온도 데이터를 수신하는 거예요. ORM이 가장 무거운 작업을 하는 부분이에요.

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

단일 온도계가 하나의 데이터를 보낼 때 `save()`를 사용해요:

```typescript
// src/readings/readings.service.ts
import { Injectable } from "@nestjs/common";
import { InjectRepository, BaseRepository } from "@stingerloom/orm/nestjs";
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

이 SQL이 실행되기 전에 `@BeforeInsert()` 훅이 실행돼요. 온도가 절대영도 이하이면 훅이 에러를 던져서 INSERT가 데이터베이스에 도달하지 않아요.

### 배치 수집 -- insertMany()

디바이스가 데이터를 버퍼링하다가 한 번에 100개를 보낼 수 있어요. `save()`를 루프에서 호출하면 100개의 개별 INSERT 문이 생겨요. `insertMany()`는 하나의 문으로 묶어줘요:

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

100번의 라운드트립 대신 1번. 실제 벤치마크에서 10~50배 빨라요.

::: warning insertMany()는 라이프사이클 훅을 실행하지 않아요
`@BeforeInsert()`와 `@AfterInsert()` 훅은 `save()`와 `saveMany()`에서만 동작해요. 배치 항목마다 검증이 필요하면, `insertMany()` 호출 전에 애플리케이션 코드에서 검증하거나, `saveMany()`를 사용하세요 (더 느리지만 훅이 동작해요).
:::

### EntitySubscriber로 알림 체크

새 데이터가 들어오면 해당 디바이스의 알림 규칙을 위반했는지 확인하고 싶어요. 이 로직을 `ReadingsService.ingestOne()` 안에 넣을 수도 있지만, 그러면 수집 서비스가 알림 시스템에 결합돼요. 대신 **EntitySubscriber**를 사용해요 -- 특정 엔티티의 이벤트에 반응하는 별도의 클래스예요.

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

모듈 초기화 시 subscriber를 등록하세요:

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

이제 흐름이 완전히 분리돼요:

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

모바일 앱은 여러 종류의 쿼리가 필요해요. 하나씩 구현하면서 ORM이 생성하는 SQL을 확인해 볼게요.

아래의 모든 메서드는 각각의 서비스에 위치하고, `@InjectRepository`로 리포지토리를 주입받아요:

```typescript
// src/devices/devices.service.ts
import { Injectable } from "@nestjs/common";
import { InjectRepository, BaseRepository } from "@stingerloom/orm/nestjs";
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
`@InjectRepository`는 표준 CRUD, 페이지네이션, 집계, upsert에 사용하세요 -- 사용 사례의 90%를 커버해요. `@Inject(EntityManager)`는 인프라 수준 작업용으로 남겨두세요: raw SQL(`em.query()`), 스트리밍(`em.stream()`), subscriber 등록(`em.addSubscriber()`), 드라이버 접근(`em.getDriver()`).
:::

### 디바이스별 최신 데이터

앱을 열면 가장 먼저 보이는 건 각 디바이스의 현재 온도예요.

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

사용자가 디바이스를 탭해서 이력을 볼 때, 앱은 스크롤 가능한 목록을 보여줘요. 아래로 스크롤하면 더 많은 데이터가 로드돼요. 이게 **무한 스크롤**이고, 이에 가장 적합한 페이지네이션 전략은 커서 기반이에요.

왜 offset 페이지네이션이 아닐까요? 디바이스에 100만 건의 데이터가 있다고 가정해 보세요. `OFFSET 500000`으로 500페이지를 요청하면 PostgreSQL이 500,000개의 행을 스캔하고 건너뛰어야 해요. 커서 페이지네이션은 "**이 특정 타임스탬프보다 오래된** 데이터를 줘"라고 말해요. 데이터베이스가 인덱스를 사용해서 바로 그 지점으로 점프해요 -- 1페이지든 10,000페이지든 똑같이 빨라요.

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

ORM은 51개의 행(50 + 1개 추가)을 가져와서 다음 페이지가 있는지 감지해요. 51개가 돌아오면 `hasNextPage`가 `true`이고 추가 행은 버려요.

응답 형태가 모바일 클라이언트에 딱 맞아요:

```json
{
  "data": [ /* 50 TemperatureReading objects */ ],
  "hasNextPage": true,
  "nextCursor": "eyJ2IjoiMjAyNi0wMy0yOFQxMDowMDowMC4wMDBaIn0=",
  "count": 50
}
```

클라이언트가 `nextCursor`를 저장해두고 사용자가 하단으로 스크롤하면 다시 전달해요.

### 총 개수와 함께 디바이스 목록 조회

"내 디바이스" 화면은 총 개수와 함께 페이지네이션된 목록을 보여줘요 ("47개 중 1-10 표시").

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

`findAndCount()`는 `[Device[], number]`를 반환해요 -- 데이터와 총 개수를 한 번의 호출로 받아요.

### 날짜 범위 필터

"3월 1-7일 사이에 온도가 30도 이상인 모든 데이터를 보여줘":

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

`between`과 `gte` 연산자가 SQL `BETWEEN`과 `>=`로 직접 변환돼요. 문자열 결합도 없고, SQL injection 위험도 없어요 -- 모든 값이 파라미터 바인딩을 통해요.

### EXPLAIN으로 느린 쿼리 진단

쿼리가 예상보다 느릴 때, `explain()`은 데이터베이스의 실행 계획을 보여줘요 -- 어떤 인덱스를 사용하는지, 몇 개의 행을 스캔하는지, 어디에 병목이 있는지.

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

핵심적으로 봐야 할 것: **"Seq Scan"**은 전체 테이블 스캔을 의미해요 -- 매칭되는 행을 찾기 위해 테이블의 모든 행을 읽는 거예요. 수백만 행이 있는 테이블에서는 느려요. **"Index Scan"** 또는 **"Index Only Scan"**은 데이터베이스가 B-tree 인덱스를 효율적으로 사용해서 관련 행으로 바로 점프하는 거예요.

Index Scan이 예상되는데 Seq Scan이 보이면 확인하세요:
1. 해당 컬럼에 `@Index()` 데코레이터가 있나요?
2. `synchronize`나 마이그레이션을 실행해서 실제로 인덱스를 생성했나요?
3. 테이블이 충분히 작아서 PostgreSQL이 순차 스캔이 더 빠르다고 판단한 건 아닌가요? (쿼리 플래너는 똑똑해요 -- ~1,000행 미만의 테이블에서는 순차 스캔이 인덱스 조회보다 빠를 수 있어요.)

### QueryTracker로 N+1 쿼리 감지

N+1은 ORM에서 가장 흔한 성능 문제예요. 엔티티 목록을 로드한 다음, 루프를 돌면서 각 관련 엔티티에 대해 별도의 쿼리를 트리거할 때 발생해요.

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

Stingerloom ORM의 `QueryTracker`가 이 패턴을 자동으로 감지해요:

```typescript
// Enable query tracking (usually in development or staging)
em.enableQueryTracker({ warnThreshold: 5, slowQueryMs: 500 });
```

tracker가 짧은 시간 내에 5개 이상의 유사한 쿼리를 감지하면 경고를 로깅해요:

```
[QueryTracker] N+1 detected: 100 queries to "temperature_readings" in 1.2s
```

**해결법**: `relations`를 사용해서 eager-load하거나, 단일 쿼리로 재구성하세요:

```typescript
// GOOD: single query with join
const devices = await this.deviceRepo.find({
  where: { isActive: true },
  relations: ["readings"],
});
```

`relations: ["readings"]`를 사용하면 ORM이 단일 `LEFT JOIN` 쿼리를 생성해서 모든 디바이스와 그 데이터를 한 번의 라운드트립으로 가져와요. 100개의 디바이스에 대해 101개가 아닌 1개의 쿼리로 처리돼요.

---

## Step 7: 집계 -- 일일 통계

### 실시간 집계의 문제점

모바일 앱에 "이번 주 평균 온도"와 "최근 24시간 최고 기록"을 보여주는 대시보드가 있다고 가정해 보세요. 매번 원시 데이터에서 계산할 수도 있어요:

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

10,000건의 데이터에서는 잘 동작해요. 하지만 1,000만 건이면? 각 쿼리가 거대한 범위를 스캔해요. 100명의 사용자가 동시에 대시보드를 열면 데이터베이스가 200개의 집계 스캔을 동시에 실행하게 돼요.

### 사전 집계: 월간 은행 명세서 접근법

매 요청마다 원시 데이터를 스캔하는 대신, 일일 요약을 사전 계산해요. 은행이 개별 거래에서 월간 명세서를 생성하듯이, 각 디바이스의 각 날짜에 대해 `DailyStats` 행을 생성해요.

```typescript
// src/stats/stats.service.ts
import { Injectable, Inject } from "@nestjs/common";
import { InjectRepository, BaseRepository } from "@stingerloom/orm/nestjs";
import { EntityManager } from "@stingerloom/orm";
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
  ("device_id", "date", "avgTemperature", "minTemperature", "maxTemperature", "readingCount")
VALUES ($1, $2, $3, $4, $5, $6)
ON CONFLICT ("id") DO UPDATE SET
  "avgTemperature" = EXCLUDED."avgTemperature",
  "minTemperature" = EXCLUDED."minTemperature",
  "maxTemperature" = EXCLUDED."maxTemperature",
  "readingCount" = EXCLUDED."readingCount"
```

`upsert()`가 핵심이에요 -- cron job이 같은 날에 두 번 실행되면 중복을 만드는 대신 덮어써요. 설계적으로 멱등성(idempotent)이 보장돼요.

### 복잡한 집계를 위한 Raw SQL

때로는 ORM의 내장 집계 함수로 부족할 때가 있어요. 예를 들어, "최근 24시간 동안 시간별 평균 온도"는 `GROUP BY`와 `date_trunc()`가 필요한데 -- ORM의 finder API로는 표현할 수 없어요.

이때 `em.query()`가 빛을 발해요:

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
| 단일 집계 (count, avg, max) | `repo.count()`, `repo.avg()`, `repo.max()` | 더 간단하고, 타입 안전하고, dialect 이식성이 있어요 |
| GROUP BY, window functions, CTEs | `em.query()` + `sql-template-tag` | ORM finder가 표현식과 함께하는 GROUP BY를 지원하지 않아요 |
| 애플리케이션 측 집계 | `em.stream()` + loop | DB가 로직을 표현할 수 없을 때 (ML 스코어링, 커스텀 알고리즘) |

세 가지 경우 모두 ORM이 연결 관리, 파라미터 바인딩, 테넌트 컨텍스트를 처리해요. 차이는 SQL을 얼마나 직접 작성하느냐예요.
:::

### 대시보드 엔드포인트

이제 모바일 앱이 원시 데이터 대신 사전 계산된 통계를 쿼리할 수 있어요:

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

이 쿼리는 최대 7개의 행만 스캔해요. 원시 데이터가 아무리 많아도 상관없어요.

---

## Step 8: 배치 처리를 위한 스트리밍

### 문제

매일 새벽 2시에 모든 디바이스의 어제 데이터를 집계해야 해요. 어떤 테넌트는 10,000개의 디바이스를 가지고 있어요. 각 디바이스는 하루에 ~2,880개의 데이터를 생성해요 (30초마다 하나). 처리해야 할 행이 2,880만 개예요.

2,880만 행을 메모리에 로드하면 Node.js 프로세스가 크래시돼요. `em.stream()`이 행을 작은 배치로 가져와서 이 문제를 해결해요:

```typescript
// src/stats/aggregation.processor.ts
import { Inject, Injectable } from "@nestjs/common";
import { InjectRepository, BaseRepository } from "@stingerloom/orm/nestjs";
import { EntityManager } from "@stingerloom/orm";
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

어떤 시점에서든 메모리에는 500개의 디바이스 객체만 존재해요. 각각 처리된 후 다음 배치가 도착하면 가비지 컬렉션돼요.

### BullMQ로 트리거

::: tip ORM 경계
BullMQ는 잡 큐 라이브러리예요 -- ORM과는 무관해요. 새벽 2시에 집계를 **트리거**하는 데 사용해요. 실제 데이터 처리는 `em.stream()`과 `em.avg()`/`em.min()`/`em.max()`가 해요.
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

worker 안에서 `MetadataContext.run(tenantId, ...)`을 호출하는 게 중요해요. BullMQ 잡은 HTTP 요청 라이프사이클 바깥에서 실행되므로 TenantMiddleware가 컨텍스트를 설정해 주지 않아요. 직접 해야 해요. ORM의 AsyncLocalStorage 컨텍스트는 HTTP 요청이든 백그라운드 잡이든 동일하게 동작해요.

---

## Step 9: Redis 캐싱

::: warning ORM 경계
Redis 캐싱은 **ORM의 관심사가 아니에요**. ORM의 책임은 PostgreSQL에서 끝나요. ORM의 EntitySubscriber 패턴을 사용해서 두 시스템을 **연결**해요 -- 기반 데이터가 변경될 때 캐시를 무효화하는 거예요.
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
import { InjectRepository, BaseRepository } from "@stingerloom/orm/nestjs";
import { MetadataContext } from "@stingerloom/orm";
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

어디에도 `new Redis()`가 없는 걸 주목하세요. `@InjectRedis()` 데코레이터가 Step 1에서 등록한 `RedisModule`에서 연결을 가져와요. 모든 Redis 연결이 NestJS의 라이프사이클로 관리돼요 -- 종료 시 적절한 정리, 공유 설정, DI를 통한 테스트 가능성.

### EntitySubscriber로 캐시 무효화

야간 집계 cron으로 새 일일 통계가 계산되면, 캐시된 데이터는 더 이상 유효하지 않아요. `EntitySubscriber`를 사용해서 관련 캐시 키를 자동으로 무효화해요:

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

subscriber는 생성자를 통해 Redis 인스턴스를 받아요. subscriber를 등록할 때 DI가 관리하는 Redis를 전달해요:

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

이 패턴의 장점: 집계 서비스(`StatsService`)는 Redis를 몰라요. 캐시 서비스는 집계 스케줄을 몰라요. subscriber가 이 둘을 연결해요 -- ORM이 `DailyStats` 행을 쓰면, subscriber가 반응해서 오래된 캐시를 삭제해요. 시스템이 완전히 분리돼 있어요.

---

## Step 10: 트랜잭션을 활용한 알림 처리

### 시나리오

온도 데이터가 알림 규칙을 위반하면 다음을 해야 해요:
1. `Alert` 레코드 생성
2. (선택) 중복 알림을 방지하기 위해 해당 데이터를 "alerted"로 표시

이 두 작업은 함께 성공하거나 함께 실패해야 해요. 알림이 생성됐는데 데이터 업데이트가 실패하면 유령 알림이 생겨요. 데이터가 업데이트됐는데 알림 생성이 실패하면 알림을 조용히 잃어요. 이게 바로 트랜잭션이 필요한 이유예요.

### @Transactional() 사용

```typescript
// src/alerts/alerts.service.ts
import { Injectable } from "@nestjs/common";
import { InjectRepository, BaseRepository } from "@stingerloom/orm/nestjs";
import { Transactional } from "@stingerloom/orm";
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

트랜잭션 경계를 명시적으로 제어하고 싶다면:

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

두 접근법 모두 동일한 SQL을 생성해요. `@Transactional()`은 단순한 경우에 더 깔끔해요. `em.transaction()`은 조건부로 작업을 포함해야 할 때 명시적인 제어를 제공해요.

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

리포지토리가 `@InjectRepository`로 주입되기 때문에, 테스트에서 mock할 수 있어요. 실행 중인 데이터베이스 없이, Docker 없이, 밀리초 만에 비즈니스 로직을 격리해서 테스트할 수 있어요.

```typescript
// src/readings/readings.service.spec.ts
import { Test, TestingModule } from "@nestjs/testing";
import { ReadingsService } from "./readings.service";
import { getRepositoryToken } from "@stingerloom/orm/nestjs";
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
          provide: getRepositoryToken(TemperatureReading),
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

트랜잭션, 제약조건, 테넌트 격리 같은 실제 데이터베이스 동작이 필요한 테스트에는 ORM의 테스트 유틸리티를 사용하세요:

```typescript
// test/integration/multi-tenant.spec.ts
import { EntityManager, MetadataContext } from "@stingerloom/orm";
import { Device } from "../../src/entities/device.entity";

describe("Multi-Tenant Isolation", () => {
  let em: EntityManager;

  beforeAll(async () => {
    // Connect to a test database
    em = new EntityManager({
      type: "postgres",
      host: "localhost",
      port: 5432,
      database: "smart_thermo_test",
      username: "postgres",
      password: "postgres",
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
항상 별도의 테스트 데이터베이스를 사용하세요. `synchronize: true` 옵션이 테이블을 자동으로 생성하지만, 드롭하고 재생성하기도 해요 -- 테스트를 프로덕션 데이터베이스에 연결하지 마세요.
:::

---

## 완성된 시스템

한 발 물러서서 전체 시스템을 살펴볼게요:

| 컴포넌트 | 하는 일 | ORM 관여 여부 |
|----------|---------|--------------|
| Docker Compose | PostgreSQL + Redis + Keycloak 인프라 | 아니요 |
| 6개 엔티티 | 관계, 인덱스, 훅이 포함된 데이터 모델 | **예** -- 데코레이터 |
| Tenant Middleware | JWT 클레임 기반 스키마별 테넌트 라우팅 | **예** -- MetadataContext |
| Keycloak JWT 인증 | 토큰 검증, 사용자 식별 | 아니요 |
| 단일 + 배치 수집 | 온도 데이터의 save()와 insertMany() | **예** -- EntityManager |
| Alert Subscriber | 새 데이터에 대한 분리된 알림 체크 | **예** -- EntitySubscriber |
| 커서 페이지네이션 | 모바일 데이터 이력의 무한 스크롤 | **예** -- findWithCursor() |
| 집계 | avg/min/max/count + upsert를 통한 일일 통계 | **예** -- 집계 함수 |
| 스트리밍 | 메모리 오버플로 없이 수백만 행 처리 | **예** -- stream() |
| Redis 캐싱 | 캐시 무효화가 포함된 빠른 대시보드 데이터 | EntitySubscriber를 통한 연결 |
| 트랜잭션 | 원자적 알림 생성 | **예** -- @Transactional() |
| BullMQ Cron | 야간 집계 트리거 | 아니요 (ORM 코드를 트리거) |

ORM은 TypeScript 객체와 PostgreSQL 사이의 모든 것을 처리해요. Redis, BullMQ, Keycloak은 ORM이 명확한 경계를 통해 연결하는 외부 시스템이에요 (캐시 무효화를 위한 EntitySubscriber, 백그라운드 잡을 위한 MetadataContext.run()).

### 프로덕션 체크리스트

프로덕션 배포 전에 다음 항목을 확인하세요:

| 항목 | 상태 | 비고 |
|------|------|------|
| 프로덕션 설정에서 `synchronize: false` | 필수 | synchronize는 컬럼을 드롭할 수 있으므로 마이그레이션 사용 |
| 커넥션 풀링 설정 | 필수 | ORM 설정에서 `pool: { min: 2, max: 10 }` 설정 |
| 쿼리 타임아웃 설정 | 권장 | `timeout: 30000` (30초)으로 폭주 쿼리 방지 |
| 스테이징에서 N+1 감지 활성화 | 권장 | `em.enableQueryTracker({ warnThreshold: 5 })` |
| Redis 연결 에러 처리 | 필수 | ioredis가 자동 재연결하지만 실패를 로깅하세요 |
| 테넌트 스키마 마이그레이션 전략 | 필수 | 배포 시 `TenantMigrationRunner.syncTenantSchemas()` 실행 |
| JWT 공개 키 로테이션 | 중요 | jwks-rsa가 키를 캐시해요 -- `cache: true, rateLimit: true` 설정 |
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

`propagateShutdown()`은 모든 데이터베이스 연결을 닫고, 이벤트 리스너와 subscriber를 정리하고, query tracker 리소스를 해제해요. 이게 없으면 PostgreSQL 연결이 남아있어서 프로세스가 종료 시 멈출 수 있어요. 컨테이너 환경(Docker, Kubernetes)에서는 남아있는 연결이 컨테이너의 정상 종료를 방해해서, 진행 중인 트랜잭션의 강제 종료와 데이터 손실로 이어질 수 있어요.

## 다음 단계

- [Entities & Columns](./entities.md) -- 모든 데코레이터 옵션 상세 설명
- [Multi-Tenancy](./multi-tenancy.md) -- 스키마 전략, OverlayFS 메타데이터, 동시성 안전
- [Querying & Pagination](./entity-manager-querying.md) -- 모든 WHERE 연산자, 스트리밍, 집계
- [Writes & Transactions](./entity-manager-writes.md) -- 배치 연산, upsert, 데드락 재시도
- [Events & Subscribers](./events.md) -- 라이프사이클 훅, 글로벌 리스너, subscriber 패턴
- [Transactions](./transactions.md) -- 격리 수준, savepoint, 중첩 트랜잭션
- [NestJS Integration](./nestjs.md) -- 모듈 설정, 의존성 주입, repository 패턴
