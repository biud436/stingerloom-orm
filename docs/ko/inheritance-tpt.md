# Joined / Table Per Type Inheritance (TPT) -- 심층 가이드

Joined 상속은 공유 컬럼을 루트 테이블에 저장하고 자식 고유 컬럼을 자식마다 별도의 테이블에 저장하는 전략입니다. Table Per Type, 줄여서 TPT라고도 부릅니다. 자식 테이블은 기본 키에 건 외래 키로 루트 테이블과 연결됩니다. 가족이 거실은 함께 쓰고 침실은 각자 따로 쓰는 집과 비슷합니다. 거실이 루트 테이블이고 침실이 자식 테이블입니다. 한 사람의 모든 것을 알려면 두 방을 모두 둘러봐야 합니다. 이 과정이 JOIN입니다.

## 1. 스키마

이 계층 구조는 테이블 세 개를 사용합니다. 루트 테이블(`payment`) 하나와 자식 타입마다 테이블 하나입니다.

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

눈여겨볼 점은 세 가지입니다.

1. 루트 테이블(`payment`)은 공유 컬럼(`id`, `amount`)과 구분 컬럼(discriminator column)인 `payment_type`만 가집니다.
2. 각 자식 테이블의 기본 키는 루트 테이블의 `id`를 참조하는 외래 키이기도 합니다. 그래서 모든 자식 행에는 대응하는 루트 행이 반드시 있습니다.
3. 자식 컬럼에 NOT NULL 제약 조건을 걸 수 있습니다. Single Table Inheritance와 달리 자식 테이블에는 다른 타입의 행이 없습니다. 그래서 데이터베이스가 자식 고유 필드에 제약 조건을 강제할 수 있습니다.

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

자식은 `extends Payment`로 `id`와 `amount` 컬럼을 상속받습니다. 하지만 테이블은 자식마다 따로 가집니다. `@Entity()`에 `name`을 지정하지 않으면 테이블 이름은 클래스 이름에서 만들어집니다. 예를 들어 `CreditCardPayment`는 `credit_card_payment`가 됩니다. 다른 테이블 이름을 쓰려면 이름을 직접 넘기세요: `@Entity({ name: "cc_payments" })`.

> 힌트: `@DiscriminatorColumn` 데코레이터는 선택 사항입니다. 생략하면 `VARCHAR(31)` 타입의 `"dtype"` 컬럼이 기본으로 생성됩니다.

설정에는 루트와 모든 자식을 포함해 엔티티를 모두 등록해야 합니다.

```typescript
await em.register({
  type: "postgres",
  entities: [Payment, CreditCardPayment, BankTransferPayment],
  synchronize: true,
});
```

ORM은 루트 테이블을 먼저 생성하고 그다음 자식 테이블을 생성합니다. 마지막으로 각 자식의 `id`가 루트의 `id`를 참조하는 외래 키 제약 조건을 추가합니다.

## 3. INSERT -- 2단계 삽입

자식 엔티티를 저장하면 ORM은 데이터를 두 테이블로 나눠 INSERT 문 두 개를 실행합니다.

```typescript
const cc = await em.save(CreditCardPayment, {
  amount: 100,
  cardNumber: "4111-1111-1111-1111",
});
```

**생성된 SQL (PostgreSQL):**

```sql
-- Phase 1: 루트 테이블에 삽입 (공유 컬럼 + 구분 컬럼)
INSERT INTO "payment" ("amount", "payment_type")
VALUES (100, 'credit_card')
RETURNING *;

-- Phase 2: 자식 테이블에 삽입 (고유 컬럼 + 같은 기본 키)
INSERT INTO "credit_card_payment" ("id", "cardNumber")
VALUES (1, '4111-1111-1111-1111');
```

**Phase 1 raw 결과:**

| id | amount | payment_type |
|----|--------|-------------|
| 1  | 100    | credit_card |

Phase 2에는 결과 행이 없습니다. 자식 테이블 INSERT는 `RETURNING`을 사용하지 않기 때문입니다.

**역직렬화된 TypeScript 객체:**

```typescript
{
  id: 1,
  amount: 100,
  cardNumber: "4111-1111-1111-1111"
}
// instanceof CreditCardPayment === true
```

삽입은 두 단계로 진행됩니다. 먼저 루트 행을 삽입해서 `SERIAL`이나 `AUTO_INCREMENT`로 `id`를 생성합니다. 그다음 같은 `id`를 기본 키로 하는 자식 행을 삽입합니다. 기본 키는 ORM이 자동으로 넘기므로 `id`를 직접 설정할 필요가 없습니다.

계좌이체 결제도 하나 삽입합니다.

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

`em.find()`로 자식 엔티티를 조회하면 ORM이 자동으로 자식 테이블과 루트 테이블을 JOIN해서 완전한 엔티티를 만듭니다.

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

ORM은 LEFT JOIN이 아니라 INNER JOIN을 사용합니다. 모든 자식 행에는 대응하는 루트 행이 반드시 있기 때문입니다. 이 사실은 외래 키 제약 조건이 보장합니다. 그래서 INNER JOIN은 결과가 정확하면서도 조금 더 빠릅니다.

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

결과 객체 하나에 두 테이블의 컬럼이 합쳐집니다. `amount` 컬럼은 루트 테이블에서 오고 `cardNumber`는 자식 테이블에서 옵니다. 이 병합은 ORM이 자동으로 처리합니다.

자식을 조회하는 다른 메서드도 같은 JOIN을 거칩니다. 그래서 조건, 집계 필드, 정렬 컬럼에 상속받은 컬럼을 써도 됩니다. `count()`, `exists()`, `sum()`, `avg()`, `min()`, `max()`, `findWithCursor()`는 조인한 행을 파생 테이블 하나로 읽습니다. 그러므로 `findAndCount()`와 `findWithPage()`의 총계도 같은 방식으로 계산됩니다.

```typescript
await em.count(CreditCardPayment, { amount: { gte: 100 } });
```

```sql
SELECT COUNT(*) AS "result"
FROM (SELECT "credit_card_payment"."id", "credit_card_payment"."cardNumber",
             "payment"."amount", "payment"."payment_type"
      FROM "credit_card_payment" AS "credit_card_payment"
      INNER JOIN "payment" AS "payment" ON "credit_card_payment"."id" = "payment"."id") AS "_tpt"
WHERE "amount" >= 100;
```

루트에 선언한 `@DeletedAt` 조건도 이 모든 읽기에서 루트 테이블을 기준으로 적용됩니다. `withDeleted`와 `onlyDeleted`는 다른 엔티티와 똑같이 동작합니다.

## 5. SELECT -- 다형성 쿼리 (루트 엔티티)

루트 엔티티를 조회하면 모든 결제 타입을 반환합니다. 각 행은 알맞은 서브클래스로 역직렬화됩니다.

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

다형성 쿼리에서 ORM은 LEFT JOIN을 사용합니다. 그래서 신용카드 결제 행에서는 `bank_transfer_payment_bankCode`가 NULL이고 계좌이체 결제 행에서는 그 반대입니다. 자식 컬럼에는 테이블 이름이 접두사로 붙습니다(예: `credit_card_payment_cardNumber`). 여러 자식 테이블에 같은 이름의 컬럼이 있을 때 충돌을 피하려는 것입니다.

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

이 역직렬화는 `ResultTransformer.toTPTPolymorphicEntities()` 메서드가 처리합니다. 각 행은 다음 과정을 거칩니다.

1. `payment_type`의 구분 값을 읽습니다.
2. 구분 값 맵에서 알맞은 TypeScript 클래스를 찾습니다.
3. 매칭되는 자식 컬럼에서 테이블 이름 접두사를 제거합니다. 예를 들어 `credit_card_payment_cardNumber`는 `cardNumber`가 됩니다.
4. 다른 자식 타입에 속하는 접두사 컬럼은 버립니다. 예를 들어 `credit_card` 타입 행에서는 `bank_transfer_payment_bankCode`를 제거합니다.
5. 평탄화한 행 데이터로 알맞은 클래스의 인스턴스를 만듭니다.

`findWithCursor(Payment)`도 같은 행을 페이지로 나눕니다. 이때 이 SELECT를 파생 테이블로 읽습니다. 그리고 페이지의 각 행은 자기 서브클래스로 반환됩니다.

### 서브클래스 컬럼으로 거르기

루트를 조회할 때 `where`, `orderBy`, `groupBy`, `select`, 집계에 서브클래스의 컬럼을 쓸 수 있습니다. 속성 이름과 컬럼 이름 중 어느 쪽으로 적어도 됩니다. 그 컬럼은 컬럼을 가진 서브클래스 테이블에서 읽습니다. 그래서 다른 서브클래스의 행에서는 NULL로 읽힙니다.

```typescript
const cards = await em.find(Payment, { where: { cardNumber: { startsWith: "4111" } } });
// [CreditCardPayment { id: 1, amount: 100, cardNumber: "4111-1111-1111-1111" }]
```

```sql
SELECT ... FROM "payment"
LEFT JOIN "credit_card_payment" ON "payment"."id" = "credit_card_payment"."id"
LEFT JOIN "bank_transfer_payment" ON "payment"."id" = "bank_transfer_payment"."id"
WHERE "credit_card_payment"."cardNumber" LIKE $1
```

여러 서브클래스가 같은 이름으로 선언한 컬럼은 그 행을 가진 테이블에서 읽습니다: `COALESCE("credit_card_payment"."fee", "bank_transfer_payment"."fee")`. 다음 경로도 같은 방식으로 동작합니다.

- `count()`, `exists()`, `sum()` 같은 집계. 서브클래스 테이블은 이런 컬럼을 쓸 때만 조인합니다.
- `findWithCursor()`
- 쿼리 빌더(`where("p.cardNumber", ...)`)
- 루트를 대상으로 하는 관계의 `where`, `orderBy`, `withCount`와 관계 필터(`some`, `none` 등)

커서 페이지는 서브클래스 하나만 선언한 컬럼으로 정렬할 수 있습니다. 여러 서브클래스가 선언한 컬럼에는 모든 행을 담은 단일 컬럼이 없습니다. 그래서 이런 컬럼을 정렬 기준으로 쓰면 거부됩니다. 루트에 대한 쓰기(`delete()`, `updateMany()`)는 여전히 루트 컬럼만 받습니다.

## 6. SELECT -- 관계와 함께

루트 엔티티에 정의한 관계는 모든 자식이 상속합니다. 아래는 루트 `Payment` 엔티티에 `@ManyToOne` 관계가 있는 예제입니다.

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

  @ManyToOne(() => Store, (s) => s.payments)
  @RelationColumn({ name: "storeFk" })
  store!: Store;
}
```

`store` 관계와 함께 자식 엔티티를 로드합니다.

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
       "store"."id"   AS "store__id",
       "store"."name" AS "store__name"
FROM "credit_card_payment"
INNER JOIN "payment"
  ON "credit_card_payment"."id" = "payment"."id"
LEFT JOIN "store"
  ON "payment"."storeFk" = "store"."id";
```

외래 키 컬럼(`storeFk`)은 자식 테이블이 아니라 루트 테이블(`payment`)에 있습니다. ORM은 이 컬럼을 알맞은 테이블로 자동으로 한정합니다. 그래서 `"credit_card_payment"."storeFk"`가 아니라 `"payment"."storeFk"`가 됩니다. 컬럼이 어느 테이블에 속하는지 직접 지정할 필요는 없습니다.

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
TPT에서 루트 엔티티에 정의한 외래 키 컬럼은 루트 테이블에 저장됩니다. ORM은 JOIN 쿼리를 만들 때 외래 키 컬럼을 알맞은 테이블로 자동으로 한정합니다. 그래서 어느 테이블이 어느 컬럼을 가지는지 신경 쓸 필요가 없습니다.
:::

루트를 다형성으로 조회할 때도 관계를 로드할 수 있습니다. 이때도 각 행은 자기 서브클래스로 반환됩니다. `em.find(Payment, { relations: ["store"] })`는 `store`가 채워진 `CreditCardPayment` 인스턴스와 `BankTransferPayment` 인스턴스를 반환합니다.

### 서브클래스가 선언한 관계

자식은 상속받은 관계 외에 자기만의 관계를 선언할 수 있습니다. 그 관계의 조인 컬럼과 외래 키는 자식 테이블에 놓입니다. 루트의 관계는 계속 루트 테이블에 조인 컬럼을 둡니다. 조인 컬럼에 별도의 `@Column`은 필요하지 않습니다. `@RelationColumn({ name })`만으로 충분합니다. `save()`와 조회는 그 컬럼이 있는 테이블을 자동으로 사용합니다.

```typescript
@Entity()
@DiscriminatorValue("credit_card")
export class CreditCardPayment extends Payment {
  @Column()
  cardNumber!: string;

  @ManyToOne(() => Bank, (b) => b.cards)
  @RelationColumn({ name: "issuer_id" })
  issuer!: Bank; // credit_card_payment.issuer_id
}

const cards = await em.find(CreditCardPayment, {
  relations: ["store", "issuer"], // payment.storeFk, credit_card_payment.issuer_id
});
```

### 자식을 대상으로 하는 관계

다른 엔티티의 관계가 자식을 가리키는 경우도 있습니다. `CreditCardPayment` 타입의 `Refund.payment`, `Bank.cards`, 카드 결제의 ManyToMany가 그 예입니다. 자식의 행은 자기 테이블과 루트 테이블에 나뉘어 있습니다. 그래서 관계를 읽는 모든 경로가 `find(CreditCardPayment)`처럼 자식 테이블을 루트 테이블과 조인해서 읽습니다. 해당하는 경로는 다음과 같습니다.

- ManyToOne과 소유 측 OneToOne의 JOIN
- OneToMany, ManyToMany, 역방향 측 OneToOne의 배치 읽기
- 커서 페이지의 to-one 읽기
- 쿼리 빌더의 관계 조인

상속 컬럼도 함께 읽힙니다. 그 컬럼은 관계의 `where`, `orderBy`, `take`와 조인 별칭에 거는 쿼리 빌더 `where("p.amount", ...)`에서 쓸 수 있습니다.

```sql
LEFT JOIN (SELECT "credit_card_payment"."id", "credit_card_payment"."cardNumber", "payment"."amount", ...
           FROM "credit_card_payment" AS "credit_card_payment"
           INNER JOIN "payment" AS "payment" ON "credit_card_payment"."id" = "payment"."id") AS "payment"
  ON "refund"."payment_id" = "payment"."id"
```

### 루트를 대상으로 하는 관계

루트 타입의 관계는 어느 서브클래스의 행이든 가리킬 수 있습니다. `Payment` 타입의 `Refund.payment`가 그 예입니다. 그리고 그 서브클래스 고유의 컬럼은 서브클래스 테이블에 있습니다. 그래서 이 관계를 읽을 때는 `find(Payment)`처럼 루트 테이블을 모든 자식 테이블과 조인합니다. 그리고 각 행을 구분 값이 가리키는 서브클래스로 만듭니다. `refund.payment`는 `cardNumber`를 가진 `CreditCardPayment`이거나 `bankCode`를 가진 `BankTransferPayment`가 됩니다. 이 방식은 위에 나온 경로 모두에 적용되고 쿼리 빌더의 `leftJoinRelationAndSelect()`에도 적용됩니다. 필터링만 하는 쿼리 빌더 조인(`leftJoinRelation()`)은 루트 테이블만 읽습니다.

```sql
LEFT JOIN (SELECT "payment"."id", "payment"."amount", "payment"."dtype", ...,
                  "credit_card_payment"."cardNumber" AS "credit_card_payment_cardNumber",
                  "bank_transfer_payment"."bankCode" AS "bank_transfer_payment_bankCode"
           FROM "payment" AS "payment"
           LEFT JOIN "credit_card_payment" AS "credit_card_payment" ON "payment"."id" = "credit_card_payment"."id"
           LEFT JOIN "bank_transfer_payment" AS "bank_transfer_payment" ON "payment"."id" = "bank_transfer_payment"."id") AS "payment"
  ON "refund"."payment_id" = "payment"."id"
```

## 7. SELECT -- findOne 사용

`findOne`은 `find`와 똑같이 동작합니다. 다만 엔티티 하나나 `null`을 반환합니다.

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

WHERE 절은 `id`를 자식 테이블(`credit_card_payment`)로 한정합니다. 그리고 `findOne`은 결과를 최대 하나만 기대하므로 `LIMIT 1`이 붙습니다.

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

WHERE 조건에서는 루트 컬럼과 자식 컬럼을 모두 참조할 수 있습니다. ORM은 각 컬럼을 알맞은 테이블로 자동으로 라우팅합니다.

```typescript
const expensive = await em.find(CreditCardPayment, {
  where: { amount: 100 },   // "amount"는 루트 컬럼이므로 "payment"."amount"로 한정
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

`SelectQueryBuilder`는 TPT 상속 로직을 자동으로 적용합니다. `em.createQueryBuilder()`에 자식 엔티티를 넘기면 부모 테이블이 자동으로 JOIN됩니다. 그리고 부모 컬럼과 자식 컬럼을 합친 명시적 SELECT 목록이 만들어집니다. 루트 엔티티를 조회하면 모든 자식 테이블을 LEFT JOIN합니다. 그리고 다형성 역직렬화로 알맞은 서브클래스 인스턴스를 반환합니다.

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

부모 테이블 JOIN과 컬럼 라우팅은 자동으로 처리됩니다. `amount` 같은 루트 컬럼은 부모 테이블로 한정됩니다(`"payment"."amount"`). 자식 컬럼은 자식 테이블로 한정됩니다.

**역직렬화된 결과:**

```typescript
[
  CreditCardPayment { id: 1, amount: 100, cardNumber: "4111-1111-1111-1111" }
]
```

**다형성 루트 엔티티 쿼리:**

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
// 각 요소는 알맞은 서브클래스의 인스턴스입니다.
// 자식 컬럼 접두사는 자동으로 제거됩니다(예: credit_card_payment_cardNumber).
```

접두사 제거와 서브클래스 인스턴스 생성은 `ResultTransformer.toTPTPolymorphicEntities()` 메서드가 처리합니다. `em.find()`와 같은 방식입니다. 모든 QueryBuilder 메서드(`getMany()`, `getOne()`, `getCount()`, `exists()`)가 TPT 다형성 역직렬화를 지원합니다.

## 9. SELECT -- WriteBuffer와 함께

WriteBuffer 플러그인(Unit of Work)은 TPT 상속을 별도 설정 없이 지원합니다. 모든 쿼리가 EntityManager에 위임되므로 TPT JOIN과 2단계 쓰기가 자동으로 처리됩니다.

```typescript
import { bufferPlugin } from "@stingerloom/orm";

em.extend(bufferPlugin());
const buf = em.buffer();

// find는 별도 처리 없이 동작합니다: 같은 INNER JOIN을 생성합니다
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

// 변경 추적(dirty tracking)은 루트 필드와 자식 필드 모두에서 동작합니다
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

TPT 자식 엔티티를 갱신하면 ORM은 변경 사항을 UPDATE 문 두 개로 나눕니다. 하나는 루트 테이블 컬럼용이고 다른 하나는 자식 테이블 컬럼용입니다.

```typescript
const cc = await em.findOne(CreditCardPayment, { where: { id: 1 } });

cc.amount = 200;                      // 루트 컬럼
cc.cardNumber = "5555-5555-5555-5555"; // 자식 컬럼

await em.save(CreditCardPayment, cc);
```

**생성된 SQL (PostgreSQL):**

```sql
-- Phase 1: 루트 테이블 갱신 (공유 컬럼)
UPDATE "payment"
SET "amount" = 200
WHERE "id" = 1;

-- Phase 2: 자식 테이블 갱신 (고유 컬럼)
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

ORM은 각 컬럼을 알맞은 테이블로 라우팅합니다. `amount` 같은 루트 컬럼만 변경하면 루트 테이블 UPDATE만 실행됩니다. 자식 컬럼만 변경하면 자식 테이블 UPDATE만 실행됩니다. 빈 UPDATE 문은 건너뜁니다.

> 힌트: `@UpdateTimestamp` 필드와 `@Version` 필드는 루트 테이블의 UPDATE 문으로 라우팅됩니다. 이런 메타데이터 컬럼은 보통 루트 엔티티에 정의하기 때문입니다.

### 조건 기반 업데이트

자식에 호출한 `updateMany()`, `update()`, `increment()`, `decrement()`, `softDelete()`, `restore()`는 `delete()`와 같은 경로로 실행됩니다(11절). 먼저 루트를 JOIN해서 조건에 맞는 기본 키를 조회합니다. 그다음 그 키로 각 테이블에 그 테이블의 컬럼 할당만 보냅니다.

```typescript
await em.updateMany(
  CreditCardPayment,
  { amount: 0, cardNumber: "void" },
  { where: { amount: { lt: 10 } }, orderBy: { amount: "ASC" }, limit: 100 },
);
```

**생성된 SQL (PostgreSQL):**

```sql
-- Phase 1: 조건에 맞는 키를 정렬과 제한을 적용해 조회하고 갱신할 행을 잠급니다
SELECT "tpt_root"."id" AS "pk"
FROM "credit_card_payment" AS "tpt_child"
INNER JOIN "payment" AS "tpt_root" ON "tpt_child"."id" = "tpt_root"."id"
WHERE "tpt_root"."amount" < 10
ORDER BY "tpt_root"."amount" ASC LIMIT 100 FOR UPDATE;

-- Phase 2: 루트 컬럼 (@UpdateTimestamp, @Version 증가 포함)
UPDATE "payment" SET "amount" = 0 WHERE "id" IN (4, 9);

-- Phase 3: 자식 컬럼
UPDATE "credit_card_payment" SET "cardNumber" = 'void' WHERE "id" IN (4, 9);
```

- 각 컬럼은 그 컬럼을 가진 테이블로 갑니다. 루트가 선언한 컬럼은 루트 테이블로 갑니다. 여기에는 `@UpdateTimestamp`, `@Version`, `@DeletedAt`, 루트 관계의 조인 컬럼이 포함됩니다. 자식 고유 컬럼은 자식 테이블로 갑니다. 할당이 없는 테이블에는 SQL 문을 보내지 않습니다.
- `affected`는 루트 SQL 문이 실행되면 갱신된 루트 행 수입니다. 루트 SQL 문이 실행되지 않으면 갱신된 자식 행 수입니다.
- 상속받은 컬럼으로 조건을 걸어도 호출한 클래스의 행에만 적용됩니다. 다른 서브클래스의 기본 키는 아무 행에도 매칭되지 않습니다.
- `orderBy`와 `limit`은 키 조회에 적용됩니다. 그래서 어느 테이블의 컬럼이든 쓸 수 있습니다.
- PostgreSQL과 MySQL에서는 키 조회에 `FOR UPDATE`가 붙습니다. 그래서 뒤따르는 SQL 문은 조회한 행에만 정확히 씁니다. SQLite에서는 데이터베이스가 쓰기를 직렬화하므로 잠금 절을 붙이지 않습니다.
- `tenantStrategy: "tenant_column"`에서는 테넌트 조건이 키 조회 단계에서 루트 테이블을 기준으로 걸립니다.

`createUpdateBuilder()`에는 이 방식이 적용되지 않습니다. `where()` 조건이 이미 렌더링된 SQL로 들어오기 때문입니다. 그래서 여전히 자식 테이블에 UPDATE 문 하나를 보냅니다. 그리고 자식 고유 컬럼만 다룰 수 있습니다.

## 11. DELETE -- 키를 먼저 찾고, 자식 테이블부터 삭제

TPT 행은 두 테이블에 나뉘어 있습니다. 그리고 조건은 어느 쪽 컬럼이든 가리킬 수 있습니다. 그래서 ORM은 조건에 맞는 기본 키를 먼저 조회합니다. 그다음 그 키로 자식 테이블과 루트 테이블의 행을 차례로 삭제합니다.

```typescript
await em.delete(CreditCardPayment, { cardNumber: "4111-1111-1111-1111" });
```

**생성된 SQL (PostgreSQL):**

```sql
-- Phase 1: 조건에 맞는 키를 조회합니다. 루트를 조인하고
-- 각 컬럼은 그 컬럼이 있는 테이블로 한정합니다
SELECT "tpt_root"."id" AS "pk"
FROM "credit_card_payment" AS "tpt_child"
INNER JOIN "payment" AS "tpt_root" ON "tpt_child"."id" = "tpt_root"."id"
WHERE "tpt_child"."cardNumber" = '4111-1111-1111-1111'
FOR UPDATE;

-- Phase 2: 자식 테이블에서 먼저 삭제
DELETE FROM "credit_card_payment" WHERE "id" IN (1);

-- Phase 3: 루트 테이블에서 나중에 삭제
DELETE FROM "payment" WHERE "id" IN (1);
```

**반환값:**

```typescript
{ affected: 1 }
```

자식 테이블을 먼저 삭제하는 이유는 자식의 `id` 컬럼이 루트 테이블을 참조하는 외래 키이기 때문입니다. 루트 행을 먼저 삭제하면 이 제약 조건을 위반합니다. `affected`는 삭제된 루트 행 수입니다.

키는 JOIN으로 찾습니다. 그래서 상속받은 컬럼으로 조건을 걸어도 `delete()`를 호출한 클래스의 행에만 적용됩니다. `em.delete(CreditCardPayment, { amount: 0 })`은 `amount: 0`인 `BankTransferPayment`를 건드리지 않습니다. 다른 서브클래스의 `id`로 `em.delete(CreditCardPayment, { id })`를 호출하면 아무것도 삭제되지 않습니다.

루트 엔티티로 삭제하면 조건에 맞는 행을 그 행이 걸쳐 있는 모든 테이블에서 삭제합니다.

```typescript
await em.delete(Payment, { amount: 0 });
```

```sql
SELECT "tpt_root"."id" AS "pk" FROM "payment" AS "tpt_root" WHERE "tpt_root"."amount" = 0 FOR UPDATE;
DELETE FROM "credit_card_payment" WHERE "id" IN (3, 7);
DELETE FROM "bank_transfer_payment" WHERE "id" IN (3, 7);
DELETE FROM "payment" WHERE "id" IN (3, 7);
```

ORM은 모든 자식 테이블의 행을 루트 테이블의 행보다 먼저 삭제합니다. 그래서 데이터베이스가 외래 키를 강제하든 하지 않든 루트 행 없이 남는 자식 행은 생기지 않습니다. 외래 키를 강제하지 않는 예로는 MyISAM이 있습니다. `deleteMany()`도 자식과 루트 중 어느 쪽에서 호출하든 같은 규칙을 따릅니다.

| 호출 | 키 조회 대상 | 삭제 테이블 |
|------|--------------|-------------|
| `delete(Child, criteria)` / `deleteMany(Child, ids)` | 자식 `INNER JOIN` 루트 | 자식 → 루트 |
| `delete(Root, criteria)` / `deleteMany(Root, ids)` | 루트 | 모든 자식 테이블 → 루트 |

`tenantStrategy: "tenant_column"`에서는 테넌트 조건이 키 조회 단계에 들어갑니다. 이 조건은 테넌트 컬럼이 있는 루트 테이블을 기준으로 걸립니다. PostgreSQL과 MySQL에서는 키 조회에 `FOR UPDATE`가 붙습니다. SQLite에는 잠금 절이 붙지 않습니다. 키는 `IN (...)` 목록 하나에 1,000개씩 나눠 삭제합니다. 그리고 모든 SQL 문은 트랜잭션 하나에서 실행됩니다.

## 12. 장단점

| 장점 | 단점 |
|------|------|
| 정규화된 스키마입니다. 낭비되는 NULL 컬럼이 없습니다 | 모든 쿼리에 JOIN(루트 + 자식)이 필요합니다 |
| 자식 컬럼에 NOT NULL 제약 조건을 걸 수 있습니다 | INSERT에 SQL 문이 두 개 필요합니다(루트 + 자식) |
| 자식 타입이 많아도 잘 확장됩니다 | DELETE에 키 조회와 테이블별 SQL 문이 필요합니다 |
| 타입별로 관심사가 깔끔하게 분리됩니다 | 다형성 쿼리에 LEFT JOIN이 N개 필요합니다 |
| 자식 타입을 추가해도 기존 테이블을 변경하지 않습니다 | 스키마가 STI보다 조금 더 복잡합니다 |
| 자식 수와 관계없이 루트 테이블이 좁게 유지됩니다 | WHERE 절을 알맞은 테이블로 라우팅해야 합니다 |

## 13. 언제 TPT를 사용할까

다음 경우에는 Joined(TPT) 상속을 사용하세요.

- **자식 고유 컬럼이 많을 때.** 각 자식 타입이 컬럼을 4개 이상 추가하면 STI에서는 대부분 NULL인 컬럼이 수십 개 있는 테이블이 생깁니다. TPT에서는 각 자식 테이블이 간결하게 유지됩니다.
- **자식 컬럼의 NOT NULL 제약 조건이 중요할 때.** STI에서는 모든 자식 고유 컬럼이 nullable이어야 합니다. TPT에서는 신용카드 결제의 `cardNumber`에 `NOT NULL`을 강제할 수 있습니다.
- **스키마 정규화가 중요할 때.** TPT는 완전히 정규화된 스키마를 생성합니다. 모든 테이블에서 모든 컬럼이 그 테이블의 모든 행과 관련이 있습니다.
- **특정 자식 타입을 자주 조회할 때.** 자식 쿼리의 INNER JOIN은 빠르고 예측 가능합니다.
- **가끔 다형성 쿼리가 필요할 때.** LEFT JOIN 방식은 STI의 단일 테이블 스캔보다는 느립니다. 하지만 TPC의 UNION ALL보다는 빠릅니다.

다음 경우에는 TPT를 피하세요.

- **다형성 쿼리가 주요 접근 패턴일 때.** 대부분의 쿼리가 모든 결제 타입을 조회한다면 LEFT JOIN N개가 오버헤드를 더합니다. 이때는 STI를 고려하세요.
- **자식 고유 컬럼이 매우 적을 때.** 각 자식이 컬럼을 1~2개만 추가한다면 STI가 더 단순하고 빠릅니다.
- **최대 INSERT/DELETE 성능이 필요할 때.** 2단계 쓰기는 지연 시간을 늘립니다. 다형성 읽기가 드물고 쓰기가 많은 워크로드라면 TPC를 고려하세요.

## 14. 다음 단계

- [상속 매핑](./inheritance-mapping): 세 가지 전략(STI, TPT, TPC) 개요
- [관계](./relations): @ManyToOne, @OneToMany, @ManyToMany, @OneToOne
- [EntityManager](./entity-manager): find, save, delete, 집계, 페이지네이션
- [Write Buffer](./write-buffer): Unit of Work 패턴과 변경 추적(dirty tracking)
- [Query Builder](./query-builder): JOIN, GROUP BY, 서브쿼리를 활용한 복잡한 SQL
