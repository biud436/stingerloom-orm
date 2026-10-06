# Single Table Inheritance (STI) -- 심층 가이드

Single Table Inheritance는 부모와 모든 자식을 포함한 전체 클래스 계층 구조를 **하나의 데이터베이스 테이블**에 매핑하고, discriminator 컬럼으로 각 행을 구분하는 전략이에요.

가족이 한 방을 같이 쓰는 것과 비슷해요. 모두 같은 방에서 자지만, 각자 이름표를 달고 있어서 누가 누군지 알 수 있죠. 방이 테이블이고, 이름표가 discriminator 컬럼이에요.

이 가이드에서는 모든 CRUD 연산을 하나씩 살펴보면서 각 연산마다 세 가지를 보여줘요: TypeScript API 호출, ORM이 생성하는 정확한 SQL, 그리고 raw 결과 행과 역직렬화된 TypeScript 객체를 함께 볼 수 있어요. 세 가지 상속 전략(STI, TPT, TPC)의 전체적인 비교가 필요하면 [상속 매핑 개요](./inheritance-mapping)부터 읽어보세요.

## 스키마

STI를 사용하면 Stingerloom이 모든 자식의 컬럼을 하나의 CREATE TABLE 문으로 합쳐요. 각 행이 어떤 클래스에 속하는지 식별하기 위해 discriminator 컬럼이 추가돼요.

**PostgreSQL:**

```sql
CREATE TABLE "payment" (
  "id"           SERIAL PRIMARY KEY,
  "amount"       INT NOT NULL,
  "payment_type" VARCHAR(50),
  "cardNumber"   VARCHAR(255),
  "bankCode"     VARCHAR(255)
);
```

**MySQL:**

```sql
CREATE TABLE `payment` (
  `id`           INT NOT NULL AUTO_INCREMENT,
  `amount`       INT NOT NULL,
  `payment_type` VARCHAR(50),
  `cardNumber`   VARCHAR(255),
  `bankCode`     VARCHAR(255),
  PRIMARY KEY (`id`)
);
```

세 가지를 주목해보세요:

1. 모든 자식의 컬럼(`CreditCardPayment`의 `cardNumber`, `BankTransferPayment`의 `bankCode`)이 **하나의** 테이블에 들어가요
2. `payment_type` 컬럼이 discriminator예요 -- `'credit_card'`, `'bank_transfer'`, 또는 루트 클래스 이름을 저장해요
3. 자식 전용 컬럼은 **nullable**이에요. 신용카드 행은 `bankCode = NULL`이 되고, 그 반대도 마찬가지예요

## 엔티티 정의

세 개의 데코레이터가 함께 작동해요: 루트에 `@Inheritance`를 붙여 전략을 설정하고, `@DiscriminatorColumn`으로 discriminator 컬럼을 구성하고, 각 자식에 `@DiscriminatorValue`로 라벨을 지정해요.

```typescript
import {
  Entity, PrimaryGeneratedColumn, Column,
  Inheritance, DiscriminatorColumn, DiscriminatorValue,
  ManyToOne, OneToMany,
} from "@stingerloom/orm";

// ── Root entity ──
@Entity()
@Inheritance({ strategy: "SINGLE_TABLE" })
@DiscriminatorColumn({ name: "payment_type", type: "varchar", length: 50 })
export class Payment {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column()
  amount!: number;
}

// ── Child: CreditCardPayment ──
@Entity()
@DiscriminatorValue("credit_card")
export class CreditCardPayment extends Payment {
  @Column({ nullable: true })
  cardNumber!: string;
}

// ── Child: BankTransferPayment ──
@Entity()
@DiscriminatorValue("bank_transfer")
export class BankTransferPayment extends Payment {
  @Column({ nullable: true })
  bankCode!: string;
}
```

설정에서 모든 엔티티(루트와 모든 자식)를 등록해야 해요:

```typescript
await em.register({
  type: "postgres",
  entities: [Payment, CreditCardPayment, BankTransferPayment],
  synchronize: true,
});
```

::: warning
자식 전용 컬럼은 **반드시** `nullable: true`여야 해요. CreditCardPayment 행은 `bankCode = NULL`이 되고, BankTransferPayment 행은 `cardNumber = NULL`이 돼요. NOT NULL로 지정하면 다른 타입의 INSERT가 제약 조건 위반으로 실패해요.
:::

`@DiscriminatorColumn`을 생략하면 Stingerloom이 기본적으로 `"dtype"`이라는 이름의 `VARCHAR(31)` 타입 컬럼을 만들어요. 자식에 `@DiscriminatorValue`를 생략하면 클래스 이름이 값으로 사용돼요 (예: `"CreditCardPayment"`).

## INSERT -- Discriminator 값이 설정되는 방식

discriminator 값을 직접 설정할 필요가 없어요. ORM이 `@DiscriminatorValue("credit_card")`에서 값을 읽어서 모든 INSERT에 자동으로 주입해요.

```typescript
const cc = await em.save(CreditCardPayment, {
  amount: 100,
  cardNumber: "4111-1111-1111-1111",
});
```

**생성된 SQL (PostgreSQL):**

```sql
INSERT INTO "payment" ("amount", "cardNumber", "payment_type")
VALUES (100, '4111-1111-1111-1111', 'credit_card')
RETURNING *;
```

**생성된 SQL (MySQL):**

```sql
INSERT INTO `payment` (`amount`, `cardNumber`, `payment_type`)
VALUES (100, '4111-1111-1111-1111', 'credit_card');
```

반환된 엔티티:

```typescript
// cc is:
CreditCardPayment {
  id: 1,
  amount: 100,
  cardNumber: "4111-1111-1111-1111"
}
```

주목할 점: `payment_type` 컬럼 값 `'credit_card'`는 ORM이 설정한 거예요. discriminator는 TypeScript 객체의 프로퍼티로 나타나지 않아요 -- 비즈니스 데이터가 아니라 메타데이터이기 때문이에요.

SELECT 예제를 위한 데이터로 계좌이체와 루트 결제도 추가로 삽입해볼게요:

```typescript
const bt = await em.save(BankTransferPayment, {
  amount: 200,
  bankCode: "SWIFT123",
});
// bt is:
// BankTransferPayment { id: 2, amount: 200, bankCode: "SWIFT123" }

const plain = await em.save(Payment, { amount: 50 });
// plain is:
// Payment { id: 3, amount: 50 }
```

루트 엔티티에도 discriminator 값이 들어가요. `Payment`에는 `@DiscriminatorValue`가 없기 때문에 클래스 이름 `"Payment"`가 사용돼요:

```sql
INSERT INTO "payment" ("amount", "payment_type")
VALUES (50, 'Payment')
RETURNING *;
```

### 모든 INSERT 경로가 같은 값을 씁니다

어떤 메서드로 쓰든 모든 행에 같은 값이 들어갑니다. `save()`, `saveMany()`, `insertMany()`, `insertManyAndReturn()`, `upsert()`, `insertIgnore()`, `batchUpsert()`, `createInsertBuilder()`, 그리고 WriteBuffer flush까지 전부입니다. 페이로드에 discriminator 컬럼 값을 적어도 엔티티의 값으로 덮어씁니다.

```typescript
await em.insertMany(CreditCardPayment, [{ amount: 10 }, { amount: 20 }]);
```

```sql
INSERT INTO "payment" ("amount", "payment_type")
VALUES (10, 'credit_card'), (20, 'credit_card');
```

### 자식 엔티티로 upsert하기

모든 서브타입이 테이블 하나를 함께 쓰므로 키 공간도 하나입니다. `upsert()`, `batchUpsert()`, `createInsertBuilder().doUpdate()`의 충돌 분기는 같은 서브타입의 행만 갱신합니다. 충돌한 키가 다른 서브타입의 행이면 그 행은 그대로 두고 영향받지 않은 행으로 셉니다. PostgreSQL과 SQLite에서는 엔티티 클래스당 한 번 경고도 남겨요.

```typescript
// id 2는 위에서 넣은 BankTransferPayment
await em.upsert(CreditCardPayment, { id: 2, amount: 999 });
// { affected: 0 } -- 계좌이체 행은 그대로예요
```

**생성된 SQL (PostgreSQL):**

```sql
INSERT INTO "payment" ("id", "amount", "payment_type")
VALUES (2, 999, 'credit_card')
ON CONFLICT ("id") DO UPDATE SET "amount" = EXCLUDED."amount"
WHERE "payment"."payment_type" = 'credit_card';
```

**생성된 SQL (MySQL):** `ON DUPLICATE KEY UPDATE`에는 WHERE가 없어서 대입마다 같은 조건을 붙입니다.

```sql
INSERT INTO `payment` (`id`, `amount`, `payment_type`)
VALUES (2, 999, 'credit_card')
ON DUPLICATE KEY UPDATE
  `amount` = IF(`payment`.`payment_type` = 'credit_card', VALUES(`amount`), `payment`.`amount`);
```

루트로 upsert하면(`em.upsert(Payment, ...)`) 키를 가진 행이 어느 서브타입이든 갱신하고, 그 행의 discriminator는 건드리지 않습니다.

## SELECT -- 자식 엔티티 조회 (em.find)

자식 엔티티를 조회하면 ORM이 자동으로 discriminator 값으로 필터링하는 `WHERE` 절을 추가해요. 다른 타입의 행은 절대 보이지 않아요.

```typescript
const cards = await em.find(CreditCardPayment, {});
```

**생성된 SQL (PostgreSQL):**

```sql
SELECT * FROM "payment"
WHERE "payment_type" = 'credit_card';
```

**생성된 SQL (MySQL):**

```sql
SELECT * FROM `payment`
WHERE `payment_type` = 'credit_card';
```

**Raw SQL 결과:**

```
| id | amount | payment_type | cardNumber          | bankCode |
|----|--------|------------- |---------------------|----------|
|  1 |    100 | credit_card  | 4111-1111-1111-1111 | NULL     |
```

**역직렬화된 결과:**

```typescript
// cards is:
[
  CreditCardPayment { id: 1, amount: 100, cardNumber: "4111-1111-1111-1111" }
]
```

주목할 점: `bankCode`(BankTransferPayment에 속하는 컬럼)는 결과 객체에 **없어요**. ORM은 `CreditCardPayment` 클래스에 속하는 컬럼만 매핑해요. 다른 형제 타입의 NULL 컬럼들은 역직렬화 과정에서 그대로 제거돼요.

## SELECT -- Polymorphic Query (루트 엔티티)

루트 엔티티를 조회하면 discriminator 필터 없이 테이블의 **모든** 행을 반환해요. ORM이 각 행의 discriminator 값을 읽고 올바른 TypeScript 클래스를 인스턴스화해요.

```typescript
const all = await em.find(Payment, {});
```

**생성된 SQL (PostgreSQL):**

```sql
SELECT * FROM "payment";
```

**Raw SQL 결과:**

```
| id | amount | payment_type  | cardNumber          | bankCode |
|----|--------|---------------|---------------------|----------|
|  1 |    100 | credit_card   | 4111-1111-1111-1111 | NULL     |
|  2 |    200 | bank_transfer | NULL                | SWIFT123 |
|  3 |     50 | Payment       | NULL                | NULL     |
```

**역직렬화된 결과:**

```typescript
// all is:
[
  CreditCardPayment  { id: 1, amount: 100, cardNumber: "4111-1111-1111-1111" },
  BankTransferPayment { id: 2, amount: 200, bankCode: "SWIFT123" },
  Payment             { id: 3, amount: 50 }
]

// 런타임 타입 체크가 작동해요:
all[0] instanceof CreditCardPayment  // true
all[1] instanceof BankTransferPayment // true
all[2] instanceof Payment             // true

// console.log로 전체 출력을 확인해볼 수 있어요:
console.log(JSON.stringify(all, null, 2));
// [
//   {
//     "id": 1,
//     "amount": 100,
//     "cardNumber": "4111-1111-1111-1111"
//   },
//   {
//     "id": 2,
//     "amount": 200,
//     "bankCode": "SWIFT123"
//   },
//   {
//     "id": 3,
//     "amount": 50
//   }
// ]
```

주목할 점: 배열의 각 요소가 **올바른 서브클래스 인스턴스**예요. `CreditCardPayment` 객체에는 `cardNumber`가 있지만 `bankCode`는 없어요. `BankTransferPayment` 객체에는 `bankCode`가 있지만 `cardNumber`는 없어요. 루트 `Payment` 객체에는 둘 다 없어요.

### Polymorphic 역직렬화 작동 원리

내부적으로 ORM은 각 행에 대해 다음 과정을 따라요:

1. raw 행에서 `payment_type` 컬럼 값을 읽어요
2. discriminator 맵을 조회해요: `{ "credit_card" => CreditCardPayment, "bank_transfer" => BankTransferPayment, "Payment" => Payment }`
3. 매칭되는 클래스 생성자를 찾아요
4. 클래스를 인스턴스화하고 관련 컬럼만 매핑해요
5. 컬럼 transformer가 있으면 적용해요

이 로직은 `ResultTransformer.toPolymorphicEntities()`에 있어요. discriminator 맵은 `InheritanceResolver.buildDiscriminatorMap()`에서 한 번 만들어지고 쿼리 동안 캐시돼요.

## SELECT -- Relations와 함께

상속 엔티티는 표준 `@ManyToOne`과 `@OneToMany` 관계를 지원해요. 모든 자식이 상속받을 수 있도록 루트 엔티티에 관계를 정의하세요.

```typescript
@Entity()
export class Store {
  @PrimaryGeneratedColumn() id!: number;
  @Column() name!: string;

  @OneToMany(() => Payment, { mappedBy: "store" })
  payments!: Payment[];
}

@Entity()
@Inheritance({ strategy: "SINGLE_TABLE" })
@DiscriminatorColumn({ name: "payment_type", type: "varchar", length: 50 })
export class Payment {
  @PrimaryGeneratedColumn() id!: number;
  @Column() amount!: number;

  @Column({ type: "int", nullable: true })
  storeId!: number;

  // 위의 storeId @Column에서 FK 컬럼이 자동 감지됩니다
  @ManyToOne(() => Store, (s) => s.payments)
  store!: Store;
}

@Entity()
@DiscriminatorValue("credit_card")
export class CreditCardPayment extends Payment {
  @Column({ nullable: true }) cardNumber!: string;
}
```

신용카드 결제를 매장 정보와 함께 조회해보세요:

```typescript
const cards = await em.find(CreditCardPayment, {
  relations: ["store"],
});
```

**생성된 SQL (PostgreSQL):**

```sql
SELECT
  "payment"."id",
  "payment"."amount",
  "payment"."storeId",
  "payment"."payment_type",
  "payment"."cardNumber",
  "payment"."bankCode",
  "store"."id"   AS "store__id",
  "store"."name" AS "store__name"
FROM "payment"
LEFT JOIN "store" AS "store" ON "payment"."storeId" = "store"."id"
WHERE "payment"."payment_type" = 'credit_card';
```

**Raw SQL 결과:**

```
| payment_id | payment_amount | payment_payment_type | payment_cardNumber  | payment_bankCode | store_id | store_name     |
|------------|----------------|----------------------|---------------------|------------------|----------|----------------|
|          1 |            100 | credit_card          | 4111-1111-1111-1111 | NULL             |        1 | ElectronicsMart |
```

**역직렬화된 결과:**

```typescript
// cards is:
[
  CreditCardPayment {
    id: 1,
    amount: 100,
    cardNumber: "4111-1111-1111-1111",
    store: Store { id: 1, name: "ElectronicsMart" }
  }
]
```

주목할 점: discriminator WHERE 절(`payment_type = 'credit_card'`)이 LEFT JOIN과 함께 결합돼요. `store` 프로퍼티는 `CreditCardPayment` 안에 중첩된 완전히 역직렬화된 `Store` 인스턴스예요.

루트를 다형성으로 조회할 때도 관계는 같은 방식으로 로드되고, 각 행은 여전히 자기 서브클래스로 반환됩니다. `em.find(Payment, { relations: ["store"] })`는 `store`가 채워진 `CreditCardPayment`와 `BankTransferPayment` 인스턴스를 돌려줘요.

### 서브클래스가 선언한 관계

자식은 상속받은 관계 외에 자기만의 관계를 선언할 수 있습니다. 그 조인 컬럼은 자식의 다른 컬럼처럼 공유 테이블에 놓이고, 역시 nullable입니다. 다른 서브타입의 행은 이 컬럼을 비워 두기 때문에 `@RelationColumn({ nullable })` 설정과 관계없이 그렇습니다.

```typescript
@Entity()
@DiscriminatorValue("credit_card")
export class CreditCardPayment extends Payment {
  @Column({ nullable: true }) cardNumber!: string;

  @ManyToOne(() => Bank, (b) => b.cards)
  @RelationColumn({ name: "issuer_id" })
  issuer!: Bank; // payment.issuer_id, 다른 결제 유형에서는 NULL
}

const cards = await em.find(CreditCardPayment, { relations: ["store", "issuer"] });
```

### 계층을 대상으로 하는 관계

다른 엔티티의 관계는 루트를 가리킬 수도, 서브타입 하나를 가리킬 수도 있습니다. 서브타입을 가리키는 관계는 그 서브타입의 행만 읽습니다. `find(CreditCardPayment)`처럼 JOIN이나 배치 읽기에 판별자 조건을 붙이기 때문에 `Store.cardPayments`에는 계좌 이체가 섞이지 않아요. 루트를 가리키는 관계는 `find(Payment)`처럼 각 행을 그 서브클래스의 모양으로 만듭니다. 이 규칙은 관계를 읽는 모든 경로에 적용됩니다. ManyToOne·소유 측 OneToOne의 JOIN, OneToMany·ManyToMany·역방향 OneToOne의 배치 읽기, 커서 페이지의 to-one 읽기, 쿼리 빌더의 조인(`leftJoinRelationAndSelect()`, `leftJoinAndSelect(CreditCardPayment, ...)`)이 모두 해당하고, 형제 서브타입의 행을 가리키는 키는 아무것도 조인하지 않아요.

```typescript
@Entity()
export class Store {
  @OneToMany(() => Payment, (p) => p.store) payments!: Payment[];                         // 모든 서브타입, 각자의 클래스로
  @OneToMany(() => CreditCardPayment, (p) => p.store) cardPayments!: CreditCardPayment[]; // credit_card 행만
}
```

## SELECT -- findOne 사용

`findOne`은 `find`와 완전히 동일하게 작동하지만 단일 엔티티 또는 `null`을 반환해요.

```typescript
const cc = await em.findOne(CreditCardPayment, {
  where: { amount: 100 },
});
```

**생성된 SQL (PostgreSQL):**

```sql
SELECT * FROM "payment"
WHERE "payment_type" = 'credit_card' AND "amount" = 100
LIMIT 1;
```

**Raw SQL 결과:**

```
| id | amount | payment_type | cardNumber          | bankCode |
|----|--------|------------- |---------------------|----------|
|  1 |    100 | credit_card  | 4111-1111-1111-1111 | NULL     |
```

**역직렬화된 결과:**

```typescript
// cc is:
CreditCardPayment { id: 1, amount: 100, cardNumber: "4111-1111-1111-1111" }
// (매칭되는 결과가 없으면 null)
```

주목할 점: 두 조건이 AND로 결합돼요. discriminator 필터가 항상 먼저 오고, 그 다음에 사용자의 WHERE 절이 와요.

## SELECT -- QueryBuilder 사용

`SelectQueryBuilder`는 STI 상속 로직을 **자동으로 적용**해요. `em.createQueryBuilder()`로 자식 엔티티를 사용하면 discriminator WHERE 절이 자동으로 주입돼요. 루트 엔티티를 조회하면 polymorphic 역직렬화가 올바른 서브클래스 인스턴스를 반환해요.

**자식 엔티티 쿼리:**

```typescript
const cards = await em
  .createQueryBuilder(CreditCardPayment, "p")
  .where("amount", 100)
  .getMany();
```

**생성된 SQL (PostgreSQL):**

```sql
SELECT "p".* FROM "payment" AS "p"
WHERE "p"."payment_type" = 'credit_card' AND "p"."amount" = $1;
```

discriminator 필터 `payment_type = 'credit_card'`가 자동으로 추가돼요 -- 직접 지정할 필요가 없어요.

**Raw SQL 결과:**

```
| id | amount | payment_type | cardNumber          | bankCode |
|----|--------|--------------|---------------------|----------|
|  1 |    100 | credit_card  | 4111-1111-1111-1111 | NULL     |
```

**역직렬화된 결과:**

```typescript
// cards is:
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
SELECT "p".* FROM "payment" AS "p";
```

**역직렬화된 결과:**

```typescript
// all is:
[
  CreditCardPayment  { id: 1, amount: 100, cardNumber: "4111-1111-1111-1111" },
  BankTransferPayment { id: 2, amount: 200, bankCode: "SWIFT123" },
  Payment             { id: 3, amount: 50 }
]
// 각 요소가 올바른 서브클래스 인스턴스예요 -- instanceof 체크가 작동해요.
```

QueryBuilder가 각 행의 discriminator 값을 읽고 올바른 TypeScript 클래스를 인스턴스화해요. `em.find()`와 동일한 방식이에요. 모든 QueryBuilder 메서드(`getMany()`, `getOne()`, `getCount()`, `exists()`)가 이 polymorphic 역직렬화를 지원해요.

## SELECT -- WriteBuffer 사용

WriteBuffer 플러그인(Unit of Work)은 `EntityManager.find()`에 투명하게 위임해요. discriminator WHERE, polymorphic 역직렬화 등 모든 상속 로직이 완전히 동일하게 작동해요.

```typescript
const buf = em.buffer();

const cards = await buf.find(CreditCardPayment, {});
// 투명하게 동작 -- em.find()에 위임하고, identity map이 결과를 추적해요
```

**생성된 SQL:** `em.find(CreditCardPayment, {})`와 동일해요 -- 위를 참고하세요.

**역직렬화된 결과:**

```typescript
// cards is:
[
  CreditCardPayment { id: 1, amount: 100, cardNumber: "4111-1111-1111-1111" }
]
// WriteBuffer의 identity map이 이제 이 엔티티를 추적해요.
// 같은 PK로 findOne()을 다시 호출하면 identity map에서 가져오고, DB를 건너뛰어요.
```

Polymorphic 조회도 작동해요:

```typescript
const all = await buf.find(Payment, {});
// all은 CreditCardPayment, BankTransferPayment, Payment 인스턴스를 포함해요
// 각각 identity map에서 개별적으로 추적돼요

console.log(JSON.stringify(all, null, 2));
// [
//   {
//     "id": 1,
//     "amount": 100,
//     "cardNumber": "4111-1111-1111-1111"
//   },
//   {
//     "id": 2,
//     "amount": 200,
//     "bankCode": "SWIFT123"
//   },
//   {
//     "id": 3,
//     "amount": 50
//   }
// ]
```

## UPDATE

STI 엔티티를 업데이트할 때 discriminator 컬럼은 SET 절에서 **제외**돼요. 컬럼을 업데이트해서 CreditCardPayment를 BankTransferPayment로 바꿀 수 없어요 -- discriminator는 불변이에요.

```typescript
const cc = await em.findOne(CreditCardPayment, { where: { id: 1 } });
cc.amount = 200;
await em.save(CreditCardPayment, cc);
```

**생성된 SQL (PostgreSQL):**

```sql
UPDATE "payment"
SET "amount" = 200, "cardNumber" = '4111-1111-1111-1111'
WHERE "id" = 1 AND "payment_type" = 'credit_card';
```

**생성된 SQL (MySQL):**

```sql
UPDATE `payment`
SET `amount` = 200, `cardNumber` = '4111-1111-1111-1111'
WHERE `id` = 1 AND `payment_type` = 'credit_card';
```

**반환된 엔티티:**

```typescript
// cc is:
CreditCardPayment { id: 1, amount: 200, cardNumber: "4111-1111-1111-1111" }
```

주목할 점: `payment_type`은 SET 절에 **없어요**. 비즈니스 컬럼만 나타나요. ORM이 UPDATE 문을 빌드할 때 discriminator 컬럼을 명시적으로 필터링해요.

대신 WHERE 절에는 discriminator가 들어갑니다. 다른 서브타입 행의 키를 주면 아무 행도 맞지 않으므로, `save()`는 그 행을 덮어쓰지 않고 없는 키를 줬을 때처럼 `EntityNotFoundError`를 던집니다.

```typescript
await em.save(CreditCardPayment, { id: 2, amount: 1 }); // id 2는 BankTransferPayment
// EntityNotFoundError: save() attempted an UPDATE but no row matched the
// primary key as a 'CreditCardPayment' row.
```

## DELETE

자식 엔티티를 삭제할 때 discriminator가 안전장치로 WHERE 절에 추가돼요. 같은 ID를 가진 다른 타입의 행을 실수로 삭제하는 것을 방지해요.

```typescript
await em.delete(CreditCardPayment, { id: 1 });
```

**생성된 SQL (PostgreSQL):**

```sql
DELETE FROM "payment"
WHERE "id" = 1 AND "payment_type" = 'credit_card';
```

**생성된 SQL (MySQL):**

```sql
DELETE FROM `payment`
WHERE `id` = 1 AND `payment_type` = 'credit_card';
```

주목할 점: auto-increment ID는 테이블 전체에서 고유하므로, 어떤 ID든 다른 서브타입의 행을 가리킬 수 있습니다. 이 서브타입에만 쓰기가 닿게 하는 것이 discriminator 조건입니다. 루트 엔티티를 통해 삭제하면(`em.delete(Payment, { id: 1 })`) discriminator 필터가 추가되지 않아요.

자식 엔티티로 하는 다른 쓰기도 같은 규칙을 따릅니다. `deleteMany()`, `update()` / `updateMany()`, `increment()` / `decrement()`, `softDelete()` / `restore()`, `createUpdateBuilder()` 모두 WHERE 절에 discriminator를 붙여요. 자식 엔티티의 `clear()`는 그 서브타입의 행만 지웁니다.

```typescript
await em.clear(CreditCardPayment);
```

```sql
DELETE FROM "payment" WHERE "payment_type" = 'credit_card';
```

루트인 `em.clear(Payment)`는 테이블의 모든 행을 지웁니다.

## 장단점

| 장점 | 단점 |
|------|------|
| 가장 빠른 쿼리 -- JOIN도 UNION도 없어요 | 자식 컬럼이 nullable이어야 해요 |
| 가장 단순한 스키마 -- 테이블 하나 | NULL 컬럼으로 저장 공간이 낭비돼요 |
| Polymorphic 쿼리가 간단해요 | 자식 타입이 많으면 테이블이 넓어져요 |
| INSERT/UPDATE/DELETE가 단일 문이에요 | 자식 필드에 DB 수준 NOT NULL을 적용할 수 없어요 |
| `instanceof` 체크가 런타임에 작동해요 | 자식 타입이 10개 이상이면 스키마가 복잡해져요 |
| 하나의 인덱스가 전체 계층을 커버해요 | 자식 전용 컬럼에 모든 행에 걸쳐 UNIQUE 제약 조건을 걸 수 없어요 |

## STI를 사용해야 할 때

STI를 사용하면 좋은 경우:

- 자식 전용 컬럼이 **적을 때** (자식당 1-3개). 각 자식이 10개 컬럼을 추가하면 NULL로 가득 찬 50개 컬럼 테이블이 돼요.
- **빠른 polymorphic 쿼리**가 필요할 때. `em.find(Payment, {})`를 조회하면 JOIN이나 UNION ALL 없이 모든 타입을 반환해요.
- 자식 타입 수가 **적을 때** (2-5개). 20개 타입이면 단일 테이블이 다루기 어려워져요.
- **간단한 스키마 관리**를 원할 때. 하나의 테이블이 백업, 인덱싱, 이해하기가 더 쉬워요.

STI를 피해야 할 경우:

- 자식 타입에 **고유한 컬럼이 많을 때**. 정규화된 스키마를 위해 [Joined / TPT](./inheritance-mapping)로 전환하세요.
- 루트 엔티티를 거의 조회하지 않을 때. 타입별 최대 쿼리 속도를 위해 [Table Per Class / TPC](./inheritance-mapping)로 전환하세요.
- 자식 컬럼에 **NOT NULL 제약 조건**이 필요할 때. STI는 nullable을 강제해요.

> **힌트** 실용적인 경험 법칙: 모든 타입의 자식 전용 컬럼 합계가 10개를 넘으면 TPT를 고려해보세요.

## 다음 단계

- [상속 매핑](./inheritance-mapping) -- 세 가지 전략(STI, TPT, TPC) 개요
- [관계(Relations)](./relations) -- @ManyToOne, @OneToMany, @ManyToMany, @OneToOne
- [EntityManager](./entity-manager) -- find, save, delete, 집계, 페이지네이션
- [Write Buffer](./write-buffer) -- Unit of Work 패턴과 dirty tracking
- [Query Builder](./query-builder) -- JOIN, GROUP BY, 서브쿼리를 활용한 복잡한 SQL
