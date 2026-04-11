# Joined / Table Per Type Inheritance (TPT) -- 심층 가이드

Joined Inheritance(Table Per Type, TPT라고도 불러요)는 공유 컬럼을 루트 테이블에 저장하고, 자식별 고유 컬럼은 별도의 자식 테이블에 저장한 뒤 기본 키(PK)에 대한 외래 키(FK)로 연결하는 전략이에요. 가족이 거실(루트 테이블)은 함께 쓰지만 각자 자기만의 침실(자식 테이블)을 갖는 것과 비슷해요. 누군가에 대해 전부 알려면 두 방(JOIN)을 다 방문해야 하죠.

이 가이드에서는 모든 CRUD 연산을 하나씩 살펴보면서 각 연산마다 정확한 SQL, raw 결과 행, 역직렬화된 TypeScript 객체를 함께 보여줘요.

## 1. 스키마

이 계층 구조는 세 개의 테이블을 사용해요: 하나의 루트 테이블(`payment`)과 자식 타입별 테이블 하나씩이에요.

### PostgreSQL

```sql
CREATE TABLE "payment" (
  "id"           SERIAL PRIMARY KEY,
  "amount"       INT NOT NULL,
  "payment_type" VARCHAR(50) NOT NULL
);

CREATE TABLE "credit_card_payment" (
  "id"         INT PRIMARY KEY,
  "cardNumber" VARCHAR(255) NOT NULL
);

ALTER TABLE "credit_card_payment"
  ADD CONSTRAINT "fk_credit_card_payment_id_a1b2c3d4"
  FOREIGN KEY ("id") REFERENCES "payment" ("id");

CREATE TABLE "bank_transfer_payment" (
  "id"       INT PRIMARY KEY,
  "bankCode" VARCHAR(255) NOT NULL
);

ALTER TABLE "bank_transfer_payment"
  ADD CONSTRAINT "fk_bank_transfer_payment_id_e5f6g7h8"
  FOREIGN KEY ("id") REFERENCES "payment" ("id");
```

### MySQL

```sql
CREATE TABLE `payment` (
  `id`           INT NOT NULL AUTO_INCREMENT,
  `amount`       INT NOT NULL,
  `payment_type` VARCHAR(50) NOT NULL,
  PRIMARY KEY (`id`)
);

CREATE TABLE `credit_card_payment` (
  `id`         INT NOT NULL,
  `cardNumber` VARCHAR(255) NOT NULL,
  PRIMARY KEY (`id`),
  FOREIGN KEY (`id`) REFERENCES `payment` (`id`)
);

CREATE TABLE `bank_transfer_payment` (
  `id`       INT NOT NULL,
  `bankCode` VARCHAR(255) NOT NULL,
  PRIMARY KEY (`id`),
  FOREIGN KEY (`id`) REFERENCES `payment` (`id`)
);
```

세 가지를 주목해보세요:

1. 루트 테이블(`payment`)은 공유 컬럼(`id`, `amount`)과 discriminator 컬럼(`payment_type`)만 갖고 있어요
2. 각 자식 테이블의 기본 키가 동시에 루트 테이블의 `id`를 참조하는 외래 키예요 -- 모든 자식 행에 대응하는 루트 행이 반드시 존재하는 것을 보장해요
3. 자식 컬럼에 NOT NULL 제약 조건을 걸 수 있어요 -- Single Table Inheritance와 달리 "다른 타입"의 행이 없기 때문에 데이터베이스가 자식 고유 필드에 대한 제약 조건을 강제할 수 있어요

## 2. 엔티티 정의

```typescript
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Inheritance,
  DiscriminatorColumn,
  DiscriminatorValue,
} from "@stingerloom/orm";

// Root entity: shared columns + strategy declaration
@Entity()
@Inheritance({ strategy: "JOINED" })
@DiscriminatorColumn({ name: "payment_type", type: "varchar", length: 50 })
export class Payment {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  amount!: number;
}

// Child 1: own table "credit_card_payment"
@Entity()
@DiscriminatorValue("credit_card")
export class CreditCardPayment extends Payment {
  @Column()
  cardNumber!: string;
}

// Child 2: own table "bank_transfer_payment"
@Entity()
@DiscriminatorValue("bank_transfer")
export class BankTransferPayment extends Payment {
  @Column()
  bankCode!: string;
}
```

자식은 `extends Payment`으로 `id`와 `amount` 컬럼을 상속받지만, 각 자식마다 고유한 테이블을 갖게 돼요. `@Entity()` 데코레이터에 명시적인 이름을 지정하지 않으면 클래스 이름에서 테이블 이름을 유도해요: `CreditCardPayment`는 `credit_card_payment`이 돼요. 커스텀 테이블 이름이 필요하면 명시적으로 전달하면 돼요: `@Entity({ name: "cc_payments" })`.

> **힌트** `@DiscriminatorColumn` 데코레이터는 선택 사항이에요. 생략하면 기본적으로 `"dtype"`이라는 이름의 `VARCHAR(31)` 타입 컬럼이 만들어져요.

설정에서 모든 엔티티(루트와 모든 자식)를 등록해야 해요:

```typescript
await em.register({
  type: "postgres",
  entities: [Payment, CreditCardPayment, BankTransferPayment],
  synchronize: true,
});
```

ORM은 루트 테이블을 먼저 만들고, 자식 테이블을 만든 다음, 각 자식의 `id`에서 루트의 `id`로의 외래 키 제약 조건을 추가해요.

## 3. INSERT -- 2단계 삽입

자식 엔티티를 저장하면 ORM이 데이터를 두 테이블에 나누어 두 개의 INSERT 문으로 실행해요.

```typescript
const cc = await em.save(CreditCardPayment, {
  amount: 100,
  cardNumber: "4111-1111-1111-1111",
});
```

**생성된 SQL (PostgreSQL):**

```sql
-- Phase 1: 루트 테이블에 삽입 (공유 컬럼 + discriminator)
INSERT INTO "payment" ("amount", "payment_type")
VALUES (100, 'credit_card')
RETURNING *;

-- Phase 2: 자식 테이블에 삽입 (고유 컬럼 + 동일한 PK)
INSERT INTO "credit_card_payment" ("id", "cardNumber")
VALUES (1, '4111-1111-1111-1111');
```

**Phase 1 raw 결과:**

| id | amount | payment_type |
|----|--------|-------------|
| 1  | 100    | credit_card |

**Phase 2:** 결과 행이 없어요 (자식 테이블 INSERT는 `RETURNING`을 사용하지 않아요).

**역직렬화된 TypeScript 객체:**

```typescript
{
  id: 1,
  amount: 100,
  cardNumber: "4111-1111-1111-1111"
}
// instanceof CreditCardPayment === true
```

2단계 프로세스를 주목하세요: 먼저 루트 행을 삽입해서 `SERIAL` / `AUTO_INCREMENT`로 `id`를 생성하고, 그다음 동일한 `id`를 기본 키로 하는 자식 행을 삽입해요. ORM이 PK 전달을 자동으로 처리하기 때문에 `id`를 직접 설정할 필요가 없어요.

계좌이체도 추가로 삽입해볼게요:

```typescript
const bt = await em.save(BankTransferPayment, {
  amount: 250,
  bankCode: "SWIFT-ABCD",
});
```

**생성된 SQL (PostgreSQL):**

```sql
INSERT INTO "payment" ("amount", "payment_type")
VALUES (250, 'bank_transfer')
RETURNING *;

INSERT INTO "bank_transfer_payment" ("id", "bankCode")
VALUES (2, 'SWIFT-ABCD');
```

**역직렬화된 TypeScript 객체:**

```typescript
{
  id: 2,
  amount: 250,
  bankCode: "SWIFT-ABCD"
}
// instanceof BankTransferPayment === true
```

## 4. SELECT -- 자식 엔티티 조회

`em.find()`로 자식 엔티티를 조회하면 ORM이 자동으로 자식 테이블과 루트 테이블을 JOIN해서 완전한 엔티티를 조립해요.

```typescript
const cards = await em.find(CreditCardPayment, {});
```

**생성된 SQL (PostgreSQL):**

```sql
SELECT "credit_card_payment"."id",
       "credit_card_payment"."cardNumber",
       "payment"."amount"
FROM "credit_card_payment"
INNER JOIN "payment"
  ON "credit_card_payment"."id" = "payment"."id";
```

ORM이 LEFT JOIN이 아니라 INNER JOIN을 사용하는 것을 주목하세요. 모든 자식 행에는 반드시 대응하는 루트 행이 있어야 하고(FK 제약 조건으로 보장돼요), 그래서 INNER JOIN이 정확하면서도 약간 더 빨라요.

**Raw SQL 결과 행:**

| id | cardNumber         | amount |
|----|--------------------|--------|
| 1  | 4111-1111-1111-1111 | 100    |

**역직렬화된 TypeScript 객체:**

```typescript
[
  {
    id: 1,
    amount: 100,
    cardNumber: "4111-1111-1111-1111"
  }
]
// cards[0] instanceof CreditCardPayment === true
```

결과가 두 테이블의 컬럼을 하나의 플랫 객체로 합쳐주는 것을 주목하세요. `amount` 컬럼은 루트 테이블에서 오고, `cardNumber`는 자식 테이블에서 와요. ORM이 이것을 투명하게 합쳐줘요.

## 5. SELECT -- 다형성 쿼리 (루트 엔티티)

루트 엔티티를 조회하면 모든 결제 타입을 반환하고, 각 행은 올바른 서브클래스로 역직렬화돼요.

```typescript
const all = await em.find(Payment, {});

console.log(JSON.stringify(all, null, 2));
```

**생성된 SQL (PostgreSQL):**

```sql
SELECT "payment"."id",
       "payment"."amount",
       "payment"."payment_type",
       "credit_card_payment"."cardNumber" AS "credit_card_payment_cardNumber",
       "bank_transfer_payment"."bankCode" AS "bank_transfer_payment_bankCode"
FROM "payment"
LEFT JOIN "credit_card_payment"
  ON "payment"."id" = "credit_card_payment"."id"
LEFT JOIN "bank_transfer_payment"
  ON "payment"."id" = "bank_transfer_payment"."id";
```

ORM이 다형성 쿼리에서 LEFT JOIN을 사용하는 것을 주목하세요. 신용카드 결제 행은 `bank_transfer_payment_bankCode = NULL`이 되고, 그 반대도 마찬가지예요. 자식 컬럼에 테이블 이름이 접두사로 붙어요(예: `credit_card_payment_cardNumber`). 여러 자식 테이블에 같은 이름의 컬럼이 있을 때 충돌을 피하기 위해서예요.

**Raw SQL 결과 행:**

| id | amount | payment_type  | credit_card_payment_cardNumber | bank_transfer_payment_bankCode |
|----|--------|---------------|-------------------------------|-------------------------------|
| 1  | 100    | credit_card   | 4111-1111-1111-1111           | NULL                          |
| 2  | 250    | bank_transfer | NULL                          | SWIFT-ABCD                    |

**역직렬화된 TypeScript 객체:**

```typescript
[
  {
    id: 1,
    amount: 100,
    cardNumber: "4111-1111-1111-1111"
  },
  // ^ instanceof CreditCardPayment === true

  {
    id: 2,
    amount: 250,
    bankCode: "SWIFT-ABCD"
  }
  // ^ instanceof BankTransferPayment === true
]
```

**`console.log(JSON.stringify(all, null, 2))` 출력:**

```json
[
  {
    "id": 1,
    "amount": 100,
    "cardNumber": "4111-1111-1111-1111"
  },
  {
    "id": 2,
    "amount": 250,
    "bankCode": "SWIFT-ABCD"
  }
]
```

`ResultTransformer.toTPTPolymorphicEntities()` 메서드가 이 역직렬화를 처리해요. 각 행에 대해 다음 과정을 거쳐요:

1. `payment_type` discriminator 값을 읽어요
2. discriminator 맵에서 올바른 TypeScript 클래스를 찾아요
3. 매칭되는 자식 컬럼에서 테이블 이름 접두사를 제거해요 (예: `credit_card_payment_cardNumber`가 `cardNumber`로 돼요)
4. 다른 자식 타입에 속하는 접두사 컬럼을 버려요 (예: `credit_card` 타입 행일 때 `bank_transfer_payment_bankCode`를 제거해요)
5. 평탄화된 행 데이터로 올바른 클래스를 인스턴스화해요

## 6. SELECT -- 관계와 함께

루트 엔티티에 정의된 관계는 모든 자식에 상속돼요. 루트 `Payment` 엔티티에 `@ManyToOne` 관계가 있는 예제를 살펴볼게요.

```typescript
@Entity()
export class Store {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  name!: string;

  @OneToMany(() => Payment, { mappedBy: "store" })
  payments!: Payment[];
}

@Entity()
@Inheritance({ strategy: "JOINED" })
@DiscriminatorColumn({ name: "payment_type", type: "varchar", length: 50 })
export class Payment {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  amount!: number;

  @Column({ type: "int", nullable: true })
  storeFk!: number;

  @ManyToOne(() => Store, (s) => s.payments, { joinColumn: "storeFk" })
  store!: Store;
}
```

`store` 관계와 함께 자식 엔티티를 로드해볼게요:

```typescript
const cards = await em.find(CreditCardPayment, {
  relations: ["store"],
});
```

**생성된 SQL (PostgreSQL):**

```sql
SELECT "credit_card_payment"."id",
       "credit_card_payment"."cardNumber",
       "payment"."amount",
       "payment"."storeFk",
       "store"."id"   AS "store_id",
       "store"."name" AS "store_name"
FROM "credit_card_payment"
INNER JOIN "payment"
  ON "credit_card_payment"."id" = "payment"."id"
LEFT JOIN "store"
  ON "payment"."storeFk" = "store"."id";
```

FK 컬럼(`storeFk`)이 자식 테이블이 아니라 루트 테이블(`payment`)에 있는 것을 주목하세요. ORM이 자동으로 올바른 테이블로 한정해요: `"credit_card_payment"."storeFk"` 대신 `"payment"."storeFk"`로요. 이것은 투명하게 처리되기 때문에 어떤 테이블에 컬럼이 속하는지 직접 지정할 필요가 없어요.

**Raw SQL 결과 행:**

| id | cardNumber          | amount | storeFk | store_id | store_name      |
|----|---------------------|--------|---------|----------|-----------------|
| 1  | 4111-1111-1111-1111 | 100    | 1       | 1        | Electronics Hub |

**역직렬화된 TypeScript 객체:**

```typescript
[
  {
    id: 1,
    amount: 100,
    cardNumber: "4111-1111-1111-1111",
    storeFk: 1,
    store: {
      id: 1,
      name: "Electronics Hub"
    }
  }
]
```

::: tip
TPT에서 루트 엔티티에 정의된 FK 컬럼은 루트 테이블에 저장돼요. ORM이 JOIN 쿼리를 빌드할 때 자동으로 FK 컬럼을 올바른 테이블로 한정하기 때문에 어떤 테이블이 어떤 컬럼을 소유하는지 신경 쓸 필요가 없어요.
:::

## 7. SELECT -- findOne 사용

`findOne`은 `find`와 동일하게 동작하지만 단일 엔티티 또는 `null`을 반환해요.

```typescript
const cc = await em.findOne(CreditCardPayment, {
  where: { id: 1 },
});
```

**생성된 SQL (PostgreSQL):**

```sql
SELECT "credit_card_payment"."id",
       "credit_card_payment"."cardNumber",
       "payment"."amount"
FROM "credit_card_payment"
INNER JOIN "payment"
  ON "credit_card_payment"."id" = "payment"."id"
WHERE "credit_card_payment"."id" = 1
LIMIT 1;
```

WHERE 절이 `id`를 자식 테이블(`credit_card_payment`)로 한정하고, `findOne`은 최대 하나의 결과를 기대하기 때문에 `LIMIT 1`이 포함되는 것을 주목하세요.

**Raw SQL 결과 행:**

| id | cardNumber          | amount |
|----|---------------------|--------|
| 1  | 4111-1111-1111-1111 | 100    |

**역직렬화된 TypeScript 객체:**

```typescript
{
  id: 1,
  amount: 100,
  cardNumber: "4111-1111-1111-1111"
}
// cc instanceof CreditCardPayment === true
// cc is CreditCardPayment | null
```

WHERE 조건에서 루트 컬럼과 자식 컬럼 모두 참조할 수 있어요. ORM이 각 컬럼을 올바른 테이블로 자동 라우팅해요:

```typescript
const expensive = await em.find(CreditCardPayment, {
  where: { amount: 100 },   // "amount"는 루트 컬럼 -> "payment"."amount"로 한정
});
```

**생성된 SQL (PostgreSQL):**

```sql
SELECT "credit_card_payment"."id",
       "credit_card_payment"."cardNumber",
       "payment"."amount"
FROM "credit_card_payment"
INNER JOIN "payment"
  ON "credit_card_payment"."id" = "payment"."id"
WHERE "payment"."amount" = 100;
```

## 8. SELECT -- QueryBuilder 사용

`SelectQueryBuilder`는 TPT 상속 로직을 **자동으로 적용**해요. `em.createQueryBuilder()`로 자식 엔티티를 사용하면 부모 테이블이 자동으로 JOIN되고, 부모 + 자식 컬럼을 결합한 명시적 SELECT 리스트가 빌드돼요. 루트 엔티티를 조회하면 모든 자식 테이블에 LEFT JOIN하고 polymorphic 역직렬화가 올바른 서브클래스 인스턴스를 반환해요.

**자식 엔티티 쿼리:**

```typescript
const cards = await em
  .createQueryBuilder(CreditCardPayment, "cc")
  .where("amount", 100)
  .getMany();
```

**생성된 SQL (PostgreSQL):**

```sql
SELECT "cc"."id", "cc"."cardNumber", "payment"."amount"
FROM "credit_card_payment" AS "cc"
INNER JOIN "payment"
  ON "cc"."id" = "payment"."id"
WHERE "payment"."amount" = $1;
```

부모 테이블 JOIN과 컬럼 라우팅이 자동으로 처리돼요 -- `amount` 같은 루트 컬럼은 부모 테이블(`"payment"."amount"`)로, 자식 컬럼은 자식 테이블로 한정돼요.

**역직렬화된 결과:**

```typescript
[
  CreditCardPayment { id: 1, amount: 100, cardNumber: "4111-1111-1111-1111" }
]
```

**Polymorphic 루트 엔티티 쿼리:**

```typescript
const all = await em
  .createQueryBuilder(Payment, "p")
  .getMany();
```

**생성된 SQL (PostgreSQL):**

```sql
SELECT "p"."id", "p"."amount", "p"."payment_type",
       "credit_card_payment"."cardNumber" AS "credit_card_payment_cardNumber",
       "bank_transfer_payment"."bankCode" AS "bank_transfer_payment_bankCode"
FROM "payment" AS "p"
LEFT JOIN "credit_card_payment"
  ON "p"."id" = "credit_card_payment"."id"
LEFT JOIN "bank_transfer_payment"
  ON "p"."id" = "bank_transfer_payment"."id";
```

**역직렬화된 결과:**

```typescript
[
  CreditCardPayment  { id: 1, amount: 100, cardNumber: "4111-1111-1111-1111" },
  BankTransferPayment { id: 2, amount: 250, bankCode: "SWIFT-ABCD" }
]
// 각 요소가 올바른 서브클래스 인스턴스예요.
// 자식 컬럼 접두사(예: credit_card_payment_cardNumber)가 자동으로 제거돼요.
```

`ResultTransformer.toTPTPolymorphicEntities()` 메서드가 접두사 제거와 서브클래스 인스턴스화를 처리해요. `em.find()`와 동일한 방식이에요. 모든 QueryBuilder 메서드(`getMany()`, `getOne()`, `getCount()`, `exists()`)가 TPT polymorphic 역직렬화를 지원해요.

## 9. SELECT -- WriteBuffer와 함께

WriteBuffer 플러그인(Unit of Work)은 TPT 상속을 투명하게 지원해요. 모든 쿼리가 EntityManager에 위임되기 때문에 TPT JOIN과 2단계 쓰기가 자동으로 처리돼요.

```typescript
import { bufferPlugin } from "@stingerloom/orm";

em.extend(bufferPlugin());
const buf = em.buffer();

// find는 투명하게 동작해요 -- 동일한 INNER JOIN을 생성해요
const cards = await buf.find(CreditCardPayment, {});

// findOne + 다형성 루트 쿼리
const all = await buf.find(Payment, {});

console.log(JSON.stringify(all, null, 2));
// 출력:
// [
//   {
//     "id": 1,
//     "amount": 100,
//     "cardNumber": "4111-1111-1111-1111"
//   },
//   {
//     "id": 2,
//     "amount": 250,
//     "bankCode": "SWIFT-ABCD"
//   }
// ]

all.forEach((p) => {
  if (p instanceof CreditCardPayment) {
    console.log(p.cardNumber);
  }
});

// Dirty tracking은 루트 필드와 자식 필드 모두에서 동작해요
const cc = await buf.findOne(CreditCardPayment, { where: { id: 1 } });
if (cc) {
  cc.amount = 500;       // 루트 필드
  cc.cardNumber = "9999"; // 자식 필드
}
const result = await buf.flush();
console.log(result.updates); // 1
```

**`buf.find(CreditCardPayment, {})`의 역직렬화된 결과:**

```typescript
[
  {
    id: 1,
    amount: 100,
    cardNumber: "4111-1111-1111-1111"
  }
]
```

## 10. UPDATE -- 테이블 간 분리

TPT 자식 엔티티를 업데이트하면 ORM이 변경 사항을 두 개의 UPDATE 문으로 분리해요: 루트 테이블 컬럼용 하나, 자식 테이블 컬럼용 하나.

```typescript
const cc = await em.findOne(CreditCardPayment, { where: { id: 1 } });

cc.amount = 200;                      // 루트 컬럼
cc.cardNumber = "5555-5555-5555-5555"; // 자식 컬럼

await em.save(CreditCardPayment, cc);
```

**생성된 SQL (PostgreSQL):**

```sql
-- Phase 1: 루트 테이블 업데이트 (공유 컬럼)
UPDATE "payment"
SET "amount" = 200
WHERE "id" = 1;

-- Phase 2: 자식 테이블 업데이트 (고유 컬럼)
UPDATE "credit_card_payment"
SET "cardNumber" = '5555-5555-5555-5555'
WHERE "id" = 1;
```

**저장 후 역직렬화된 TypeScript 객체:**

```typescript
{
  id: 1,
  amount: 200,
  cardNumber: "5555-5555-5555-5555"
}
```

ORM이 각 컬럼을 올바른 테이블로 지능적으로 라우팅하는 것을 주목하세요. 루트 컬럼(예: `amount`)만 변경하면 루트 테이블 UPDATE만 실행돼요. 자식 컬럼만 변경하면 자식 테이블 UPDATE만 실행돼요. ORM은 빈 UPDATE 문을 건너뛰어요.

> **힌트** `@UpdateTimestamp`와 `@Version` 필드는 루트 테이블의 UPDATE 문으로 라우팅돼요. 이러한 메타데이터 컬럼은 보통 루트 엔티티에 정의되기 때문이에요.

## 11. DELETE -- 2단계 삭제

TPT 자식 엔티티를 삭제하려면 특정 순서로 두 개의 DELETE 문이 필요해요.

```typescript
await em.delete(CreditCardPayment, { id: 1 });
```

**생성된 SQL (PostgreSQL):**

```sql
-- Phase 1: 자식 테이블에서 먼저 삭제
DELETE FROM "credit_card_payment" WHERE "id" = 1;

-- Phase 2: 루트 테이블에서 나중에 삭제
DELETE FROM "payment" WHERE "id" = 1;
```

**반환값:**

```typescript
{ affected: 1 }
```

순서를 주목하세요: 자식 먼저, 그다음 루트. 자식 테이블의 `id` 컬럼이 루트 테이블을 참조하는 외래 키 제약 조건을 갖고 있기 때문에 이 순서가 필수적이에요. 루트 행을 먼저 삭제하면 FK 제약 조건이 위반돼요. ORM이 이 순서를 자동으로 처리해요.

::: warning
루트 엔티티에서 직접 삭제하면(`em.delete(Payment, { id: 1 })`), 루트 테이블 행만 삭제돼요. FK 제약 조건이 `NO ACTION`을 사용하면 자식 테이블 행이 고아(orphan)가 돼요. 고아를 피하려면 항상 자식 엔티티 클래스를 사용해서 삭제하거나, 자식 테이블의 FK 제약 조건에 `ON DELETE CASCADE`를 설정하세요.
:::

## 12. 장단점

| 장점 | 단점 |
|------|------|
| 정규화된 스키마 -- 낭비되는 NULL 컬럼이 없어요 | 모든 쿼리에 JOIN(루트 + 자식)이 필요해요 |
| 자식 컬럼에 NOT NULL 제약 조건을 걸 수 있어요 | INSERT에 두 개의 문이 필요해요(루트 + 자식) |
| 자식 타입이 많아도 잘 확장돼요 | DELETE에 두 개의 문이 필요해요(자식 + 루트) |
| 타입별로 깔끔하게 관심사가 분리돼요 | 다형성 쿼리에 N개의 LEFT JOIN이 필요해요 |
| 자식 타입을 추가해도 기존 테이블을 변경하지 않아요 | STI보다 약간 더 복잡한 스키마예요 |
| 자식 수에 관계없이 루트 테이블이 좁게 유지돼요 | WHERE 절이 올바른 테이블로 라우팅되어야 해요 |

## 13. 언제 TPT를 사용할까

다음 경우에 Joined / Table Per Type 상속을 사용하세요:

- **자식 고유 컬럼이 많을 때.** 각 자식 타입이 4개 이상의 컬럼을 추가하면 STI는 수십 개의 대부분 NULL인 컬럼을 가진 테이블을 만들어요. TPT는 각 자식 테이블을 간결하게 유지해요.
- **자식 컬럼의 NOT NULL 제약 조건이 중요할 때.** STI는 모든 자식 고유 컬럼을 nullable로 강제해요. TPT에서는 신용카드 결제의 `cardNumber`에 `NOT NULL`을 강제할 수 있어요.
- **스키마 정규화가 중요할 때.** TPT는 모든 테이블의 모든 컬럼이 해당 테이블의 모든 행에 관련 있는 완전 정규화된 스키마를 생성해요.
- **특정 자식 타입을 자주 조회할 때.** 자식 쿼리의 INNER JOIN은 빠르고 예측 가능해요.
- **가끔 다형성 쿼리가 필요할 때.** LEFT JOIN 방식은 STI의 단일 테이블 스캔보다는 느리지만 TPC의 UNION ALL보다는 빨라요.

다음 경우에는 TPT를 피하세요:

- **다형성 쿼리가 주요 접근 패턴일 때.** 대부분의 쿼리가 모든 결제 타입을 가져온다면 N개의 LEFT JOIN이 오버헤드를 더해요. 이 경우 STI를 고려하세요.
- **자식 고유 컬럼이 매우 적을 때.** 각 자식이 1-2개 컬럼만 추가한다면 STI가 더 단순하고 빨라요.
- **최대 INSERT/DELETE 성능이 필요할 때.** 2단계 쓰기가 지연을 추가해요. 다형성 읽기가 드문 쓰기 집중 워크로드에서는 TPC를 고려하세요.

## 14. 다음 단계

- [상속 매핑](./inheritance-mapping) -- 세 가지 전략(STI, TPT, TPC) 개요
- [관계](./relations) -- @ManyToOne, @OneToMany, @ManyToMany, @OneToOne
- [EntityManager](./entity-manager) -- find, save, delete, 집계, 페이지네이션
- [Write Buffer](./write-buffer) -- Unit of Work 패턴과 dirty tracking
- [Query Builder](./query-builder) -- JOIN, GROUP BY, 서브쿼리를 활용한 복잡한 SQL
