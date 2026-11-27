# 상속 매핑 (Inheritance Mapping)

**상속 매핑**(Inheritance Mapping)은 객체 지향 프로그래밍(OOP)의 상속을 관계형 데이터베이스(RDBMS)의 테이블 구조로 옮기는 기법입니다.

OOP에서는 `class Child extends Parent`라고 쓰면 자식이 부모의 필드와 메서드를 물려받습니다. 클래스 계층 구조가 깊어져도 언어가 이를 처리합니다. 하지만 RDBMS는 사정이 다릅니다. 테이블은 행과 컬럼으로 이루어진 평면 구조입니다. 그리고 한 테이블이 다른 테이블을 상속한다는 개념 자체가 없습니다. 부모와 자식의 관계도, 다형성(polymorphism)도, `instanceof`도 SQL에는 없습니다.

객체와 관계형 데이터베이스 사이의 이 간극을 **임피던스 불일치**(Object-Relational Impedance Mismatch)라고 부릅니다. ORM의 핵심 역할은 이 간극을 메우는 것입니다. 그중에서도 상속 매핑은 가장 복잡한 부분입니다. 구분 컬럼(discriminator column), JOIN, UNION ALL 같은 SQL 기법을 조합해서 OOP의 클래스 계층 구조를 RDBMS 위에 재현해야 하기 때문입니다.

아직 와닿지 않아도 괜찮습니다. 구체적인 문제를 먼저 보면 필요한 이유가 분명해집니다.

## 왜 상속 매핑이 필요할까?

온라인 결제 시스템을 만든다고 해 봅시다. 이 시스템은 신용카드 결제, 계좌이체 결제, 암호화폐 결제를 처리해야 합니다. 세 결제 방식 모두 `id`, `amount`, `createdAt` 같은 공통 필드를 가집니다. 그리고 방식마다 고유한 필드도 있습니다.

- **신용카드 결제:** `cardNumber`, `expiryDate`
- **계좌이체 결제:** `bankCode`, `accountNumber`
- **암호화폐 결제:** `walletAddress`, `networkFee`

상속 매핑 없이 해결하는 방법은 세 가지입니다. 하지만 셋 모두 문제가 있습니다.

### 시나리오 1: 엔티티를 따로따로 만든다

결제 유형마다 별도의 엔티티 클래스를 만듭니다. 공통 필드는 클래스마다 복사합니다.

```typescript
@Entity()
class CreditCardPayment {
  @PrimaryGeneratedColumn() id!: number;
  @Column() amount!: number;       // 중복
  @Column() cardNumber!: string;
}

@Entity()
class BankTransferPayment {
  @PrimaryGeneratedColumn() id!: number;
  @Column() amount!: number;       // 또 중복
  @Column() bankCode!: string;
}
```

새 공통 필드를 추가하면 세 클래스를 모두 수정해야 합니다. 전체 결제 내역 조회 같은 다형성 쿼리(polymorphic query)는 UNION ALL을 직접 작성해야 합니다. 그리고 중복된 코드에서는 버그가 쉽게 생깁니다.

### 시나리오 2: 하나의 거대한 테이블에 다 넣는다

모든 결제 유형의 컬럼을 테이블 하나에 모읍니다.

```typescript
@Entity()
class Payment {
  @PrimaryGeneratedColumn() id!: number;
  @Column() amount!: number;
  @Column({ nullable: true }) cardNumber!: string;   // 계좌이체에는 불필요
  @Column({ nullable: true }) bankCode!: string;     // 신용카드에는 불필요
  @Column({ nullable: true }) walletAddress!: string; // 둘 다 불필요
  @Column({ nullable: true }) type!: string;         // 타입 구분은 수동으로
}
```

동작은 합니다. 하지만 nullable 컬럼이 넘쳐나고 타입 안전성이 없습니다. `cardNumber`에 접근할 때 그 행이 정말 신용카드 결제인지 TypeScript로는 확인할 방법이 없기 때문입니다.

### 시나리오 3: TypeScript 상속만 쓴다

```typescript
class Payment {
  id!: number;
  amount!: number;
}

class CreditCardPayment extends Payment {
  cardNumber!: string;
}
```

TypeScript 수준에서는 깔끔합니다. 하지만 이 상속 관계가 ORM에 매핑되어 있지 않으면 의미가 없습니다. `em.find(Payment, {})` 같은 다형성 쿼리를 실행해도 ORM이 각 행을 알맞은 서브클래스 인스턴스로 변환하지 못합니다.

상속 매핑은 이 세 문제를 함께 해결합니다. ORM이 TypeScript 상속 구조를 데이터베이스 스키마에 자동으로 매핑합니다. 그리고 CRUD 연산마다 구분 컬럼 처리, JOIN, UNION ALL을 자동으로 생성합니다.

## 역사와 배경

상속 매핑은 Martin Fowler가 2003년에 출판한 *Patterns of Enterprise Application Architecture*에서 체계화됐습니다. Fowler는 이 책에서 객체 지향 상속을 관계형 데이터베이스에 매핑하는 패턴 세 가지를 제시했습니다.

- **Single Table Inheritance**: 한 테이블에 모두 저장하고 구분 컬럼으로 타입을 구분합니다.
- **Class Table Inheritance**: 부모 테이블과 자식 테이블을 분리하고 JOIN으로 조합합니다.
- **Concrete Table Inheritance**: 각 클래스가 독립된 테이블을 가집니다.

ORM 생태계에서는 이 세 가지가 `SINGLE_TABLE`, `JOINED`, `TABLE_PER_CLASS`라는 이름으로 널리 쓰이면서 20년 넘게 다듬어졌습니다.

Stingerloom ORM은 같은 세 가지 전략을 같은 이름으로 채택했습니다. 데코레이터는 `@Inheritance`, `@DiscriminatorColumn`, `@DiscriminatorValue` 세 개입니다.

## 전략 비교

| 전략 | 데코레이터 | 테이블 수 | 다형성 쿼리 | 적합한 상황 |
|------|-----------|----------|-------------------|------------|
| Single Table (STI) | `@Inheritance({ strategy: "SINGLE_TABLE" })` | 1개 (공유) | 빠름 (JOIN 없음) | 계층이 단순하고 자식 고유 컬럼이 적을 때 |
| Joined / Table Per Type (TPT) | `@Inheritance({ strategy: "JOINED" })` | 1 + N개 (부모 + 자식) | 보통 (JOIN 필요) | 정규화가 중요하고 자식 고유 컬럼이 많을 때 |
| Table Per Class (TPC) | `@Inheritance({ strategy: "TABLE_PER_CLASS" })` | N개 (독립) | 느림 (UNION ALL) | 자식 엔티티가 독립적이고 다형성 쿼리가 드물 때 |

## Quick Start

상속 매핑에는 데코레이터 세 개가 필요합니다.

```typescript
import {
  Entity, PrimaryGeneratedColumn, Column,
  Inheritance, DiscriminatorColumn, DiscriminatorValue,
} from "@stingerloom/orm";

// 1. 루트 엔티티: 전략과 구분 컬럼을 정의
@Entity()
@Inheritance({ strategy: "SINGLE_TABLE" })
@DiscriminatorColumn({ name: "payment_type", type: "varchar", length: 50 })
export class Payment {
  @PrimaryGeneratedColumn() id!: number;
  @Column() amount!: number;
}

// 2. 자식 엔티티: 루트를 상속하고 구분 값을 지정
@Entity()
@DiscriminatorValue("credit_card")
export class CreditCardPayment extends Payment {
  @Column({ nullable: true }) cardNumber!: string;
}

@Entity()
@DiscriminatorValue("bank_transfer")
export class BankTransferPayment extends Payment {
  @Column({ nullable: true }) bankCode!: string;
}
```

루트 엔티티와 자식 엔티티를 모두 등록해야 합니다.

```typescript
await em.register({
  type: "postgres",
  // ...
  entities: [Payment, CreditCardPayment, BankTransferPayment],
  synchronize: true,
});
```

## Strategy 1: Single Table Inheritance (STI)

계층 구조의 모든 클래스가 데이터베이스 테이블 하나를 공유합니다. 각 행의 타입은 구분 컬럼에 기록됩니다.

방 하나를 여러 사람이 함께 쓰면서 이름표로 누구의 물건인지 구분하는 것과 비슷합니다. 이 이름표가 구분 컬럼입니다.

### 스키마

**PostgreSQL:**

```sql
CREATE TABLE "payment" (
  "id"           SERIAL PRIMARY KEY,
  "amount"       INT NOT NULL,
  "payment_type" VARCHAR(50),       -- 구분 컬럼
  "cardNumber"   VARCHAR(255),      -- CreditCardPayment 전용 (nullable)
  "bankCode"     VARCHAR(255)       -- BankTransferPayment 전용 (nullable)
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

테이블이 하나이므로 스키마가 단순합니다. 다만 `cardNumber`와 `bankCode`가 모두 nullable입니다. 계좌이체 결제 행에서는 `cardNumber`가 NULL이고 신용카드 결제 행에서는 `bankCode`가 NULL이기 때문입니다.

### 엔티티 정의

```typescript
@Entity()
@Inheritance({ strategy: "SINGLE_TABLE" })
@DiscriminatorColumn({ name: "payment_type" })
export class Payment {
  @PrimaryGeneratedColumn() id!: number;
  @Column() amount!: number;
}

@Entity()
@DiscriminatorValue("credit_card")
export class CreditCardPayment extends Payment {
  @Column({ nullable: true }) cardNumber!: string;
}

@Entity()
@DiscriminatorValue("bank_transfer")
export class BankTransferPayment extends Payment {
  @Column({ nullable: true }) bankCode!: string;
}
```

::: warning
자식 엔티티의 고유 컬럼은 반드시 nullable이어야 합니다. 다른 타입의 행에서는 그 컬럼이 NULL이 되기 때문입니다. `nullable: true`를 빠뜨리면 INSERT할 때 데이터베이스가 NOT NULL 제약 조건 위반 에러를 냅니다.
:::

### CRUD 연산과 생성되는 SQL

**INSERT**: 구분 값이 자동으로 설정됩니다.

```typescript
const cc = await em.save(CreditCardPayment, {
  amount: 100,
  cardNumber: "4111-1111-1111-1111",
});
// Generated SQL: INSERT INTO "payment" ("amount", "cardNumber", "payment_type")
//                VALUES (100, '4111-1111-1111-1111', 'credit_card')
```

`payment_type`에는 `'credit_card'`가 자동으로 들어갑니다. 직접 지정할 필요가 없습니다.

**SELECT (자식)**: 구분 컬럼 조건이 자동으로 추가됩니다.

```typescript
const cards = await em.find(CreditCardPayment, {});
// Generated SQL: SELECT * FROM "payment" WHERE "payment_type" = 'credit_card'
```

**SELECT (루트, 다형성)**: 모든 타입의 행이 알맞은 서브클래스 인스턴스로 반환됩니다.

```typescript
const all = await em.find(Payment, {});
// Generated SQL: SELECT * FROM "payment"
```

모든 행이 테이블 하나에 있으므로 JOIN이나 UNION 없이 `SELECT *`로 충분합니다. ORM은 각 행의 `payment_type` 값을 읽어서 알맞은 서브클래스 인스턴스를 생성합니다.

```typescript
console.log(JSON.stringify(all, null, 2));
// [
//   { "id": 1, "amount": 100, "cardNumber": "4111-1111-1111-1111" },
//   { "id": 2, "amount": 200, "bankCode": "SWIFT123" }
// ]

all[0] instanceof CreditCardPayment;  // true
all[1] instanceof BankTransferPayment; // true
```

`JSON.stringify` 결과에는 `payment_type`이 없습니다. 구분 컬럼은 ORM 내부에서만 사용하고 엔티티 속성으로 노출하지 않기 때문입니다. 대신 각 객체는 알맞은 서브클래스의 인스턴스입니다. 그래서 `instanceof` 연산자로 타입을 구분할 수 있습니다.

**UPDATE**: 구분 컬럼은 SET 절에서 제외됩니다.

```typescript
cc.amount = 200;
await em.save(CreditCardPayment, cc);
// Generated SQL: UPDATE "payment" SET "amount" = 200 WHERE "id" = 1
```

**DELETE**: 구분 컬럼 조건이 자동으로 추가됩니다.

```typescript
await em.delete(CreditCardPayment, { id: cc.id });
// Generated SQL: DELETE FROM "payment" WHERE "id" = 1 AND "payment_type" = 'credit_card'
```

### 장단점

| 장점 | 단점 |
|------|------|
| 가장 빠른 쿼리 (JOIN이나 UNION 없음) | 자식 컬럼이 반드시 nullable |
| 스키마가 단순함 | NULL 컬럼으로 저장 공간 낭비 |
| 다형성 쿼리가 간단함 | 자식 타입이 많아지면 테이블이 넓어짐 |

## Strategy 2: Joined / Table Per Type (TPT)

루트 엔티티는 공통 컬럼을 담은 자기 테이블을 가집니다. 각 자식 엔티티는 고유 컬럼만 담은 별도의 테이블을 가집니다. 자식 테이블의 기본 키는 루트 테이블을 참조하는 외래 키 역할도 합니다.

가족이 거실은 함께 쓰고 방은 각자 따로 쓰는 것과 비슷합니다. 거실이 루트 테이블이고 개인 방이 자식 테이블입니다. 한 사람의 정보를 모두 보려면 거실과 개인 방을 함께 봐야 합니다. 마찬가지로 엔티티 하나의 데이터를 모두 읽으려면 JOIN이 필요합니다.

### 스키마

**PostgreSQL:**

```sql
-- 루트 테이블
CREATE TABLE "payment" (
  "id"           SERIAL PRIMARY KEY,
  "amount"       INT NOT NULL,
  "payment_type" VARCHAR(50)       -- 구분 컬럼
);

-- 자식 테이블 (고유 컬럼 + 루트를 참조하는 기본 키)
CREATE TABLE "credit_card_payment" (
  "id"         INT PRIMARY KEY REFERENCES "payment"("id"),
  "cardNumber" VARCHAR(255) NOT NULL
);

CREATE TABLE "bank_transfer_payment" (
  "id"       INT PRIMARY KEY REFERENCES "payment"("id"),
  "bankCode" VARCHAR(255) NOT NULL
);
```

**MySQL:**

```sql
CREATE TABLE `payment` (
  `id`           INT NOT NULL AUTO_INCREMENT,
  `amount`       INT NOT NULL,
  `payment_type` VARCHAR(50),
  PRIMARY KEY (`id`)
);

CREATE TABLE `credit_card_payment` (
  `id`         INT NOT NULL,
  `cardNumber` VARCHAR(255) NOT NULL,
  PRIMARY KEY (`id`),
  FOREIGN KEY (`id`) REFERENCES `payment`(`id`)
);

CREATE TABLE `bank_transfer_payment` (
  `id`       INT NOT NULL,
  `bankCode` VARCHAR(255) NOT NULL,
  PRIMARY KEY (`id`),
  FOREIGN KEY (`id`) REFERENCES `payment`(`id`)
);
```

STI와의 중요한 차이점은 자식 컬럼에 NOT NULL을 걸 수 있다는 것입니다. 각 자식 테이블에는 해당 타입의 행만 저장됩니다. 그래서 컬럼을 nullable로 만들 필요가 없습니다.

### 엔티티 정의

```typescript
@Entity()
@Inheritance({ strategy: "JOINED" })
@DiscriminatorColumn({ name: "payment_type" })
export class Payment {
  @PrimaryGeneratedColumn() id!: number;
  @Column() amount!: number;
}

@Entity()
@DiscriminatorValue("credit_card")
export class CreditCardPayment extends Payment {
  @Column() cardNumber!: string;  // NOT NULL 가능
}

@Entity()
@DiscriminatorValue("bank_transfer")
export class BankTransferPayment extends Payment {
  @Column() bankCode!: string;
}
```

### CRUD 연산과 생성되는 SQL

**INSERT**: 두 단계로 실행됩니다. 루트 테이블에 먼저 삽입하고 같은 기본 키로 자식 테이블에 삽입합니다.

```typescript
const cc = await em.save(CreditCardPayment, {
  amount: 100,
  cardNumber: "4111-1111-1111-1111",
});
// 1. INSERT INTO "payment" ("amount", "payment_type") VALUES (100, 'credit_card') RETURNING *
// 2. INSERT INTO "credit_card_payment" ("id", "cardNumber") VALUES (1, '4111-1111-1111-1111')
```

**SELECT (자식)**: 루트 테이블을 자동으로 INNER JOIN합니다.

```typescript
const cards = await em.find(CreditCardPayment, {});
// SELECT cc.*, payment.amount FROM "credit_card_payment" cc
//   INNER JOIN "payment" ON cc."id" = "payment"."id"
```

**SELECT (루트, 다형성)**: 모든 자식 테이블을 LEFT JOIN합니다.

```typescript
const all = await em.find(Payment, {});
// SELECT "payment"."id", "payment"."amount", "payment"."payment_type",
//        "credit_card_payment"."cardNumber",
//        "bank_transfer_payment"."bankCode"
// FROM "payment"
// LEFT JOIN "credit_card_payment" ON "payment"."id" = "credit_card_payment"."id"
// LEFT JOIN "bank_transfer_payment" ON "payment"."id" = "bank_transfer_payment"."id"
```

루트 테이블을 기준으로 모든 자식 테이블을 LEFT JOIN합니다. 그래서 신용카드 결제 행에서는 `bankCode`가 NULL이고 계좌이체 결제 행에서는 `cardNumber`가 NULL입니다. ORM은 `payment_type`의 구분 값을 읽어서 알맞은 서브클래스 인스턴스를 생성합니다.

```typescript
console.log(JSON.stringify(all, null, 2));
// [
//   { "id": 1, "amount": 100, "cardNumber": "4111-1111-1111-1111" },
//   { "id": 2, "amount": 200, "bankCode": "SWIFT123" }
// ]

all[0] instanceof CreditCardPayment;  // true
all[1] instanceof BankTransferPayment; // true
```

각 객체에는 해당 타입의 컬럼만 들어 있습니다. `CreditCardPayment` 인스턴스에는 `bankCode`가 없고 `BankTransferPayment` 인스턴스에는 `cardNumber`가 없습니다. 다른 자식 타입의 NULL 컬럼은 ORM이 역직렬화하면서 제거합니다.

**DELETE**: 조건에 맞는 키를 먼저 조회합니다. 그다음 INSERT의 역순으로 자식 테이블의 행을 먼저 삭제하고 루트 테이블의 행을 삭제합니다.

```typescript
await em.delete(CreditCardPayment, { id: cc.id });
// 1. SELECT "tpt_root"."id" AS "pk" FROM "credit_card_payment" AS "tpt_child"
//      INNER JOIN "payment" AS "tpt_root" ON "tpt_child"."id" = "tpt_root"."id"
//      WHERE "tpt_child"."id" = 1
// 2. DELETE FROM "credit_card_payment" WHERE "id" IN (1)
// 3. DELETE FROM "payment" WHERE "id" IN (1)
```

외래 키 제약 조건 때문에 이 순서가 중요합니다. 루트 행을 먼저 삭제하면 자식 행이 참조하는 부모가 사라집니다. 그러면 외래 키 위반 에러가 납니다.

### 장단점

| 장점 | 단점 |
|------|------|
| 정규화된 스키마 (NULL 낭비 없음) | 모든 쿼리에 JOIN 필요 |
| 자식 컬럼에 NOT NULL 가능 | INSERT와 DELETE에 SQL 문 여러 개 필요 |
| 자식 타입이 많아져도 잘 확장됨 | 다형성 쿼리에 LEFT JOIN N개 필요 |

## Strategy 3: Table Per Class (TPC)

루트를 포함한 각 엔티티 클래스가 독립된 자기 테이블을 가집니다. 상속받은 컬럼도 각 테이블에 복사됩니다. 공유 테이블은 없습니다.

가족 구성원이 각자 완전히 독립된 집에 사는 것과 비슷합니다. 집마다 거실이 따로 있습니다. 이 거실이 중복된 공통 컬럼입니다. 그래서 공간 효율은 떨어집니다. 대신 집끼리 서로 영향을 주지 않습니다.

### 스키마

**PostgreSQL:**

```sql
CREATE TABLE "payment" (
  "id"     SERIAL PRIMARY KEY,
  "amount" INT NOT NULL
);

CREATE TABLE "credit_card_payment" (
  "id"         SERIAL PRIMARY KEY,
  "amount"     INT NOT NULL,           -- 루트에서 복제
  "cardNumber" VARCHAR(255) NOT NULL
);

CREATE TABLE "bank_transfer_payment" (
  "id"       SERIAL PRIMARY KEY,
  "amount"   INT NOT NULL,             -- 루트에서 복제
  "bankCode" VARCHAR(255) NOT NULL
);
```

**MySQL:**

```sql
CREATE TABLE `payment` (
  `id`     INT NOT NULL AUTO_INCREMENT,
  `amount` INT NOT NULL,
  PRIMARY KEY (`id`)
);

CREATE TABLE `credit_card_payment` (
  `id`         INT NOT NULL AUTO_INCREMENT,
  `amount`     INT NOT NULL,
  `cardNumber` VARCHAR(255) NOT NULL,
  PRIMARY KEY (`id`)
);

CREATE TABLE `bank_transfer_payment` (
  `id`       INT NOT NULL AUTO_INCREMENT,
  `amount`   INT NOT NULL,
  `bankCode` VARCHAR(255) NOT NULL,
  PRIMARY KEY (`id`)
);
```

각 테이블에 `amount` 컬럼이 중복되어 있습니다. 이것이 TPC의 본질적인 트레이드오프입니다.

### 엔티티 정의

```typescript
@Entity()
@Inheritance({ strategy: "TABLE_PER_CLASS" })
@DiscriminatorColumn({ name: "payment_type" })
export class Payment {
  @PrimaryGeneratedColumn() id!: number;
  @Column() amount!: number;
}

@Entity()
@DiscriminatorValue("credit_card")
export class CreditCardPayment extends Payment {
  @Column() cardNumber!: string;
}

@Entity()
@DiscriminatorValue("bank_transfer")
export class BankTransferPayment extends Payment {
  @Column() bankCode!: string;
}
```

### CRUD 연산과 생성되는 SQL

**INSERT**: 자식 엔티티의 테이블에 바로 삽입합니다.

```typescript
const cc = await em.save(CreditCardPayment, {
  amount: 100,
  cardNumber: "4111-1111-1111-1111",
});
// INSERT INTO "credit_card_payment" ("amount", "cardNumber") VALUES (100, '4111-1111-1111-1111')
```

JOIN도 2단계 삽입도 없습니다. INSERT는 세 전략 중 가장 단순합니다.

**SELECT (자식)**: 자기 테이블만 조회합니다. 세 전략 중 가장 빠릅니다.

```typescript
const cards = await em.find(CreditCardPayment, {});
// SELECT * FROM "credit_card_payment"
```

**SELECT (루트, 다형성)**: 모든 테이블을 UNION ALL로 합칩니다.

```typescript
const all = await em.find(Payment, {});
// SELECT "id", "amount", NULL AS "cardNumber", NULL AS "bankCode", 'PaymentEntity' AS "payment_type" FROM "payment"
// UNION ALL
// SELECT "id", "amount", "cardNumber", NULL AS "bankCode", 'credit_card' AS "payment_type" FROM "credit_card_payment"
// UNION ALL
// SELECT "id", "amount", NULL AS "cardNumber", "bankCode", 'bank_transfer' AS "payment_type" FROM "bank_transfer_payment"
```

각 테이블의 결과를 합친 뒤 ORM이 `payment_type` 값으로 알맞은 서브클래스 인스턴스를 생성합니다.

```typescript
console.log(JSON.stringify(all, null, 2));
// [
//   { "id": 1, "amount": 50 },
//   { "id": 1, "amount": 100, "cardNumber": "4111-1111-1111-1111" },
//   { "id": 1, "amount": 200, "bankCode": "SWIFT123" }
// ]

all[0] instanceof Payment;             // true (루트 엔티티)
all[1] instanceof CreditCardPayment;   // true
all[2] instanceof BankTransferPayment; // true
```

서로 다른 테이블의 행이므로 `id`가 겹칠 수 있습니다. TPC에서는 테이블마다 ID를 따로 매깁니다. 전역에서 고유한 ID가 필요하면 `@PrimaryGeneratedColumn("uuid")`를 사용하세요.

이 쿼리가 느려지기 쉬운 이유는 다음과 같습니다.

UNION ALL의 동작 원리: UNION ALL은 각 SELECT 문의 결과를 이어 붙이는 연산입니다. 데이터베이스 엔진은 UNION ALL에 참여하는 모든 테이블을 각각 따로 스캔해야 합니다. 위 예시에서는 `payment`, `credit_card_payment`, `bank_transfer_payment` 세 테이블 전체를 읽습니다.

풀 스캔이 발생하는 이유: STI나 TPT에서는 테이블 하나나 JOIN한 테이블 쌍에서 인덱스를 타고 필요한 행만 골라낼 수 있습니다. 하지만 TPC의 다형성 쿼리는 사정이 다릅니다. `em.find(Payment, {})` 같은 루트 엔티티 조회를 실행하면 어느 자식 테이블에 데이터가 있는지 미리 판단할 방법이 없습니다. 그래서 모든 자식 테이블을 빠짐없이 스캔해야 합니다. 자식 타입이 3개면 테이블 스캔이 3번, 10개면 10번 발생합니다. 각 테이블에 100만 행이 있다면 다형성 쿼리 한 번이 수백만 행을 읽는 셈입니다.

WHERE 조건이 있어도 느린 이유: `em.find(Payment, { where: { amount: 100 } })`처럼 조건을 걸어도 데이터베이스는 UNION ALL의 각 SELECT에 WHERE를 따로 적용합니다. 세 테이블에서 각각 `amount = 100`을 검색하고 그 결과를 합칩니다. 인덱스가 있다면 각 테이블 안의 검색은 빠릅니다. 하지만 테이블 수만큼 검색을 반복하는 오버헤드는 피할 수 없습니다. 반면 STI는 테이블 하나에서 한 번만 검색하면 끝납니다.

결론: TPC는 `em.find(ChildEntity, {})` 같은 특정 자식 타입 조회가 대부분이고 `em.find(Payment, {})` 같은 다형성 쿼리가 드물 때만 선택하는 것이 좋습니다. 자식 타입별 조회는 자기 테이블 하나만 읽으므로 세 전략 중 가장 빠릅니다. 하지만 전체 조회는 가장 느립니다. 이 트레이드오프를 이해하고 선택하세요.

**DELETE**: 자기 테이블에서만 삭제합니다.

```typescript
await em.delete(CreditCardPayment, { id: cc.id });
// DELETE FROM "credit_card_payment" WHERE "id" = 1
```

### 장단점

| 장점 | 단점 |
|------|------|
| 자식 쿼리에 JOIN 불필요 | 테이블 간 컬럼 중복 |
| 완전히 독립된 테이블 | 다형성 쿼리가 느린 UNION ALL 사용 |
| nullable 컬럼 불필요 | 테이블 간 ID가 충돌할 수 있음 |

## 릴레이션과 함께 사용하기

상속 엔티티도 일반적인 `@ManyToOne`과 `@OneToMany` 관계를 지원합니다. 알맞은 엔티티 클래스에 관계를 정의하면 됩니다.

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
@DiscriminatorColumn({ name: "payment_type" })
export class Payment {
  @PrimaryGeneratedColumn() id!: number;
  @Column() amount!: number;
  @Column({ type: "int", nullable: true }) storeFk!: number;
  @ManyToOne(() => Store, (s) => s.payments)
  @RelationColumn({ name: "storeFk" })
  store!: Store;
}
```

관계 로딩은 일반 엔티티와 똑같이 동작합니다.

```typescript
// 자식 엔티티의 ManyToOne 관계 로딩
const cards = await em.find(CreditCardPayment, {
  relations: ["store"],
});
console.log(cards[0].store.name); // "MyStore"

// 루트 엔티티의 OneToMany 로딩 (모든 결제 타입이 반환됨)
const stores = await em.find(Store, {
  relations: ["payments"],
});
```

::: tip
TPT 전략에서 루트 엔티티에 정의한 외래 키 컬럼은 루트 테이블에 저장됩니다. ORM은 JOIN 쿼리를 만들 때 외래 키 컬럼을 알맞은 테이블로 자동으로 한정합니다.
:::

::: tip
`tenantStrategy: "tenant_column"`에서 테넌트 컬럼이 놓이는 테이블은 전략마다 다릅니다. STI에서는 공유 테이블에, TPT에서는 루트 테이블에만, TPC에서는 모든 구체 테이블에 놓입니다. 자세한 내용은 [멀티테넌시: 상속 계층](./multi-tenancy.md#상속-계층)을 참고하세요.
:::

## WriteBuffer와 함께 사용하기

WriteBuffer 플러그인은 상속 엔티티를 별도 설정 없이 지원합니다. `find()`, `findOne()`, 변경 추적(dirty tracking) 모두 상속 계층에서 정상적으로 동작합니다.

```typescript
em.extend(bufferPlugin());

const buf = em.buffer();

// findOne은 알맞은 서브클래스 타입으로 반환
const cc = await buf.findOne(CreditCardPayment, { where: { amount: 100 } });
cc.amount = 200;

// 변경 추적은 상속받은 필드에서도 동작
const result = await buf.flush();
console.log(result.updates); // 1

// 다형성 쿼리도 알맞은 서브클래스 인스턴스를 반환
const all = await buf.find(Payment, {});
all.forEach(p => {
  if (p instanceof CreditCardPayment) { /* ... */ }
});
```

## QueryBuilder 지원

`SelectQueryBuilder`는 상속 매핑을 완전히 지원합니다. `em.createQueryBuilder(Entity, alias)`를 사용하면 해당 엔티티의 전략에 맞는 상속 로직이 자동으로 적용됩니다.

- **STI 자식**: `WHERE discriminator = 'value'` 조건을 자동으로 추가합니다.
- **STI 루트 (다형성)**: 구분 값으로 역직렬화해서 알맞은 서브클래스 인스턴스를 반환합니다.
- **TPT 자식**: 부모 테이블을 자동으로 `INNER JOIN`합니다. 그리고 부모 컬럼과 자식 컬럼을 합친 명시적 SELECT를 만듭니다.
- **TPT 루트 (다형성)**: 모든 자식 테이블을 `LEFT JOIN`합니다. 그리고 컬럼 접두사를 제거해서 알맞은 서브클래스 인스턴스를 반환합니다.
- **TPC 자식**: 자식 엔티티의 테이블만 직접 조회합니다. 추가 로직은 없습니다.
- **TPC 루트 (다형성)**: 모든 테이블에 걸친 `UNION ALL` 서브쿼리를 자동으로 생성합니다. 이 서브쿼리에는 NULL 패딩과 가상 구분 컬럼이 들어갑니다.

```typescript
// STI: 구분 컬럼 WHERE가 자동으로 추가됩니다
const cards = await em
  .createQueryBuilder(CreditCardPayment, "p")
  .where("amount", 100)
  .getMany();
// SELECT "p".* FROM "payment" AS "p"
// WHERE "p"."payment_type" = 'credit_card' AND "p"."amount" = $1

// STI 루트: 다형성 역직렬화
const all = await em
  .createQueryBuilder(Payment, "p")
  .getMany();
// CreditCardPayment, BankTransferPayment, Payment 인스턴스를 반환합니다

// TPT 자식: 부모 테이블이 자동으로 JOIN됩니다
const cards = await em
  .createQueryBuilder(CreditCardPayment, "cc")
  .where("amount", 100)
  .getMany();
// SELECT "cc"."id", "cc"."cardNumber", "payment"."amount"
// FROM "credit_card_payment" AS "cc"
// INNER JOIN "payment" ON "cc"."id" = "payment"."id"
// WHERE "payment"."amount" = $1

// TPC 루트: UNION ALL이 자동으로 생성됩니다
const all = await em
  .createQueryBuilder(Payment, "p")
  .getMany();
// SELECT * FROM (
//   SELECT ... FROM "payment" UNION ALL
//   SELECT ... FROM "credit_card_payment" UNION ALL
//   SELECT ... FROM "bank_transfer_payment"
// ) "_tpc"
```

모든 QueryBuilder 메서드(`getMany()`, `getOne()`, `getCount()`, `exists()`, `getRawMany()`, `clone()`)가 상속을 지원합니다. WHERE, ORDER BY, GROUP BY 절도 다형성 쿼리에서 사용할 수 있습니다.

## EntitySchema로 정의하기 (데코레이터 없이)

데코레이터 없이 엔티티를 정의하려면 `EntitySchema`를 쓰세요. `EntitySchema`는 `inheritance`, `discriminatorColumn`, `discriminatorValue` 옵션으로 세 상속 전략을 모두 지원합니다.

```typescript
import { EntitySchema } from "@stingerloom/orm";

class Payment {
  id!: number;
  amount!: number;
}

class CreditCardPayment extends Payment {
  cardNumber!: string;
}

// 루트: 전략 + 구분 컬럼 선언
new EntitySchema<Payment>({
  target: Payment,
  inheritance: { strategy: "SINGLE_TABLE" },
  discriminatorColumn: { name: "payment_type", type: "varchar", length: 50 },
  columns: {
    id:     { type: "int", primary: true, autoIncrement: true },
    amount: { type: "int" },
  },
});

// 자식: 고유 컬럼 + 구분 값 선언
new EntitySchema<CreditCardPayment>({
  target: CreditCardPayment,
  discriminatorValue: "credit_card",
  columns: {
    cardNumber: { type: "varchar", nullable: true },
  },
});
```

`"JOINED"`(TPT)와 `"TABLE_PER_CLASS"`(TPC)도 패턴이 같습니다. `strategy` 값만 바꾸면 됩니다. 자식 엔티티는 프로토타입 체인으로 부모 컬럼을 자동으로 상속받습니다. EntityManager, QueryBuilder, WriteBuffer 같은 ORM 기능도 모두 똑같이 동작합니다.

EntitySchema의 전체 문서는 [엔티티: 데코레이터 없이 엔티티 정의하기](./entities.md#데코레이터-없이-엔티티-정의하기-entityschema)를 참고하세요.

## 데코레이터 레퍼런스

### `@Inheritance(options)`

루트 엔티티 클래스에만 적용합니다. 계층 구조가 사용할 매핑 전략을 정의합니다.

```typescript
@Inheritance({ strategy: "SINGLE_TABLE" | "JOINED" | "TABLE_PER_CLASS" })
```

### `@DiscriminatorColumn(options?)`

루트 엔티티 클래스에 적용합니다. 각 행의 타입 식별자를 저장하는 컬럼을 설정합니다.

| 옵션 | 타입 | 기본값 | 설명 |
|------|------|--------|------|
| `name` | `string` | `"dtype"` | 데이터베이스의 컬럼 이름 |
| `type` | `ColumnType` | `"varchar"` | 컬럼 데이터 타입 |
| `length` | `number` | `31` | 컬럼 길이 (varchar일 때) |

```typescript
@DiscriminatorColumn({ name: "payment_type", type: "varchar", length: 50 })
```

TPC 전략에서는 구분 컬럼이 데이터베이스에 실제로 저장되지 않습니다. UNION ALL 쿼리를 만들 때 내부에서만 사용합니다.

### `@DiscriminatorValue(value)`

각 자식 엔티티 클래스에 적용합니다. 해당 타입의 행에서 구분 컬럼에 저장할 문자열 값을 지정합니다.

```typescript
@DiscriminatorValue("credit_card")
export class CreditCardPayment extends Payment { ... }
```

생략하면 클래스 이름이 기본 구분 값이 됩니다.

## 전략 선택 가이드

어떤 전략을 선택할지 결정할 때 이 플로우차트를 참고하세요.

```
Polymorphic query가 필요한가?
  |
  +-- 거의/전혀 필요 없음 --> TABLE_PER_CLASS (TPC)
  |                          각 엔티티가 독립적
  |
  +-- 필요함
       |
       +-- 자식 고유 컬럼이 적은가?
       |     |
       |     +-- 적음 --> SINGLE_TABLE (STI)
       |     |            빠른 쿼리, 단순한 스키마
       |     |
       |     +-- 많음 --> JOINED (TPT)
       |                  정규화됨, NULL 낭비 없음
       |
       +-- 스키마 정규화가 중요한가?
             |
             +-- 중요 --> JOINED (TPT)
             +-- 덜 중요 --> SINGLE_TABLE (STI)
```

실무에서 가장 흔한 선택은 STI입니다. 대부분의 상속 구조에서는 자식 고유 컬럼이 2~3개 정도로 적고 JOIN 없는 쿼리 성능이 중요하기 때문입니다. 자식 고유 컬럼이 10개 이상이거나 NOT NULL 제약 조건이 중요할 때만 TPT를 고려하세요.

## API 요약

| 데코레이터 | 대상 | 설명 |
|-----------|------|------|
| `@Inheritance({ strategy })` | 루트 클래스 | 상속 전략 선언 |
| `@DiscriminatorColumn({ name?, type?, length? })` | 루트 클래스 | 구분 컬럼 설정 |
| `@DiscriminatorValue(value)` | 자식 클래스 | 해당 타입의 구분 값 지정 |

| EntityManager 메서드 | 상속 지원 |
|---------------------|----------|
| `em.find(RootEntity)` | 다형성 (알맞은 서브클래스 인스턴스 반환) |
| `em.find(ChildEntity)` | 범위 적용 (STI: 구분 컬럼 WHERE, TPT: 부모 JOIN, TPC: 자기 테이블) |
| `em.save(ChildEntity, data)` | 구분 값 자동 설정 + TPT 2단계 삽입 |
| `em.delete(ChildEntity, criteria)` | STI: 구분 컬럼 WHERE 추가. TPT: 루트 JOIN으로 일치하는 키를 조회한 뒤 자식 → 루트 순으로 삭제. 조건에는 어느 테이블의 컬럼이든 사용 가능 |
| `em.delete/deleteMany(RootEntity)` | TPT: 일치하는 키를 모든 자식 테이블에서 삭제한 뒤 루트에서 삭제 |
| `em.updateMany/update/increment/decrement/softDelete/restore(ChildEntity)` | STI: 구분 컬럼 WHERE 추가. TPT: 루트 JOIN으로 일치하는 키를 조회한 뒤 각 테이블의 컬럼을 키로 갱신 |
| `em.count/exists/sum/avg/min/max(ChildEntity)`, `em.findWithCursor(ChildEntity)` | STI: 구분 컬럼 WHERE 추가. TPT: 자식 `INNER JOIN` 루트를 읽으므로 조건, 집계 필드, 정렬 컬럼에 상속 컬럼 사용 가능 |
| `em.count/sum/avg/min/max(RootEntity)` | STI/TPT: 공유 테이블이나 루트 테이블에 이미 모든 행이 있음. TPC: `UNION ALL` 결과를 집계 |
| `em.findWithCursor(RootEntity)` | TPT: 루트에 모든 자식 테이블을 `LEFT JOIN`해 페이지네이션하고 각 행을 서브클래스로 반환. TPC: `(정렬 컬럼, id, discriminator)` 키셋으로 `UNION ALL`을 페이지네이션 |
| `em.updateMany/softDelete/restore/delete/deleteMany(RootEntity)` | TPC: 구체 테이블마다 실행하고 `affected`를 합산. `orderBy`나 `limit`이 있는 `updateMany`는 거부 |
| `em.createQueryBuilder(Entity, alias)` | 완전 지원 (STI 구분 컬럼 WHERE, TPT 자동 JOIN, TPC UNION ALL, 다형성 역직렬화) |
| `buf.find(Entity)` | 완전 지원 (EntityManager에 위임) |

## 다음 단계

- [엔티티](./entities.md): 엔티티와 컬럼 정의의 기초
- [관계](./relations.md): @ManyToOne / @OneToMany 관계 설정
- [WriteBuffer](./write-buffer.md): Unit of Work 패턴과 변경 추적(dirty tracking)
- [QueryBuilder](./query-builder.md): SelectQueryBuilder로 복잡한 쿼리 작성
