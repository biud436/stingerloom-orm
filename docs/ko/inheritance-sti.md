# Single Table Inheritance (STI) -- 심층 가이드

**Single Table Inheritance**는 부모와 모든 자식을 포함한 클래스 계층 구조 전체를 데이터베이스 테이블 하나에 매핑하는 전략입니다. 각 행이 어느 타입인지는 구분 컬럼(discriminator column)으로 가려냅니다.

가족이 방 하나를 함께 쓰는 것과 비슷합니다. 모두 같은 방에서 잡니다. 하지만 각자 이름표를 달고 있어서 누가 누구인지 알 수 있습니다. 방이 테이블이고 이름표가 구분 컬럼입니다.

세 가지 상속 전략(STI, TPT, TPC)을 전체적으로 비교하려면 [상속 매핑 개요](./inheritance-mapping)부터 읽으세요.

## 스키마

STI를 쓰면 Stingerloom은 모든 자식의 컬럼을 CREATE TABLE 문 하나로 합칩니다. 그리고 각 행이 어느 클래스에 속하는지 식별하도록 구분 컬럼을 추가합니다.

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

눈여겨볼 점은 세 가지입니다.

1. 모든 자식의 컬럼이 테이블 하나에 들어갑니다. `CreditCardPayment`의 `cardNumber`와 `BankTransferPayment`의 `bankCode`가 그 예입니다.
2. `payment_type` 컬럼이 구분 컬럼입니다. 이 컬럼에는 `'credit_card'`, `'bank_transfer'`, 또는 루트 클래스 이름이 저장됩니다.
3. 자식 전용 컬럼은 nullable입니다. 신용카드 행은 `bankCode = NULL`이 되고 계좌이체 행은 그 반대이기 때문입니다.

## 엔티티 정의

데코레이터 세 개가 함께 동작합니다.

- 루트에 붙인 `@Inheritance`는 전략을 설정합니다.
- `@DiscriminatorColumn`은 구분 컬럼을 설정합니다.
- 각 자식에 붙인 `@DiscriminatorValue`는 그 자식의 구분 값을 지정합니다.

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

설정에는 루트와 모든 자식을 포함한 모든 엔티티를 등록해야 합니다.

```typescript
await em.register({
  type: "postgres",
  entities: [Payment, CreditCardPayment, BankTransferPayment],
  synchronize: true,
});
```

::: warning
자식 전용 컬럼은 반드시 `nullable: true`여야 합니다. CreditCardPayment 행은 `bankCode = NULL`이 되고 BankTransferPayment 행은 `cardNumber = NULL`이 됩니다. NOT NULL로 지정하면 다른 타입의 INSERT가 제약 조건 위반으로 실패합니다.
:::

`@DiscriminatorColumn`을 생략하면 Stingerloom은 기본값으로 `"dtype"`이라는 이름의 `VARCHAR(31)` 타입 컬럼을 만듭니다. 자식에 `@DiscriminatorValue`를 생략하면 클래스 이름이 값으로 쓰입니다. 예를 들면 `"CreditCardPayment"`입니다.

자식은 루트의 테이블을 함께 쓰므로 자기 테이블 이름을 따로 가질 수 없습니다. 자식에 루트 테이블과 다른 이름으로 `@Entity({ name: "..." })`을 붙이면 클래스를 선언하는 시점에 ORM이 `ORM_SCHEMA_ERROR`를 던집니다.

## INSERT -- Discriminator 값이 설정되는 방식

구분 값은 직접 설정하지 않습니다. ORM이 `@DiscriminatorValue("credit_card")`에서 값을 읽어 모든 INSERT에 자동으로 주입합니다.

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

반환된 엔티티는 다음과 같습니다.

```typescript
// cc is:
CreditCardPayment {
  id: 1,
  amount: 100,
  cardNumber: "4111-1111-1111-1111"
}
```

주목할 점: `payment_type` 컬럼의 값 `'credit_card'`는 ORM이 설정한 것입니다. 구분 값은 TypeScript 객체의 속성으로 나타나지 않습니다. 비즈니스 데이터가 아니라 메타데이터이기 때문입니다.

SELECT 예제에 쓸 데이터로 계좌이체 결제와 루트 결제도 삽입해 두겠습니다.

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

루트 엔티티의 행에도 구분 값이 들어갑니다. `Payment`에는 `@DiscriminatorValue`가 없으므로 클래스 이름 `"Payment"`가 쓰입니다.

```sql
INSERT INTO "payment" ("amount", "payment_type")
VALUES (50, 'Payment')
RETURNING *;
```

### 모든 INSERT 경로가 같은 값을 씁니다

어떤 메서드로 쓰든 모든 행에 같은 값이 들어갑니다. `save()`, `saveMany()`, `insertMany()`, `insertManyAndReturn()`, `upsert()`, `insertIgnore()`, `batchUpsert()`, `createInsertBuilder()`, 그리고 WriteBuffer flush까지 전부입니다. 페이로드에 구분 컬럼 값을 적어도 ORM이 엔티티의 구분 값으로 덮어씁니다.

```typescript
await em.insertMany(CreditCardPayment, [{ amount: 10 }, { amount: 20 }]);
```

```sql
INSERT INTO "payment" ("amount", "payment_type")
VALUES (10, 'credit_card'), (20, 'credit_card');
```

### 자식 엔티티로 upsert하기

모든 서브타입이 테이블 하나를 함께 쓰므로 키 공간도 하나입니다. `upsert()`, `batchUpsert()`, `createInsertBuilder().doUpdate()`의 충돌 분기는 같은 서브타입의 행만 갱신합니다. 충돌한 키가 다른 서브타입의 행이면 그 행은 그대로 두고 영향받지 않은 행으로 셉니다. PostgreSQL과 SQLite에서는 엔티티 클래스마다 한 번 경고도 남깁니다.

```typescript
// id 2는 위에서 삽입한 BankTransferPayment입니다
await em.upsert(CreditCardPayment, { id: 2, amount: 999 });
// { affected: 0 }: 계좌이체 행은 그대로입니다
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

`em.upsert(Payment, ...)`처럼 루트로 upsert하면 키를 가진 행이 어느 서브타입이든 갱신합니다. 이때 그 행의 구분 값은 건드리지 않습니다.

## SELECT -- 자식 엔티티 조회 (em.find)

자식 엔티티를 조회하면 ORM이 구분 값으로 거르는 `WHERE` 절을 자동으로 추가합니다. 그래서 다른 타입의 행은 결과에 나오지 않습니다.

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

주목할 점: BankTransferPayment에 속하는 컬럼인 `bankCode`는 결과 객체에 없습니다. ORM은 `CreditCardPayment` 클래스에 속하는 컬럼만 매핑합니다. 다른 형제 타입의 NULL 컬럼은 역직렬화 과정에서 버려집니다.

## SELECT -- Polymorphic Query (루트 엔티티)

루트 엔티티를 조회하면 구분 값 필터 없이 테이블의 모든 행을 반환합니다. ORM은 각 행의 구분 값을 읽고 알맞은 TypeScript 클래스의 인스턴스를 만듭니다.

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

// 런타임 타입 검사가 동작합니다:
all[0] instanceof CreditCardPayment  // true
all[1] instanceof BankTransferPayment // true
all[2] instanceof Payment             // true

// console.log로 전체 출력을 확인할 수 있습니다:
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

주목할 점: 배열의 각 요소는 알맞은 서브클래스의 인스턴스입니다. `CreditCardPayment` 객체에는 `cardNumber`가 있지만 `bankCode`는 없습니다. `BankTransferPayment` 객체에는 `bankCode`가 있지만 `cardNumber`는 없습니다. 루트 `Payment` 객체에는 둘 다 없습니다.

서브클래스가 선언한 관계의 조인 컬럼도 공유 테이블에 있습니다. 그래서 루트 조회도 이 컬럼을 SELECT합니다. 그리고 그 서브클래스의 인스턴스는 `find(CreditCardPayment)`로 조회했을 때와 똑같이 외래 키 섀도 속성을 가집니다. `issuer` 관계가 있는 `CreditCardPayment`의 `issuerId`가 그 예입니다. 루트에서 `where: { issuerId }`로 거를 수도 있습니다.

### Polymorphic 역직렬화 작동 원리

ORM은 내부에서 각 행을 다음 순서로 처리합니다.

1. raw 행에서 `payment_type` 컬럼 값을 읽습니다.
2. 구분 값 맵을 조회합니다: `{ "credit_card" => CreditCardPayment, "bank_transfer" => BankTransferPayment, "Payment" => Payment }`
3. 맞는 클래스 생성자를 찾습니다.
4. 그 클래스의 인스턴스를 만들고 관련 컬럼만 매핑합니다.
5. 컬럼 트랜스포머가 있으면 적용합니다.

이 로직은 `ResultTransformer.toPolymorphicEntities()`에 있습니다. 구분 값 맵은 `InheritanceResolver.buildDiscriminatorMap()`에서 한 번 만들어지고 쿼리 동안 캐시됩니다.

## SELECT -- Relations와 함께

상속 엔티티는 표준 `@ManyToOne`과 `@OneToMany` 관계를 지원합니다. 모든 자식이 관계를 상속받도록 루트 엔티티에 관계를 정의하세요.

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

  // 외래 키 컬럼은 위의 storeId @Column에서 자동으로 감지됩니다
  @ManyToOne(() => Store, (s) => s.payments)
  store!: Store;
}

@Entity()
@DiscriminatorValue("credit_card")
export class CreditCardPayment extends Payment {
  @Column({ nullable: true }) cardNumber!: string;
}
```

이제 신용카드 결제를 매장 정보와 함께 조회합니다.

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

주목할 점: 구분 값 WHERE 절 `payment_type = 'credit_card'`가 LEFT JOIN과 함께 쓰입니다. `store` 속성은 `CreditCardPayment` 안에 중첩된 `Store` 인스턴스이며 완전히 역직렬화되어 있습니다.

루트를 다형성으로 조회할 때도 관계는 같은 방식으로 로드됩니다. 그리고 각 행은 여전히 자기 서브클래스로 반환됩니다. `em.find(Payment, { relations: ["store"] })`는 `store`가 채워진 `CreditCardPayment` 인스턴스와 `BankTransferPayment` 인스턴스를 반환합니다.

### 서브클래스가 선언한 관계

자식은 상속받은 관계 외에 자기 관계를 선언할 수 있습니다. 그 조인 컬럼은 자식의 다른 컬럼처럼 공유 테이블에 놓입니다. 그리고 역시 nullable입니다. 다른 서브타입의 행은 이 컬럼을 비워 두기 때문입니다. 이 규칙은 `@RelationColumn({ nullable })` 설정과 관계없이 적용됩니다.

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

다른 엔티티의 관계는 루트를 가리킬 수도 있고 서브타입 하나를 가리킬 수도 있습니다. 서브타입을 가리키는 관계는 그 서브타입의 행만 읽습니다. `find(CreditCardPayment)`처럼 JOIN이나 배치 조회에 구분 값 조건을 붙이기 때문입니다. 그래서 `Store.cardPayments`에는 계좌이체 결제가 섞이지 않습니다. 루트를 가리키는 관계는 `find(Payment)`처럼 각 행을 그 서브클래스의 모양으로 만듭니다. 이 규칙은 관계를 읽는 모든 경로에 적용됩니다.

- ManyToOne과 소유 측 OneToOne의 JOIN
- OneToMany, ManyToMany, 역방향 OneToOne의 배치 조회
- 커서 페이지의 to-one 조회
- 쿼리 빌더의 조인(`leftJoinRelationAndSelect()`, `leftJoinAndSelect(CreditCardPayment, ...)`)

이 경로에서 형제 서브타입의 행을 가리키는 키는 아무 행도 조인하지 않습니다.

```typescript
@Entity()
export class Store {
  @OneToMany(() => Payment, { mappedBy: "store" }) payments!: Payment[];                         // 모든 서브타입, 각자의 클래스로
  @OneToMany(() => CreditCardPayment, { mappedBy: "store" }) cardPayments!: CreditCardPayment[]; // credit_card 행만
}
```

## SELECT -- findOne 사용

`findOne`은 `find`와 똑같이 동작합니다. 다만 엔티티 하나나 `null`을 반환합니다.

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

주목할 점: 구분 값 조건과 `amount` 조건이 AND로 묶입니다. 구분 값 필터가 항상 먼저 오고 그다음에 사용자가 지정한 WHERE 조건이 옵니다.

## SELECT -- QueryBuilder 사용

`SelectQueryBuilder`는 STI 상속 로직을 자동으로 적용합니다. `em.createQueryBuilder()`에 자식 엔티티를 넘기면 구분 값 WHERE 절이 자동으로 들어갑니다. 루트 엔티티를 조회하면 다형성 역직렬화로 알맞은 서브클래스 인스턴스를 반환합니다.

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

구분 값 필터 `payment_type = 'credit_card'`는 자동으로 추가됩니다. 직접 지정할 필요가 없습니다.

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

**다형성 루트 엔티티 쿼리:**

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
// 각 요소는 알맞은 서브클래스의 인스턴스이므로 instanceof 검사를 통과합니다.
```

QueryBuilder는 각 행의 구분 값을 읽고 알맞은 TypeScript 클래스의 인스턴스를 만듭니다. `em.find()`와 같은 방식입니다. 모든 QueryBuilder 메서드(`getMany()`, `getOne()`, `getCount()`, `exists()`)가 이 다형성 역직렬화를 지원합니다.

## SELECT -- WriteBuffer 사용

WriteBuffer 플러그인(Unit of Work)은 조회를 그대로 `EntityManager.find()`에 위임합니다. 그래서 구분 값 WHERE 절과 다형성 역직렬화를 비롯한 모든 상속 로직이 똑같이 동작합니다.

```typescript
const buf = em.buffer();

const cards = await buf.find(CreditCardPayment, {});
// em.find()에 위임하고 Identity Map이 결과를 추적합니다
```

**생성된 SQL:** `em.find(CreditCardPayment, {})`와 같습니다. 위 예제를 참고하세요.

**역직렬화된 결과:**

```typescript
// cards is:
[
  CreditCardPayment { id: 1, amount: 100, cardNumber: "4111-1111-1111-1111" }
]
// 이제 WriteBuffer의 Identity Map이 이 엔티티를 추적합니다.
// 같은 기본 키로 findOne()을 다시 호출하면 DB를 건너뛰고 Identity Map에서 반환합니다.
```

다형성 조회도 동작합니다.

```typescript
const all = await buf.find(Payment, {});
// all에는 CreditCardPayment, BankTransferPayment, Payment 인스턴스가 들어 있습니다
// Identity Map은 각 인스턴스를 따로 추적합니다

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

STI 엔티티를 갱신할 때 구분 컬럼은 SET 절에서 빠집니다. 컬럼 값을 갱신해서 CreditCardPayment를 BankTransferPayment로 바꿀 수는 없습니다. 구분 값은 바뀌지 않습니다.

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

주목할 점: `payment_type`은 SET 절에 없습니다. 비즈니스 컬럼만 나타납니다. ORM은 UPDATE 문을 만들 때 구분 컬럼을 명시적으로 걸러 냅니다.

대신 WHERE 절에는 구분 값 조건이 들어갑니다. 그래서 다른 서브타입 행의 키를 넘기면 아무 행도 매칭되지 않습니다. 이때 `save()`는 그 행을 덮어쓰지 않습니다. 대신 없는 키를 넘겼을 때처럼 `EntityNotFoundError`를 던집니다.

```typescript
await em.save(CreditCardPayment, { id: 2, amount: 1 }); // id 2는 BankTransferPayment
// EntityNotFoundError: save() attempted an UPDATE but no row matched the
// primary key as a 'CreditCardPayment' row.
```

## DELETE

자식 엔티티를 삭제할 때는 안전장치로 구분 값 조건이 WHERE 절에 추가됩니다. 이 조건은 우연히 같은 ID를 가진 다른 타입의 행을 실수로 삭제하는 일을 막습니다.

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

주목할 점: auto-increment ID는 테이블 전체에서 고유합니다. 그래서 어떤 ID든 다른 서브타입의 행을 가리킬 수 있습니다. 쓰기가 이 서브타입에만 적용되게 하는 것이 구분 값 조건입니다. `em.delete(Payment, { id: 1 })`처럼 루트 엔티티로 삭제하면 구분 값 필터가 추가되지 않습니다.

자식 엔티티로 하는 다른 쓰기도 같은 규칙을 따릅니다. `deleteMany()`, `update()` / `updateMany()`, `increment()` / `decrement()`, `softDelete()` / `restore()`, `createUpdateBuilder()` 모두 WHERE 절에 구분 값 조건을 붙입니다. 자식 엔티티의 `clear()`는 그 서브타입의 행만 삭제합니다.

```typescript
await em.clear(CreditCardPayment);
```

```sql
DELETE FROM "payment" WHERE "payment_type" = 'credit_card';
```

루트로 호출한 `em.clear(Payment)`는 테이블의 모든 행을 삭제합니다.

## 장단점

| 장점 | 단점 |
|------|------|
| 가장 빠른 쿼리입니다. JOIN도 UNION도 없습니다 | 자식 컬럼이 nullable이어야 합니다 |
| 가장 단순한 스키마입니다. 테이블이 하나뿐입니다 | NULL 컬럼 때문에 저장 공간이 낭비됩니다 |
| 다형성 쿼리가 간단합니다 | 자식 타입이 많으면 테이블이 넓어집니다 |
| INSERT/UPDATE/DELETE가 SQL 문 하나로 끝납니다 | 자식 필드에 DB 수준 NOT NULL을 적용할 수 없습니다 |
| `instanceof` 검사가 런타임에 동작합니다 | 자식 타입이 10개 이상이면 스키마가 복잡해집니다 |
| 인덱스 하나가 계층 전체를 커버합니다 | 자식 전용 컬럼에는 모든 행을 대상으로 하는 UNIQUE 제약 조건을 걸 수 없습니다 |

## STI를 사용해야 할 때

STI가 잘 맞는 경우는 다음과 같습니다.

- **자식 전용 컬럼이 적을 때.** 자식당 1~3개 정도입니다. 자식마다 컬럼을 10개씩 추가하면 NULL로 가득 찬 50개 컬럼짜리 테이블이 됩니다.
- **빠른 다형성 쿼리가 필요할 때.** `em.find(Payment, {})`는 JOIN이나 UNION ALL 없이 모든 타입을 반환합니다.
- **자식 타입 수가 적을 때.** 2~5개 정도입니다. 타입이 20개라면 테이블 하나로는 다루기 어려워집니다.
- **스키마를 간단하게 관리하고 싶을 때.** 테이블이 하나면 백업, 인덱싱, 이해가 더 쉽습니다.

STI를 피해야 하는 경우는 다음과 같습니다.

- **자식 타입마다 고유한 컬럼이 많을 때.** 정규화된 스키마를 쓰려면 [Joined / TPT](./inheritance-tpt.md)로 전환하세요.
- **루트 엔티티를 거의 조회하지 않을 때.** 타입별 쿼리 속도를 최대로 높이려면 [Table Per Class / TPC](./inheritance-tpc.md)로 전환하세요.
- **자식 컬럼에 NOT NULL 제약 조건이 필요할 때.** STI에서는 자식 컬럼이 nullable이어야 합니다.

> 힌트: 모든 타입의 자식 전용 컬럼을 합쳐 10개가 넘으면 TPT를 고려하세요. 실무에서 쓸 만한 경험 법칙입니다.

## 다음 단계

- [상속 매핑](./inheritance-mapping): 세 가지 전략(STI, TPT, TPC) 개요
- [관계(Relations)](./relations): @ManyToOne, @OneToMany, @ManyToMany, @OneToOne
- [EntityManager](./entity-manager): find, save, delete, 집계, 페이지네이션
- [Write Buffer](./write-buffer): Unit of Work 패턴과 변경 추적(dirty tracking)
- [Query Builder](./query-builder): JOIN, GROUP BY, 서브쿼리를 활용한 복잡한 SQL
