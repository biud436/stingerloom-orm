# Table Per Class Inheritance (TPC): 심층 가이드

## 1. Table Per Class Inheritance 개요

**Table Per Class**는 계층 구조의 각 엔티티를 독립된 테이블 하나에 매핑하는 전략입니다. 이 테이블에는 상속받은 컬럼과 클래스 고유 컬럼이 모두 들어 있습니다. Concrete Table Inheritance라고도 부릅니다. 가족 구성원이 저마다 완전히 다른 집에 살면서 공용 가구도 한 벌씩 따로 가진 것과 비슷합니다. 함께 쓰는 공간은 전혀 없습니다. 부모 테이블과 자식 테이블을 잇는 외래 키가 없습니다. 구분 컬럼(discriminator column)도 물리적으로 저장하지 않습니다. 그리고 엔티티 하나만 조회하는 쿼리에는 JOIN이 필요 없습니다.

## 2. 스키마

각 엔티티는 그 자체로 완결된 테이블을 가집니다. 부모의 컬럼인 `id`와 `amount`는 모든 자식 테이블에 중복해서 들어갑니다.

**PostgreSQL DDL:**

```sql
CREATE TABLE "payment" (
  "id" SERIAL PRIMARY KEY,
  "amount" INTEGER NOT NULL
);

CREATE TABLE "credit_card_payment" (
  "id" SERIAL PRIMARY KEY,
  "amount" INTEGER NOT NULL,
  "cardNumber" VARCHAR(255) NOT NULL
);

CREATE TABLE "bank_transfer_payment" (
  "id" SERIAL PRIMARY KEY,
  "amount" INTEGER NOT NULL,
  "bankCode" VARCHAR(255) NOT NULL
);
```

**MySQL DDL:**

```sql
CREATE TABLE `payment` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `amount` INT NOT NULL,
  PRIMARY KEY (`id`)
);

CREATE TABLE `credit_card_payment` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `amount` INT NOT NULL,
  `cardNumber` VARCHAR(255) NOT NULL,
  PRIMARY KEY (`id`)
);

CREATE TABLE `bank_transfer_payment` (
  `id` INT NOT NULL AUTO_INCREMENT,
  `amount` INT NOT NULL,
  `bankCode` VARCHAR(255) NOT NULL,
  PRIMARY KEY (`id`)
);
```

눈여겨볼 점은 세 가지입니다.

1. 세 테이블 사이에 외래 키가 없습니다. 세 테이블은 서로 완전히 독립적입니다.
2. `id`와 `amount` 컬럼이 모든 테이블에 중복해서 들어 있습니다. 각 테이블은 그 자체로 완결됩니다.
3. 물리적으로 저장하는 구분 컬럼이 없습니다. 다형성 쿼리(polymorphic query)를 실행하면 ORM이 `UNION ALL`로 가상의 구분 컬럼을 그때그때 만듭니다.

## 3. 엔티티 정의

```typescript
// payment.entity.ts
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  Inheritance,
  DiscriminatorColumn,
} from "@stingerloom/orm";

@Entity()
@Inheritance({ strategy: "TABLE_PER_CLASS" })
@DiscriminatorColumn({ name: "payment_type", type: "varchar", length: 50 })
export class Payment {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  amount!: number;
}
```

```typescript
// credit-card-payment.entity.ts
import { Entity, Column, DiscriminatorValue } from "@stingerloom/orm";
import { Payment } from "./payment.entity";

@Entity()
@DiscriminatorValue("credit_card")
export class CreditCardPayment extends Payment {
  @Column()
  cardNumber!: string;
}
```

```typescript
// bank-transfer-payment.entity.ts
import { Entity, Column, DiscriminatorValue } from "@stingerloom/orm";
import { Payment } from "./payment.entity";

@Entity()
@DiscriminatorValue("bank_transfer")
export class BankTransferPayment extends Payment {
  @Column()
  bankCode!: string;
}
```

각 자식 클래스는 `@Entity()`에 `name`을 지정하지 않았습니다. 이때 테이블 이름은 클래스 이름을 snake_case로 바꾼 이름이 됩니다. 예를 들어 `CreditCardPayment`는 `credit_card_payment`가 됩니다. STI와 달리 TPC의 자식은 부모의 테이블 이름을 공유하지 않습니다. 클래스마다 자기 테이블이 따로 있습니다.

`@DiscriminatorColumn` 데코레이터는 TPC에서도 루트 엔티티에 붙입니다. 하지만 TPC에서는 구분 컬럼을 데이터베이스에 저장하지 않습니다. 이 설정은 ORM이 다형성 `UNION ALL` 쿼리에서 가상 컬럼을 만들 때만 사용합니다.

## 4. INSERT: 직접 삽입

```typescript
const cc = await em.save(CreditCardPayment, {
  amount: 100,
  cardNumber: "4111-1111-1111-1111",
});
```

**생성된 SQL (PostgreSQL):**

```sql
INSERT INTO "credit_card_payment" ("amount", "cardNumber")
VALUES (100, '4111-1111-1111-1111')
RETURNING *;
```

**Raw SQL 결과:**

| id | amount | cardNumber          |
|----|--------|---------------------|
| 1  | 100    | 4111-1111-1111-1111 |

**역직렬화된 TypeScript 객체:**

```typescript
CreditCardPayment {
  id: 1,
  amount: 100,
  cardNumber: "4111-1111-1111-1111"
}
```

세 가지 상속 전략 중 가장 단순한 INSERT입니다. TPT와 달리 부모 테이블에 삽입할 필요가 없습니다. STI와 달리 구분 컬럼을 채울 필요도 없습니다. 행 하나를 테이블 하나에 삽입하면 끝입니다.

계좌이체 결제도 같은 방식으로 동작합니다. `bank_transfer_payment`에 INSERT를 한 번 실행합니다.

```typescript
const bt = await em.save(BankTransferPayment, {
  amount: 200,
  bankCode: "SWIFT123",
});
// BankTransferPayment { id: 1, amount: 200, bankCode: "SWIFT123" }
```

## 5. SELECT: 자식 엔티티 조회

자식 엔티티를 조회하면 ORM은 그 엔티티의 테이블을 직접 쿼리합니다. JOIN도, 서브쿼리도, UNION도 없습니다.

```typescript
const cards = await em.find(CreditCardPayment, {});
```

**생성된 SQL (PostgreSQL):**

```sql
SELECT "id", "amount", "cardNumber"
FROM "credit_card_payment";
```

**Raw SQL 결과:**

| id | amount | cardNumber          |
|----|--------|---------------------|
| 1  | 100    | 4111-1111-1111-1111 |

**역직렬화된 TypeScript 객체:**

```typescript
[
  CreditCardPayment {
    id: 1,
    amount: 100,
    cardNumber: "4111-1111-1111-1111"
  }
]
```

세 가지 상속 전략 중 가장 빠른 SELECT입니다. JOIN 없이 테이블에 직접 접근하고 구분 값으로 거르는 조건도 없습니다. 데이터베이스는 다른 테이블을 전혀 건드리지 않습니다.

## 6. SELECT: 다형성 쿼리 (루트 엔티티) + UNION ALL

여기서부터 TPC가 흥미로워집니다. 루트 엔티티 `Payment`를 조회하면 ORM은 계층 구조의 모든 테이블에서 행을 모아야 합니다. 그래서 `UNION ALL` 쿼리를 사용하고 테이블에 없는 컬럼은 `NULL`로 채웁니다.

```typescript
const all = await em.find(Payment, {});

console.log(JSON.stringify(all, null, 2));
```

**생성된 SQL (PostgreSQL):**

```sql
SELECT * FROM (
  SELECT "id", "amount", NULL AS "cardNumber",
         (SELECT "bankCode" FROM "bank_transfer_payment" WHERE FALSE) AS "bankCode",
         'Payment' AS "payment_type"
  FROM "payment"
  UNION ALL
  SELECT "id", "amount", "cardNumber", NULL AS "bankCode",
         'credit_card' AS "payment_type"
  FROM "credit_card_payment"
  UNION ALL
  SELECT "id", "amount", NULL AS "cardNumber", "bankCode",
         'bank_transfer' AS "payment_type"
  FROM "bank_transfer_payment"
) "_tpc";
```

눈여겨볼 점은 다섯 가지입니다.

1. 각 sub-SELECT는 계층 구조 전체의 모든 컬럼을 나열합니다. 테이블에 없는 컬럼 자리에는 플레이스홀더로 `NULL`을 씁니다.
2. 가상 컬럼 `"payment_type"`은 `@DiscriminatorValue` 문자열로 만들어집니다. 이 컬럼은 어느 테이블에도 없습니다. 쿼리를 실행할 때 그때그때 만들어집니다.
3. UNION 전체를 `"_tpc"`라는 별칭의 서브쿼리로 감쌉니다.
4. 루트 엔티티 `Payment`도 sub-SELECT 하나로 들어갑니다. 이 sub-SELECT에서 자식 고유 컬럼은 `NULL`로 채워집니다.
5. PostgreSQL에서는 첫 sub-SELECT가 `bankCode` 자리를 맨 `NULL`로 채우지 않습니다. 대신 그 컬럼을 0행으로 읽은 값으로 채웁니다. PostgreSQL은 UNION의 컬럼 타입을 왼쪽부터 둘씩 맞춰 갑니다. 그래서 컬럼을 가진 첫 테이블보다 앞에 맨 `NULL`이 두 개 있으면 그 자리의 타입이 `text`로 정해집니다. 그러면 뒤쪽 테이블의 숫자, 날짜, 불리언 컬럼과 타입이 맞지 않습니다. 결국 쿼리는 `UNION types text and integer cannot be matched` 에러로 실패합니다. 0행 읽기는 컬럼의 실제 타입을 그대로 따르므로 이 문제가 없습니다. 이 방식은 컬럼이 세 번째 이후 테이블에서 처음 나올 때만 씁니다. MySQL과 SQLite에는 항상 맨 `NULL`을 씁니다.

**Raw SQL 결과:**

| id | amount | cardNumber          | bankCode | payment_type  |
|----|--------|---------------------|----------|---------------|
| 1  | 50     | NULL                | NULL     | Payment       |
| 1  | 100    | 4111-1111-1111-1111 | NULL     | credit_card   |
| 1  | 200    | NULL                | SWIFT123 | bank_transfer |

**역직렬화된 TypeScript 객체:**

```typescript
[
  Payment { id: 1, amount: 50 },
  CreditCardPayment { id: 1, amount: 100, cardNumber: "4111-1111-1111-1111" },
  BankTransferPayment { id: 1, amount: 200, bankCode: "SWIFT123" }
]
```

**`console.log(JSON.stringify(all, null, 2))` 출력:**

```json
[
  {
    "id": 1,
    "amount": 50
  },
  {
    "id": 1,
    "amount": 100,
    "cardNumber": "4111-1111-1111-1111"
  },
  {
    "id": 1,
    "amount": 200,
    "bankCode": "SWIFT123"
  }
]
```

`ResultTransformer.toPolymorphicEntities()` 메서드는 쿼리가 만든 `payment_type` 컬럼을 읽습니다. 그리고 구분 값 맵에서 맞는 엔티티 클래스를 찾아 알맞은 서브클래스의 인스턴스를 만듭니다. 반환된 배열의 각 객체는 자기 클래스의 `instanceof` 검사를 통과합니다.

루트를 조회할 때 서브클래스의 속성으로 거르고 정렬하고 집계할 수 있습니다. `em.find(Payment, { where: { cardNumber: "4111-1111-1111-1111" } })`가 그 예입니다. `@Column({ name: "card_number" })`처럼 컬럼 이름이 다른 속성도 마찬가지입니다. 쿼리 빌더를 포함한 모든 읽기 경로에서 루트는 서브클래스의 속성을 UNION의 컬럼으로 매핑합니다.

### UNION ALL이 느린 이유

이 쿼리는 비용이 클 수 있습니다. 이유는 다음과 같습니다.

UNION ALL의 동작 방식: UNION ALL은 각 SELECT 문의 결과를 이어 붙입니다. 데이터베이스 엔진은 쿼리에 들어간 테이블을 하나씩 따로 스캔해야 합니다. 위 예제에서는 `payment`, `credit_card_payment`, `bank_transfer_payment` 세 테이블을 모두 읽습니다.

풀 스캔이 일어나는 이유: STI와 TPT에서 데이터베이스는 테이블 하나나 JOIN한 테이블 한 쌍만 다룹니다. 그리고 인덱스로 필요한 행만 읽을 수 있습니다. 하지만 TPC의 다형성 쿼리는 다릅니다. `em.find(Payment, {})`를 실행할 때 ORM은 어느 자식 테이블에 데이터가 있는지 미리 알 수 없습니다. 그래서 모든 자식 테이블을 빠짐없이 스캔해야 합니다. 자식 타입이 3개면 테이블 스캔도 3번입니다. 자식 타입이 10개면 10번입니다. 테이블마다 100만 행이 있으면 다형성 쿼리 하나가 수백만 행을 읽습니다.

WHERE 절의 한계: `em.find(Payment, { where: { amount: 100 } })`를 써도 데이터베이스는 UNION ALL의 각 SELECT에 WHERE 절을 따로 적용합니다. 세 테이블에서 각각 `amount = 100`을 검색한 다음 결과를 합칩니다. 테이블마다 인덱스가 있으면 도움이 됩니다. 하지만 N개 테이블에서 검색을 되풀이하는 오버헤드는 피할 수 없습니다. 반면 STI는 테이블 하나를 한 번만 검색하면 끝납니다.

::: warning
결론: TPC는 특정 자식 타입을 조회하는 `em.find(ChildEntity, {})`가 흔하고 계층 구조 전체를 다형성으로 조회하는 `em.find(Payment, {})`가 드물 때 가장 잘 맞습니다. 자식별 쿼리는 테이블에 직접 접근하고 JOIN이 없어서 세 전략 중 가장 빠릅니다. 하지만 다형성 쿼리는 가장 느립니다. TPC를 고르기 전에 이 트레이드오프를 이해하세요.
:::

### 루트에서 관계 다루기

TPC에서는 구체 테이블마다 물려받은 관계를 따로 가집니다. `Payment`에 `@ManyToOne`을 두면 세 테이블이 각자 `store_id` 컬럼과 외래 키를 갖습니다. 그리고 서브클래스는 그 옆에 자기 관계를 더 선언할 수 있습니다.

```typescript
@Entity()
@Inheritance({ strategy: "TABLE_PER_CLASS" })
@DiscriminatorColumn({ name: "payment_type", type: "varchar", length: 50 })
export class Payment {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  amount!: number;

  @ManyToOne(() => Store, (store) => store.payments)
  @RelationColumn({ name: "store_id" })
  store!: Store | null;
}
```

UNION은 각 테이블의 조인 컬럼도 다른 컬럼처럼 함께 싣습니다. 그래서 루트 조회가 반환하는 모든 인스턴스에 `storeId`가 채워집니다. `where`에서 그 키로 거를 수도 있습니다. 그리고 `relations`를 지정하면 UNION 위에 JOIN이 붙습니다.

```typescript
const payments = await em.find(Payment, {
  where: { storeId: 1 },
  relations: ["store"],
});
// [CreditCardPayment { id: 1, amount: 100, storeId: 1, cardNumber: "4111-...", store: Store { id: 1, ... } }, ...]
```

**생성된 SQL (PostgreSQL):**

```sql
SELECT "_tpc".*, "store"."id" AS "store__id", "store"."name" AS "store__name"
FROM (
  SELECT "id", "amount", "store_id", NULL AS "cardNumber", ... FROM "payment"
  UNION ALL
  SELECT "id", "amount", "store_id", "cardNumber", ... FROM "credit_card_payment"
  UNION ALL
  SELECT "id", "amount", "store_id", NULL AS "cardNumber", ... FROM "bank_transfer_payment"
) "_tpc"
LEFT JOIN "store" AS "store" ON "_tpc"."store_id" = "store"."id"
WHERE "_tpc"."store_id" = $1;
```

각 인스턴스에는 자기 테이블에 있는 컬럼만 남습니다. `CreditCardPayment`에는 `bankCode`가 없습니다. `BankTransferPayment`만 선언한 관계의 키도 붙지 않습니다. `findOne()`, `findWithCursor()`, `count()`를 비롯한 집계, QueryBuilder의 `loadRelation()`과 `leftJoinRelationAndSelect()`도 같은 규칙을 따릅니다.

반대 방향도 계층 전체를 읽습니다. `Store`의 `@OneToMany(() => Payment, { mappedBy: "store" })`는 같은 UNION에서 로드합니다. 그래서 `em.find(Store, { relations: ["payments"] })`는 매장마다 신용카드 결제와 계좌이체 결제를 각자의 서브클래스로 반환합니다. 루트를 대상으로 하는 역방향 `@OneToOne`도 같은 방식으로 동작합니다.

테이블 구조 때문에 생기는 제약이 두 가지 있습니다.

- **루트 조회는 루트의 관계만 로드합니다.** 서브클래스가 선언한 관계를 루트의 `relations`에 넣으면 알 수 없는 관계로 보고 거부합니다. 다만 그 조인 컬럼 값은 해당 서브클래스 인스턴스에 그대로 담겨 옵니다. 관계 객체가 필요하면 `em.find(Subclass, { relations: [...] })`로 로드하세요.
- **외래 키는 UNION을 참조할 수 없습니다.** 루트 자체를 대상으로 하는 `@ManyToOne`은 루트 테이블을 참조합니다. 그래서 루트 클래스의 인스턴스만 가리킬 수 있습니다. 다른 테이블에 저장된 `CreditCardPayment`는 가리키지 못합니다.

## 7. SELECT: findOne 사용

```typescript
const card = await em.findOne(CreditCardPayment, {
  where: { id: 1 },
});
```

**생성된 SQL (PostgreSQL):**

```sql
SELECT "id", "amount", "cardNumber"
FROM "credit_card_payment"
WHERE "id" = 1
LIMIT 1;
```

**Raw SQL 결과:**

| id | amount | cardNumber          |
|----|--------|---------------------|
| 1  | 100    | 4111-1111-1111-1111 |

**역직렬화된 TypeScript 객체:**

```typescript
CreditCardPayment {
  id: 1,
  amount: 100,
  cardNumber: "4111-1111-1111-1111"
}
```

상속을 쓰지 않는 `findOne`과 같습니다. TPC의 자식은 자기 테이블을 가지므로 추가 로직이 필요 없습니다.

## 8. SELECT: QueryBuilder 사용

`SelectQueryBuilder`는 다형성 쿼리를 포함해 TPC 상속을 모두 지원합니다.

**자식 엔티티 쿼리:**

```typescript
const cards = await em
  .createQueryBuilder(CreditCardPayment, "cc")
  .where("amount", 100)
  .getMany();
```

**생성된 SQL (PostgreSQL):**

```sql
SELECT "cc".*
FROM "credit_card_payment" "cc"
WHERE "cc"."amount" = $1;
```

**역직렬화된 결과:**

```typescript
[
  CreditCardPayment {
    id: 1,
    amount: 100,
    cardNumber: "4111-1111-1111-1111"
  }
]
```

자식 쿼리는 별도 처리 없이 동작합니다. 빌더는 자식 엔티티의 테이블을 직접 쿼리하고 추가 로직은 없습니다.

**다형성 루트 엔티티 쿼리:**

```typescript
const all = await em
  .createQueryBuilder(Payment, "p")
  .getMany();
```

**생성된 SQL (PostgreSQL):**

```sql
SELECT * FROM (
  SELECT "id", "amount", NULL AS "cardNumber",
         (SELECT "bankCode" FROM "bank_transfer_payment" WHERE FALSE) AS "bankCode",
         'Payment' AS "payment_type"
  FROM "payment"
  UNION ALL
  SELECT "id", "amount", "cardNumber", NULL AS "bankCode",
         'credit_card' AS "payment_type"
  FROM "credit_card_payment"
  UNION ALL
  SELECT "id", "amount", NULL AS "cardNumber", "bankCode",
         'bank_transfer' AS "payment_type"
  FROM "bank_transfer_payment"
) "_tpc";
```

**역직렬화된 결과:**

```typescript
[
  Payment { id: 1, amount: 50 },
  CreditCardPayment { id: 1, amount: 100, cardNumber: "4111-1111-1111-1111" },
  BankTransferPayment { id: 1, amount: 200, bankCode: "SWIFT123" }
]
// 각 요소는 알맞은 서브클래스의 인스턴스이므로 instanceof 검사를 통과합니다.
```

QueryBuilder는 UNION ALL 서브쿼리를 자동으로 생성합니다. 이 서브쿼리에는 빈 컬럼 자리를 채우는 `NULL`과 가상 구분 컬럼이 들어 있습니다. `ResultTransformer.toPolymorphicEntities()` 메서드는 이 가상 구분 컬럼을 읽고 알맞은 서브클래스의 인스턴스를 만듭니다. `em.find()`와 같은 방식입니다. 모든 QueryBuilder 메서드(`getMany()`, `getOne()`, `getCount()`, `exists()`)가 TPC 다형성 역직렬화를 지원합니다.

::: warning
`em.find()`의 다형성 쿼리에 있는 UNION ALL 성능 문제는 QueryBuilder에도 똑같이 적용됩니다. 데이터가 많을 때 느려질 수 있는 이유는 [6절](#_6-select-다형성-쿼리-루트-엔티티-union-all)을 참고하세요.
:::

## 9. SELECT: WriteBuffer와 함께

WriteBuffer(Unit of Work 플러그인)는 내부에서 `EntityManager`에 작업을 위임합니다. 그래서 상속 전략이 별도 설정 없이 그대로 동작합니다. Identity Map도 서브클래스 인스턴스를 올바르게 추적합니다.

```typescript
import { bufferPlugin } from "@stingerloom/orm";

// 버퍼 플러그인을 활성화합니다
em.extend(bufferPlugin());

const buf = em.buffer();

// 자식 엔티티 조회: credit_card_payment 테이블을 쿼리합니다
const cards = await buf.find(CreditCardPayment, {});
// 이제 Identity Map이 cards를 추적합니다

// 다형성 find: 모든 테이블을 UNION ALL로 합칩니다
const all = await buf.find(Payment, {});
// all에는 CreditCardPayment, BankTransferPayment 같은 알맞은 서브클래스 인스턴스가 들어 있습니다

console.log(JSON.stringify(all, null, 2));
// 출력:
// [
//   {
//     "id": 1,
//     "amount": 50
//   },
//   {
//     "id": 1,
//     "amount": 100,
//     "cardNumber": "4111-1111-1111-1111"
//   },
//   {
//     "id": 1,
//     "amount": 200,
//     "bankCode": "SWIFT123"
//   }
// ]

// 추적 중인 엔티티를 수정합니다
cards[0].amount = 999;

// 변경 사항을 flush합니다. UPDATE는 credit_card_payment 테이블만 대상으로 합니다
const result = await buf.flush();
// result.updates === 1
```

**`buf.flush()`가 생성한 SQL (PostgreSQL):**

```sql
UPDATE "credit_card_payment"
SET "amount" = 999
WHERE "id" = 1;
```

변경 추적(dirty tracking)이 바뀐 속성을 찾아냅니다. 그리고 알맞은 자식 테이블에 UPDATE를 flush합니다.

## 10. UPDATE: 직접 갱신

```typescript
const cc = await em.findOne(CreditCardPayment, {
  where: { id: 1 },
});

cc.amount = 200;
cc.cardNumber = "9999-9999-9999-9999";

await em.save(CreditCardPayment, cc);
```

**생성된 SQL (PostgreSQL):**

```sql
UPDATE "credit_card_payment"
SET "amount" = 200, "cardNumber" = '9999-9999-9999-9999'
WHERE "id" = 1;
```

자식 테이블에 UPDATE를 한 번 실행합니다. TPT는 부모 테이블과 자식 테이블을 모두 갱신해야 합니다. 반면 TPC는 모든 컬럼이 테이블 하나에 있으므로 테이블 하나만 건드립니다.

## 11. DELETE: 직접 삭제

```typescript
await em.delete(CreditCardPayment, { id: 1 });
```

**생성된 SQL (PostgreSQL):**

```sql
DELETE FROM "credit_card_payment"
WHERE "id" = 1;
```

자식 테이블에서 DELETE를 한 번 실행합니다. 캐스케이드할 부모 테이블이 없으므로 부모 테이블로 이어지는 캐스케이드도 없습니다.

## 12. 계층 전체를 대상으로 하는 루트 연산

TPC의 루트 테이블에는 루트 클래스로 직접 저장한 행만 들어 있습니다. 그래서 루트 클래스를 대상으로 하는 연산은 모두 계층 전체에 적용됩니다. 읽기는 `find()`가 쓰는 것과 같은 `UNION ALL` 위에서 실행됩니다. 쓰기는 구체 테이블마다 한 번씩 실행되고 영향받은 행 수를 합산합니다.

```typescript
await em.count(Payment);                                    // 모든 서브타입의 행 수
await em.sum(Payment, "amount");                            // 모든 서브타입 합계
await em.findAndCount(Payment, { where: { amount: { gte: 100 } } });
await em.findWithCursor(Payment, { take: 20 });             // 계층 전체를 페이지네이션
await em.updateMany(Payment, { status: "settled" }, { where: { status: "pending" } });
await em.softDelete(Payment, { status: "void" });
await em.delete(Payment, { amount: 0 });                    // 구체 테이블마다 DELETE 한 번
```

| 루트 클래스 대상 연산 | 동작 |
|---------------------|------|
| `find` / `findOne` / `findBy` / `stream` | 모든 구체 테이블의 `UNION ALL`, 구분 값으로 서브클래스 인스턴스 생성 |
| `count` / `exists` / `sum` / `avg` / `min` / `max` | 같은 `UNION ALL` 위에서 집계 |
| `findAndCount` / `findWithPage` | 행과 총 개수 모두 계층 전체 기준 |
| `findWithCursor` | 계층 전체를 페이지네이션합니다. 키셋이 `(정렬 컬럼, id, 구분 값)`이므로 같은 `id`를 가진 두 서브타입도 건너뛰거나 중복되지 않습니다 |
| `createQueryBuilder(Root, alias)` | `UNION ALL`을 FROM 소스로 사용, `getCount()` 포함 |
| `updateMany` / `update` / `increment` / `decrement` | 같은 `SET ... WHERE`를 구체 테이블마다 실행, `affected`는 합산 |
| `softDelete` / `restore` | 모든 구체 테이블에서 `@DeletedAt` 값을 기록하거나 비움 |
| `delete` / `deleteMany` | 구체 테이블마다 `DELETE` 한 번, `affected`는 합산 |
| `orderBy` / `limit`가 있는 `updateMany` | `OrmError`(`UNSUPPORTED_OPERATION`)로 거부합니다. limit는 SQL 문마다 적용되므로 계층 전체로는 의미가 없습니다. 구체 서브클래스에서 실행하세요 |
| 루트 클래스 `save` | 루트 테이블에만 씁니다. 루트는 자식을 모아 보여 주는 뷰가 아니라 그 자체로 구체 클래스입니다 |

테이블별 SQL 문은 모두 같은 트랜잭션 안에서 실행됩니다. 그래서 루트의 `delete()`는 조건에 맞는 행을 모든 테이블에서 삭제하거나 어느 테이블에서도 삭제하지 않습니다.

## 13. 장단점

| | 장점 | 단점 |
|---|------|------|
| **자식 쿼리** | 가장 빠른 SELECT: 테이블 직접 접근, JOIN 없음 | 없음 |
| **INSERT** | INSERT 한 번, 세 가지 전략 중 가장 단순 | 없음 |
| **UPDATE** | UPDATE 한 번, 테이블 하나만 대상 | 없음 |
| **DELETE** | DELETE 한 번, 테이블 하나만 대상 | 없음 |
| **스키마** | 각 테이블이 그 자체로 완결되어 이해하기 쉬움 | 컬럼이 테이블마다 중복됨 |
| **다형성 쿼리** | 없음 | UNION ALL 필요: 모든 테이블을 스캔하므로 데이터가 많으면 느림 |
| **스키마 변경** | 없음 | 공유 컬럼을 추가하면 모든 자식 테이블에 ALTER TABLE 필요 |
| **데이터 무결성** | 없음 | 부모와 자식 사이에 외래 키 제약 조건 없음 |
| **ID 고유성** | 없음 | auto-increment ID가 테이블끼리 겹칠 수 있음 (15절 참조) |

## 14. TPC를 사용해야 하는 경우

자식 타입마다 따로 조회하고 다형성 쿼리가 드물다면 TPC를 사용하세요.

잘 맞는 경우는 다음과 같습니다.

- 이벤트 타입마다 필드가 크게 다른 감사 테이블이나 로그 테이블
- 쿼리가 많아서 TPT의 JOIN 비용이나 STI의 구분 값 필터링을 감당할 수 없는 엔티티
- 공유 필드가 전체 필드에서 차지하는 비율이 작은 계층 구조

맞지 않는 경우는 다음과 같습니다.

- 모든 결제를 한꺼번에 조회하는 일이 잦은 시스템. UNION ALL 비용이 쌓입니다.
- 타입 사이에 외래 키 제약 조건을 강제하는 시스템. 테이블이 서로 독립적이므로 "어떤 결제든" 참조하는 외래 키를 만들 수 없습니다.

## 15. ID 충돌

::: warning
테이블이 서로 독립적이므로 auto-increment ID가 겹칠 수 있습니다. `id=1`인 `CreditCardPayment`와 `id=1`인 `BankTransferPayment`는 서로 다른 테이블에 있는 서로 다른 행입니다. 다형성 쿼리로 결과를 합치면 두 객체의 `id` 값이 같을 수 있습니다. 하지만 두 객체는 완전히 다른 행을 나타냅니다.

TPC는 서브타입 사이에서 기본 키가 고유하다고 보장하지 않습니다. ORM도 이를 강제하지 않습니다. 그 결과 루트 클래스에서는 다음과 같이 동작합니다.

- `findOne(Payment, { where: { id: 1 } })`은 처음 매치된 서브타입의 행을 반환합니다. 둘 이상의 서브타입이 매치되면 ORM은 루트 엔티티마다 한 번 경고를 남깁니다. 그리고 이때도 첫 행을 반환합니다.
- `count(Payment, { id: 1 })`은 매치되는 서브타입마다 한 행씩 셉니다.
- `delete(Payment, { id: 1 })`과 `deleteMany(Payment, [1])`은 그 키를 가진 모든 구체 테이블에서 행을 삭제합니다.

키만으로 행 하나를 특정해야 한다면 구체 서브클래스로 조회하세요.

애플리케이션에 계층 구조 전체에서 고유한 ID가 필요하면 auto-increment 대신 `@PrimaryGeneratedColumn("uuid")`를 사용하세요.

```typescript
@PrimaryGeneratedColumn("uuid")
id!: string;
```

이 설정은 모든 테이블에서 고유한 무작위 UUIDv4 값을 생성합니다. 그래서 ID가 겹치는 문제가 사라집니다. 키가 생성 시각 순으로도 정렬되어야 한다면 `@PrimaryGeneratedColumn("uuid-v7")`을 사용하세요.
:::

## 16. 다음 단계

- [상속 매핑 개요](./inheritance-mapping): 세 가지 전략(STI, TPT, TPC) 비교
- [EntityManager](./entity-manager): find, save, delete, 집계, 페이지네이션
- [Query Builder](./query-builder): JOIN, GROUP BY, 서브쿼리를 활용한 복잡한 쿼리
- [Write Buffer](./write-buffer): Unit of Work 패턴, Identity Map, 변경 추적(dirty tracking)
- [관계](./relations): @ManyToOne, @OneToMany, @ManyToMany, @OneToOne
