# Table Per Class Inheritance (TPC) -- 심층 가이드

## 1. Table Per Class Inheritance란?

**Table Per Class**(Concrete Table Inheritance이라고도 불러요)는 계층 구조의 각 엔티티를 상속받은 컬럼과 고유 컬럼을 **모두 포함하는** 독립적인 테이블로 매핑하는 전략이에요. 가족 구성원이 각각 완전히 별도의 집에 살면서 공유 가구의 복사본을 각자 가지고 있는 것과 비슷해요. 공유 공간이 전혀 없는 거죠. 부모와 자식 테이블 사이에 외래 키(FK)가 없고, discriminator 컬럼이 물리적으로 저장되지 않으며, 단일 엔티티 쿼리에 JOIN이 필요 없어요.

## 2. 스키마

각 엔티티가 완전히 자체적으로 완결된 테이블을 가져요. 부모의 컬럼(`id`, `amount`)이 모든 자식 테이블에 복제돼요.

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

세 가지를 주목해보세요:

1. 세 테이블 사이에 **외래 키가 없어요**. 완전히 독립적이에요.
2. `id`와 `amount` 컬럼이 모든 테이블에 **복제**돼 있어요. 각 테이블이 자체적으로 완결돼요.
3. 물리적으로 저장되는 **discriminator 컬럼이 없어요**. 다형성 쿼리를 할 때 ORM이 `UNION ALL`을 사용해서 가상 discriminator를 즉석에서 합성해요.

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

각 자식 클래스가 `@Entity()`에 `name`을 지정하지 않은 것을 주목하세요 -- 테이블 이름은 클래스 이름의 snake_case로 자동 결정돼요 (예: `CreditCardPayment`는 `credit_card_payment`이 돼요). STI와 달리 TPC 자식은 부모의 테이블 이름을 공유하지 **않아요**. 각 클래스가 자기만의 테이블에 있어요.

`@DiscriminatorColumn` 데코레이터는 여전히 루트 엔티티에 적용되지만, TPC에서는 discriminator가 데이터베이스에 저장되지 않아요. 다형성 `UNION ALL` 쿼리를 할 때 ORM이 가상 컬럼을 합성하는 용도로만 사용돼요.

## 4. INSERT -- 직접 삽입

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

세 가지 상속 전략 중 가장 단순한 INSERT예요. 부모 테이블에 삽입할 필요가 없고(TPT와 달리), discriminator 컬럼을 설정할 필요도 없어요(STI와 달리). 하나의 행이 하나의 테이블에 들어가요. 그게 전부예요.

계좌이체도 동일하게 동작해요 -- `bank_transfer_payment`에 단일 INSERT:

```typescript
const bt = await em.save(BankTransferPayment, {
  amount: 200,
  bankCode: "SWIFT123",
});
// BankTransferPayment { id: 1, amount: 200, bankCode: "SWIFT123" }
```

## 5. SELECT -- 자식 엔티티 조회

자식 엔티티를 조회하면 ORM이 해당 엔티티의 테이블을 직접 쿼리해요. JOIN도 없고, 서브쿼리도 없고, UNION도 없어요.

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

세 가지 상속 전략 중 가장 빠른 SELECT예요 -- JOIN 없이 직접 테이블에 접근하고, discriminator 필터링도 없어요. 데이터베이스가 다른 테이블은 전혀 건드리지 않아요.

## 6. SELECT -- 다형성 쿼리 (루트 엔티티) + UNION ALL

여기서 TPC가 흥미로워져요. 루트 엔티티 `Payment`를 조회하면 ORM이 계층 구조의 **모든** 테이블에서 행을 결합해야 해요. 이를 위해 `UNION ALL` 쿼리를 사용하고, 없는 컬럼은 `NULL`로 채워요.

```typescript
const all = await em.find(Payment, {});

console.log(JSON.stringify(all, null, 2));
```

**생성된 SQL (PostgreSQL):**

```sql
SELECT * FROM (
  SELECT "id", "amount", "cardNumber", NULL AS "bankCode",
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

네 가지를 주목해보세요:

1. 각 sub-SELECT가 전체 계층 구조의 **모든** 컬럼을 나열해요. 테이블에 해당 컬럼이 없으면 `NULL`이 자리 표시자로 사용돼요.
2. `@DiscriminatorValue` 문자열을 사용해서 가상 `"payment_type"` 컬럼이 합성돼요. 이 컬럼은 어떤 테이블에도 존재하지 않아요 -- 즉석에서 만들어지는 거예요.
3. 전체 UNION이 `"_tpc"`라는 별칭의 서브쿼리로 감싸져요.
4. 루트 엔티티(`Payment`)도 sub-SELECT에 포함돼요. 자식 고유 컬럼은 `NULL`로 채워져요.

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

`ResultTransformer.toPolymorphicEntities()` 메서드가 합성된 `payment_type` 컬럼을 읽고, discriminator 맵에서 매칭되는 엔티티 클래스를 찾아서 올바른 서브클래스를 인스턴스화해요. 반환된 배열의 각 객체는 해당 클래스의 올바른 `instanceof`예요.

### UNION ALL이 느린 이유

이 쿼리가 왜 비용이 많이 드는지 하나씩 살펴볼게요.

**UNION ALL의 동작 방식:** UNION ALL은 각 SELECT 문의 결과를 연결해요. 데이터베이스 엔진은 참여하는 **각 테이블을 독립적으로 스캔**해야 해요. 위 예제에서는 `payment`, `credit_card_payment`, `bank_transfer_payment` 세 테이블을 모두 읽어요.

**풀 스캔이 발생하는 이유:** STI나 TPT에서는 데이터베이스가 하나의 테이블(또는 JOIN된 테이블 쌍)에서 작업하고, 인덱스를 사용해서 필요한 행만 가져올 수 있어요. 하지만 TPC 다형성 쿼리는 달라요. `em.find(Payment, {})`를 실행하면 ORM은 어떤 자식 테이블에 데이터가 있는지 미리 알 수 없기 때문에 **예외 없이 모든 자식 테이블을 스캔**해야 해요. 자식 타입이 3개면 테이블 스캔이 3번이에요. 자식 타입이 10개면 테이블 스캔이 10번이에요. 각 테이블에 100만 행이 있으면 단일 다형성 쿼리가 수백만 행을 읽게 돼요.

**WHERE 절도 완전한 해결책이 아니에요:** `em.find(Payment, { where: { amount: 100 } })`를 사용하더라도 데이터베이스는 UNION ALL의 각 SELECT에 독립적으로 WHERE 절을 적용해요. 세 테이블 모두에서 `amount = 100`을 각각 검색한 다음 결과를 결합해요. 각 테이블 내의 인덱스는 도움이 되지만, **N개의 테이블에 걸쳐 검색을 반복하는** 오버헤드는 피할 수 없어요. 반면 STI는 하나의 테이블을 한 번만 검색하면 끝이에요.

::: warning
**결론:** TPC는 `em.find(ChildEntity, {})`(특정 자식 타입 조회)가 일반적인 경우이고, `em.find(Payment, {})`(전체 계층 구조에 대한 다형성 쿼리)가 드문 경우에 가장 적합해요. 자식별 쿼리는 세 가지 전략 중 가장 빠르지만(직접 테이블 접근, JOIN 없음), 다형성 쿼리는 가장 느려요. TPC를 선택하기 전에 이 트레이드오프를 이해하세요.
:::

## 7. SELECT -- findOne 사용

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

상속을 사용하지 않는 `findOne`과 동일해요. TPC 자식은 자기만의 테이블을 가지기 때문에 추가적인 로직이 필요 없어요.

## 8. SELECT -- QueryBuilder 사용

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
WHERE "cc"."amount" = 100;
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

TPC 자식에 대한 QueryBuilder는 해당 엔티티의 테이블만 쿼리해요 -- 상속을 사용하지 않는 엔티티와 완전히 동일하게 자연스럽게 동작해요.

::: tip
QueryBuilder를 통한 다형성 쿼리는 지원되지 않아요. `UNION ALL` 로직은 루트 엔티티에 대한 `em.find()`와 `em.findOne()`을 통해서만 사용할 수 있어요.
:::

## 9. SELECT -- WriteBuffer와 함께

WriteBuffer(Unit of Work 플러그인)는 내부적으로 `EntityManager`에 위임하기 때문에 상속 전략이 투명하게 동작해요. Identity map이 서브클래스 인스턴스를 올바르게 추적해요.

```typescript
import { bufferPlugin } from "@stingerloom/orm";

// 버퍼 플러그인 활성화
em.extend(bufferPlugin());

const buf = em.buffer();

// 자식 엔티티 조회 -- credit_card_payment 테이블을 쿼리해요
const cards = await buf.find(CreditCardPayment, {});
// cards가 identity map에서 추적돼요

// 다형성 find -- 모든 테이블에 걸쳐 UNION ALL
const all = await buf.find(Payment, {});
// all에 올바른 서브클래스 인스턴스가 포함돼요 (CreditCardPayment, BankTransferPayment 등)

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

// 추적된 엔티티 수정
cards[0].amount = 999;

// 변경 사항 플러시 -- UPDATE가 credit_card_payment 테이블만 대상으로 해요
const result = await buf.flush();
// result.updates === 1
```

**`buf.flush()` 생성된 SQL (PostgreSQL):**

```sql
UPDATE "credit_card_payment"
SET "amount" = 999
WHERE "id" = 1;
```

Dirty tracking이 어떤 프로퍼티가 변경되었는지 감지하고, 올바른 자식 테이블에 UPDATE를 플러시해요.

## 10. UPDATE -- 직접 업데이트

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

자식의 테이블에 대한 단일 UPDATE예요. TPT(부모 테이블과 자식 테이블 모두 업데이트해야 하는)와 달리 TPC는 모든 컬럼이 하나의 테이블에 있기 때문에 테이블 하나만 건드려요.

## 11. DELETE -- 직접 삭제

```typescript
await em.delete(CreditCardPayment, { id: 1 });
```

**생성된 SQL (PostgreSQL):**

```sql
DELETE FROM "credit_card_payment"
WHERE "id" = 1;
```

자식의 테이블에서 단일 DELETE예요. 부모 테이블로의 캐스케이드가 없어요 (캐스케이드할 부모 테이블이 없으니까요).

## 12. 장단점

| | 장점 | 단점 |
|---|------|------|
| **자식 쿼리** | 가장 빠른 SELECT -- 직접 테이블 접근, JOIN 없음 | -- |
| **INSERT** | 단일 INSERT, 세 가지 전략 중 가장 단순 | -- |
| **UPDATE** | 단일 UPDATE, 테이블 하나만 대상 | -- |
| **DELETE** | 단일 DELETE, 테이블 하나만 대상 | -- |
| **스키마** | 각 테이블이 자체 완결적이고 이해하기 쉬움 | 컬럼이 테이블 간에 중복됨 |
| **다형성 쿼리** | -- | UNION ALL 필요 (모든 테이블 스캔, 대규모에서 느림) |
| **스키마 변경** | -- | 공유 컬럼 추가 시 모든 자식 테이블에 ALTER TABLE 필요 |
| **데이터 무결성** | -- | 부모-자식 간 FK 제약 조건 없음 |
| **ID 고유성** | -- | Auto-increment ID가 테이블 간에 겹칠 수 있음 (14절 참조) |

## 13. TPC를 사용해야 하는 경우

각 자식 타입이 독립적으로 조회되고 다형성 쿼리가 드문 경우에 TPC를 사용하세요.

좋은 후보: 각 이벤트 타입마다 매우 다른 필드를 가진 감사/로그 테이블, JOIN 비용(TPT)이나 discriminator 필터링(STI)이 용납되지 않는 높은 쿼리 볼륨의 엔티티, 공유 필드가 전체의 작은 비율인 계층 구조가 적합해요.

좋지 않은 후보: "모든 결제를 가져와"가 자주 필요한 시스템(UNION ALL 비용이 누적돼요), 그리고 타입 간 FK 제약 조건을 강제하는 시스템(테이블이 독립적이기 때문에 "어떤 결제든" 참조하는 FK를 만들 수 없어요)은 적합하지 않아요.

## 14. ID 충돌

::: warning
테이블이 독립적이기 때문에 auto-increment ID가 겹칠 수 있어요. `id=1`인 `CreditCardPayment`와 `id=1`인 `BankTransferPayment`는 서로 다른 테이블의 **서로 다른 행**이에요. 다형성 쿼리에서 결과를 합치면 두 객체가 같은 `id` 값을 가질 수 있지만, 완전히 다른 레코드를 나타내요.

애플리케이션에서 계층 구조 전체에 걸쳐 전역적으로 고유한 ID가 필요하면, auto-increment 대신 `@PrimaryGeneratedColumn("uuid")`를 사용하세요:

```typescript
@PrimaryGeneratedColumn("uuid")
id!: string;
```

모든 테이블에서 고유한 UUIDv7 값을 생성해서 겹침 문제를 해결해요.
:::

## 15. 다음 단계

- [상속 매핑 개요](./inheritance-mapping) -- 세 가지 전략(STI, TPT, TPC) 비교
- [EntityManager](./entity-manager) -- find, save, delete, 집계, 페이지네이션
- [Query Builder](./query-builder) -- JOIN, GROUP BY, 서브쿼리를 활용한 복잡한 쿼리
- [Write Buffer](./write-buffer) -- Unit of Work 패턴과 identity map, dirty tracking
- [관계](./relations) -- @ManyToOne, @OneToMany, @ManyToMany, @OneToOne
