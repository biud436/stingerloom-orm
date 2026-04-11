# 상속 매핑 (Inheritance Mapping)

**상속 매핑**(Inheritance Mapping)은 객체 지향 프로그래밍(OOP)의 "상속" 개념을 관계형 데이터베이스(RDBMS) 테이블 구조로 변환하는 기술이에요.

OOP에서는 `class Child extends Parent`라고 쓰면 부모의 필드와 메서드를 자식이 자연스럽게 물려받아요. 클래스 계층 구조가 깊어져도 언어가 알아서 처리해줘요. 하지만 RDBMS는 다른 세계예요. 테이블은 본질적으로 플랫(flat)한 행과 열의 집합이고, "이 테이블이 저 테이블을 상속한다"는 개념 자체가 없어요. 부모-자식 관계도, 다형성(polymorphism)도, `instanceof`도 SQL에는 존재하지 않아요.

이 두 세계의 간극을 **임피던스 불일치**(Object-Relational Impedance Mismatch)라고 불러요. ORM의 핵심 역할이 바로 이 간극을 메워주는 것이고, 상속 매핑은 그중에서도 가장 복잡한 부분이에요. OOP의 클래스 계층 구조를 — discriminator 컬럼, JOIN, UNION ALL 같은 SQL 기법을 조합해서 — RDBMS 위에서 자연스럽게 재현해주거든요.

이 말이 아직 와닿지 않아도 괜찮아요. 구체적인 문제를 먼저 보면 왜 필요한지 자연스럽게 이해돼요.

## 왜 상속 매핑이 필요할까?

온라인 결제 시스템을 만든다고 상상해보세요. 신용카드 결제, 계좌이체 결제, 암호화폐 결제를 처리해야 해요. 세 가지 결제 방식 모두 `id`, `amount`, `createdAt` 같은 공통 필드를 가지지만, 각각 고유한 필드도 있어요:

- **신용카드 결제:** `cardNumber`, `expiryDate`
- **계좌이체 결제:** `bankCode`, `accountNumber`
- **암호화폐 결제:** `walletAddress`, `networkFee`

상속 매핑 없이 이 문제를 해결하려면 세 가지 방법이 있는데, 전부 문제가 있어요.

### 시나리오 1: 엔티티를 따로따로 만든다

결제 유형마다 별도의 엔티티 클래스를 만들고, 공통 필드를 각각 복붙해요.

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

새 공통 필드를 추가하면? 세 클래스를 전부 수정해야 해요. "전체 결제 내역 조회" 같은 polymorphic query는 UNION ALL을 직접 작성해야 하고요. 코드 중복은 버그의 온상이에요.

### 시나리오 2: 하나의 거대한 테이블에 다 넣는다

모든 결제 유형의 컬럼을 하나의 테이블에 몰아넣어요.

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

동작은 하지만, nullable 컬럼이 넘쳐나고 타입 안전성이 없어요. `cardNumber`에 접근할 때 TypeScript가 이게 정말 신용카드 결제인지 알 수 없거든요.

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

TypeScript 레벨에서는 깔끔하지만, ORM이 이 상속 관계를 모르면 아무 의미가 없어요. `em.find(Payment, {})` 같은 polymorphic query를 실행했을 때, ORM이 하위 클래스를 올바른 인스턴스로 변환해주지 못해요.

**상속 매핑**은 이 세 가지 문제를 동시에 해결해요. TypeScript 상속 구조를 데이터베이스 스키마에 자동으로 매핑하고, CRUD 연산 시 discriminator 처리, JOIN, UNION ALL을 ORM이 알아서 생성해줘요.

## 역사와 배경

상속 매핑이라는 개념은 Martin Fowler가 2003년에 출판한 *Patterns of Enterprise Application Architecture*에서 체계화됐어요. 이 책에서 Fowler는 객체 지향 상속을 관계형 데이터베이스에 매핑하는 세 가지 패턴을 정리했어요:

- **Single Table Inheritance** -- 한 테이블에 전부 넣되, discriminator 컬럼으로 구분
- **Class Table Inheritance** -- 부모/자식 테이블을 분리하고 JOIN으로 조합
- **Concrete Table Inheritance** -- 각 클래스가 독립 테이블을 가짐

이후 Java 진영에서 JPA(Java Persistence API)가 이 패턴들을 `@Inheritance`, `@DiscriminatorColumn`, `@DiscriminatorValue` 어노테이션으로 표준화했고, Hibernate가 참조 구현을 제공했어요. 이 표준은 20년 넘게 검증된 패턴이에요.

Stingerloom ORM은 이 JPA/Hibernate 표준을 TypeScript에 맞게 도입했어요. 데코레이터 이름과 전략 식별자(`SINGLE_TABLE`, `JOINED`, `TABLE_PER_CLASS`)는 JPA 명세와 동일하기 때문에, Java/Kotlin 경험이 있다면 바로 익숙하게 느껴질 거예요.

## 전략 비교

| 전략 | 데코레이터 | 테이블 수 | Polymorphic Query | 적합한 상황 |
|------|-----------|----------|-------------------|------------|
| Single Table (STI) | `@Inheritance({ strategy: "SINGLE_TABLE" })` | 1개 (공유) | 빠름 (JOIN 없음) | 단순한 계층, 자식 고유 컬럼이 적을 때 |
| Joined / Table Per Type (TPT) | `@Inheritance({ strategy: "JOINED" })` | 1 + N개 (부모 + 자식) | 보통 (JOIN 필요) | 정규화가 중요하고, 자식 고유 컬럼이 많을 때 |
| Table Per Class (TPC) | `@Inheritance({ strategy: "TABLE_PER_CLASS" })` | N개 (독립) | 느림 (UNION ALL) | 독립적인 자식 엔티티, polymorphic query가 드물 때 |

## Quick Start

상속 매핑에는 세 가지 데코레이터가 필요해요.

```typescript
import {
  Entity, PrimaryGeneratedColumn, Column,
  Inheritance, DiscriminatorColumn, DiscriminatorValue,
} from "@stingerloom/orm";

// 1. Root 엔티티: 전략과 discriminator 컬럼을 정의
@Entity()
@Inheritance({ strategy: "SINGLE_TABLE" })
@DiscriminatorColumn({ name: "payment_type", type: "varchar", length: 50 })
export class Payment {
  @PrimaryGeneratedColumn() id!: number;
  @Column() amount!: number;
}

// 2. Child 엔티티: root를 상속하고 discriminator 값을 지정
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

root와 child 엔티티를 모두 등록해야 해요.

```typescript
await em.register({
  type: "postgres",
  // ...
  entities: [Payment, CreditCardPayment, BankTransferPayment],
  synchronize: true,
});
```

이제부터 각 전략을 하나씩 자세히 살펴볼게요.

## Strategy 1: Single Table Inheritance (STI)

계층 구조의 모든 클래스가 **하나의 데이터베이스 테이블**을 공유해요. Discriminator 컬럼이 각 행의 타입을 구분해요.

비유하자면, 한 아파트에 모든 가구가 함께 사는 것과 비슷해요. 방은 하나지만, 이름표(discriminator)로 누구의 물건인지 구분하는 거예요.

### 스키마

**PostgreSQL:**

```sql
CREATE TABLE "payment" (
  "id"           SERIAL PRIMARY KEY,
  "amount"       INT NOT NULL,
  "payment_type" VARCHAR(50),       -- discriminator
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

테이블이 하나이기 때문에 스키마가 단순해요. 하지만 주목할 점이 있어요: `cardNumber`와 `bankCode`가 모두 nullable이에요. 계좌이체 결제 행에는 `cardNumber`가 NULL이고, 신용카드 결제 행에는 `bankCode`가 NULL이니까요.

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
자식 엔티티의 고유 컬럼은 **반드시 nullable**이어야 해요. 다른 타입의 행에서는 해당 컬럼이 NULL이 되기 때문이에요. `nullable: true`를 빠뜨리면 INSERT 시 데이터베이스가 NOT NULL 제약 조건 위반 오류를 발생시켜요.
:::

### CRUD 연산과 생성되는 SQL

**INSERT** -- discriminator 값이 자동으로 설정돼요:

```typescript
const cc = await em.save(CreditCardPayment, {
  amount: 100,
  cardNumber: "4111-1111-1111-1111",
});
// Generated SQL: INSERT INTO "payment" ("amount", "cardNumber", "payment_type")
//                VALUES (100, '4111-1111-1111-1111', 'credit_card')
```

`payment_type`에 `'credit_card'`가 자동으로 들어가요. 직접 지정할 필요가 없어요.

**SELECT (자식)** -- discriminator 조건이 자동으로 추가돼요:

```typescript
const cards = await em.find(CreditCardPayment, {});
// Generated SQL: SELECT * FROM "payment" WHERE "payment_type" = 'credit_card'
```

**SELECT (root, polymorphic)** -- 모든 타입의 인스턴스가 올바른 하위 클래스로 반환돼요:

```typescript
const all = await em.find(Payment, {});
// Generated SQL: SELECT * FROM "payment"
```

단일 테이블에 모든 행이 있으므로 JOIN이나 UNION 없이 그냥 `SELECT *`면 돼요. ORM은 각 행의 `payment_type` 값을 읽어서 올바른 하위 클래스 인스턴스를 생성해요.

```typescript
console.log(JSON.stringify(all, null, 2));
// [
//   { "id": 1, "amount": 100, "cardNumber": "4111-1111-1111-1111" },
//   { "id": 2, "amount": 200, "bankCode": "SWIFT123" }
// ]

all[0] instanceof CreditCardPayment;  // true
all[1] instanceof BankTransferPayment; // true
```

`JSON.stringify` 결과에는 `payment_type`이 보이지 않아요. Discriminator 컬럼은 ORM 내부에서만 사용되고, 엔티티 속성으로 노출되지 않기 때문이에요. 대신 각 객체는 올바른 하위 클래스의 **인스턴스**이므로, `instanceof` 연산자로 타입을 구분할 수 있어요.

**UPDATE** -- discriminator 컬럼은 SET 절에서 제외돼요:

```typescript
cc.amount = 200;
await em.save(CreditCardPayment, cc);
// Generated SQL: UPDATE "payment" SET "amount" = 200 WHERE "id" = 1
```

**DELETE** -- discriminator 조건이 자동으로 추가돼요:

```typescript
await em.delete(CreditCardPayment, { id: cc.id });
// Generated SQL: DELETE FROM "payment" WHERE "id" = 1 AND "payment_type" = 'credit_card'
```

### 장단점

| 장점 | 단점 |
|------|------|
| 가장 빠른 쿼리 (JOIN이나 UNION 없음) | 자식 컬럼이 반드시 nullable |
| 스키마가 단순함 | NULL 컬럼으로 저장 공간 낭비 |
| Polymorphic query가 간단함 | 자식 타입이 많아지면 테이블이 넓어짐 |

## Strategy 2: Joined / Table Per Type (TPT)

Root 엔티티가 공통 컬럼을 담은 자체 테이블을 갖고, 각 child 엔티티는 고유 컬럼만 담은 **별도의 테이블**을 가져요. Child 테이블의 기본 키가 root 테이블의 외래 키 역할을 해요.

비유하자면, 가족은 공유 거실(root 테이블)을 함께 쓰고, 각자 개인 방(child 테이블)을 따로 갖는 거예요. 한 사람의 전체 정보를 보려면 거실과 개인 방을 함께 봐야 하듯이, JOIN이 필요해요.

### 스키마

**PostgreSQL:**

```sql
-- Root 테이블
CREATE TABLE "payment" (
  "id"           SERIAL PRIMARY KEY,
  "amount"       INT NOT NULL,
  "payment_type" VARCHAR(50)       -- discriminator
);

-- Child 테이블 (고유 컬럼 + PK가 root의 FK)
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

중요한 차이점: child 컬럼이 **NOT NULL**이 될 수 있어요. STI와 달리 각 child 테이블에는 해당 타입의 행만 저장되니까, nullable로 만들 필요가 없어요.

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

**INSERT** -- 2단계로 실행돼요. Root 테이블에 먼저 삽입하고, 같은 PK로 child 테이블에 삽입해요:

```typescript
const cc = await em.save(CreditCardPayment, {
  amount: 100,
  cardNumber: "4111-1111-1111-1111",
});
// 1. INSERT INTO "payment" ("amount", "payment_type") VALUES (100, 'credit_card') RETURNING *
// 2. INSERT INTO "credit_card_payment" ("id", "cardNumber") VALUES (1, '4111-1111-1111-1111')
```

**SELECT (자식)** -- Root 테이블에 자동으로 INNER JOIN해요:

```typescript
const cards = await em.find(CreditCardPayment, {});
// SELECT cc.*, payment.amount FROM "credit_card_payment" cc
//   INNER JOIN "payment" ON cc."id" = "payment"."id"
```

**SELECT (root, polymorphic)** -- 모든 child 테이블에 LEFT JOIN해요:

```typescript
const all = await em.find(Payment, {});
// SELECT "payment"."id", "payment"."amount", "payment"."payment_type",
//        "credit_card_payment"."cardNumber",
//        "bank_transfer_payment"."bankCode"
// FROM "payment"
// LEFT JOIN "credit_card_payment" ON "payment"."id" = "credit_card_payment"."id"
// LEFT JOIN "bank_transfer_payment" ON "payment"."id" = "bank_transfer_payment"."id"
```

Root 테이블을 기준으로 모든 child 테이블에 LEFT JOIN해요. 신용카드 결제 행에서는 `bankCode`가 NULL이고, 계좌이체 결제 행에서는 `cardNumber`가 NULL이에요. ORM은 `payment_type` discriminator 값을 읽어서 올바른 하위 클래스 인스턴스를 생성해요.

```typescript
console.log(JSON.stringify(all, null, 2));
// [
//   { "id": 1, "amount": 100, "cardNumber": "4111-1111-1111-1111" },
//   { "id": 2, "amount": 200, "bankCode": "SWIFT123" }
// ]

all[0] instanceof CreditCardPayment;  // true
all[1] instanceof BankTransferPayment; // true
```

각 객체에는 해당 타입의 컬럼만 포함돼요. `CreditCardPayment` 인스턴스에는 `bankCode`가 없고, `BankTransferPayment` 인스턴스에는 `cardNumber`가 없어요. ORM이 다른 자식 타입의 NULL 컬럼을 역직렬화 과정에서 제거해요.

**DELETE** -- INSERT의 역순으로, child 먼저 삭제한 뒤 root를 삭제해요:

```typescript
await em.delete(CreditCardPayment, { id: cc.id });
// 1. DELETE FROM "credit_card_payment" WHERE "id" = 1
// 2. DELETE FROM "payment" WHERE "id" = 1
```

FK 제약 조건 때문에 이 순서가 중요해요. Root 행을 먼저 삭제하면, child 행이 참조하는 부모가 사라져서 FK violation 오류가 발생해요.

### 장단점

| 장점 | 단점 |
|------|------|
| 정규화된 스키마 (NULL 낭비 없음) | 모든 쿼리에 JOIN 필요 |
| Child 컬럼이 NOT NULL 가능 | INSERT/DELETE에 여러 문장 필요 |
| 자식 타입이 많아져도 잘 확장됨 | Polymorphic query에 N개의 LEFT JOIN 필요 |

## Strategy 3: Table Per Class (TPC)

각 엔티티 클래스(root 포함)가 **독립적인 자체 테이블**을 가져요. 상속받은 컬럼도 각 테이블에 복사돼요. 공유 테이블은 없어요.

비유하자면, 각 가족 구성원이 완전히 독립된 집에 사는 거예요. 각 집에 거실이 따로 있어서(공통 컬럼 중복) 공간 효율은 떨어지지만, 서로 영향을 주지 않아요.

### 스키마

**PostgreSQL:**

```sql
CREATE TABLE "payment" (
  "id"     SERIAL PRIMARY KEY,
  "amount" INT NOT NULL
);

CREATE TABLE "credit_card_payment" (
  "id"         SERIAL PRIMARY KEY,
  "amount"     INT NOT NULL,           -- root에서 복제
  "cardNumber" VARCHAR(255) NOT NULL
);

CREATE TABLE "bank_transfer_payment" (
  "id"       SERIAL PRIMARY KEY,
  "amount"   INT NOT NULL,             -- root에서 복제
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

각 테이블이 `amount` 컬럼을 중복으로 갖고 있는 게 보여요. 이건 TPC의 본질적인 트레이드오프예요.

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

**INSERT** -- Child 자체 테이블에 바로 삽입해요:

```typescript
const cc = await em.save(CreditCardPayment, {
  amount: 100,
  cardNumber: "4111-1111-1111-1111",
});
// INSERT INTO "credit_card_payment" ("amount", "cardNumber") VALUES (100, '4111-1111-1111-1111')
```

JOIN도 없고, 2단계도 없어요. INSERT는 세 전략 중 가장 단순해요.

**SELECT (자식)** -- 자체 테이블만 조회해요 (가장 빠름):

```typescript
const cards = await em.find(CreditCardPayment, {});
// SELECT * FROM "credit_card_payment"
```

**SELECT (root, polymorphic)** -- 모든 테이블을 UNION ALL로 합쳐요:

```typescript
const all = await em.find(Payment, {});
// SELECT "id", "amount", NULL AS "cardNumber", NULL AS "bankCode", 'PaymentEntity' AS "payment_type" FROM "payment"
// UNION ALL
// SELECT "id", "amount", "cardNumber", NULL AS "bankCode", 'credit_card' AS "payment_type" FROM "credit_card_payment"
// UNION ALL
// SELECT "id", "amount", NULL AS "cardNumber", "bankCode", 'bank_transfer' AS "payment_type" FROM "bank_transfer_payment"
```

각 테이블에서 결과를 합친 뒤, ORM이 `payment_type` 값으로 올바른 하위 클래스 인스턴스를 생성해요.

```typescript
console.log(JSON.stringify(all, null, 2));
// [
//   { "id": 1, "amount": 50 },
//   { "id": 1, "amount": 100, "cardNumber": "4111-1111-1111-1111" },
//   { "id": 1, "amount": 200, "bankCode": "SWIFT123" }
// ]

all[0] instanceof Payment;             // true (root 엔티티)
all[1] instanceof CreditCardPayment;   // true
all[2] instanceof BankTransferPayment; // true
```

주목할 점: 서로 다른 테이블의 행이므로 `id`가 겹칠 수 있어요. TPC에서는 테이블 간 ID가 독립적이에요. 전역 고유 ID가 필요하면 `@PrimaryGeneratedColumn("uuid")`를 사용하세요.

이 쿼리가 왜 느릴 수 있는지 살펴볼게요.

**UNION ALL의 동작 원리:** UNION ALL은 각 SELECT 문의 결과를 단순히 이어붙이는 연산이에요. 데이터베이스 엔진은 UNION ALL에 참여하는 **모든 테이블을 각각 독립적으로 스캔**해야 해요. 위 예시에서는 `payment`, `credit_card_payment`, `bank_transfer_payment` 세 테이블 전체를 읽어요.

**풀 스캔이 발생하는 이유:** STI나 TPT에서는 하나의 테이블(또는 JOIN된 테이블 쌍)에서 인덱스를 타고 필요한 행만 골라낼 수 있어요. 하지만 TPC의 polymorphic query는 사정이 달라요. `em.find(Payment, {})` 같은 루트 엔티티 조회를 실행하면, ORM은 "어떤 자식 테이블에 데이터가 있는지" 미리 알 수 없기 때문에 **모든 자식 테이블을 빠짐없이 스캔**해야 해요. 자식 타입이 3개면 3번, 10개면 10번의 테이블 스캔이 발생해요. 각 테이블에 100만 행이 있다면, 한 번의 polymorphic query가 수백만 행을 읽는 셈이에요.

**WHERE 조건이 있어도 느린 이유:** `em.find(Payment, { where: { amount: 100 } })`처럼 조건을 걸어도, 데이터베이스는 UNION ALL의 각 SELECT에 독립적으로 WHERE를 적용해요. 즉, 세 테이블 각각에서 `amount = 100`을 검색하고, 그 결과를 합쳐요. 인덱스가 걸려 있다면 각 테이블 내에서의 검색은 빠르지만, **테이블 수만큼 검색을 반복**하는 오버헤드는 피할 수 없어요. 반면 STI는 하나의 테이블에서 한 번만 검색하면 끝나요.

**결론:** 이런 이유로 TPC는 `em.find(ChildEntity, {})` 같은 **특정 자식 타입 조회가 대부분**이고, `em.find(Payment, {})` 같은 **polymorphic query가 드문 경우**에만 선택하는 게 좋아요. 자식 타입별 조회는 자체 테이블 하나만 읽으므로 세 전략 중 가장 빠르지만, 전체 조회는 가장 느리다는 트레이드오프를 이해하고 선택해야 해요.

**DELETE** -- 자체 테이블에서만 삭제해요:

```typescript
await em.delete(CreditCardPayment, { id: cc.id });
// DELETE FROM "credit_card_payment" WHERE "id" = 1
```

### 장단점

| 장점 | 단점 |
|------|------|
| Child 쿼리에 JOIN 불필요 | 테이블 간 컬럼 중복 |
| 완전히 독립된 테이블 | Polymorphic query가 느린 UNION ALL 사용 |
| nullable 컬럼 불필요 | 테이블 간 ID가 충돌할 수 있음 |

## 릴레이션과 함께 사용하기

상속 엔티티도 일반 `@ManyToOne` / `@OneToMany` 관계를 지원해요. 적절한 엔티티 클래스에 관계를 정의하면 돼요.

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
  @ManyToOne(() => Store, (e) => e.store, { joinColumn: "storeFk" })
  store!: Store;
}
```

관계 로딩은 일반 엔티티와 동일하게 동작해요.

```typescript
// Child 엔티티의 ManyToOne 관계 로딩
const cards = await em.find(CreditCardPayment, {
  relations: ["store"],
});
console.log(cards[0].store.name); // "MyStore"

// Root 엔티티의 OneToMany 로딩 (모든 결제 타입이 반환됨)
const stores = await em.find(Store, {
  relations: ["payments"],
});
```

::: tip
TPT 전략에서 root 엔티티에 정의된 FK 컬럼은 root 테이블에 저장돼요. ORM이 JOIN 쿼리를 빌드할 때 FK 컬럼을 올바른 테이블로 자동 한정해요.
:::

## WriteBuffer와 함께 사용하기

WriteBuffer 플러그인은 상속 엔티티를 투명하게 지원해요. `find()`, `findOne()`, dirty tracking 모두 상속 계층에서 정상 동작해요.

```typescript
em.extend(bufferPlugin());

const buf = em.buffer();

// findOne은 올바른 하위 클래스 타입으로 반환
const cc = await buf.findOne(CreditCardPayment, { where: { amount: 100 } });
cc.amount = 200;

// Dirty tracking이 상속받은 필드에서도 동작
const result = await buf.flush();
console.log(result.updates); // 1

// Polymorphic query도 올바른 하위 클래스 인스턴스를 반환
const all = await buf.find(Payment, {});
all.forEach(p => {
  if (p instanceof CreditCardPayment) { /* ... */ }
});
```

## QueryBuilder 지원

`SelectQueryBuilder`는 상속 매핑을 **완전히 지원**해요. `em.createQueryBuilder(Entity, alias)`를 사용하면, 해당 엔티티의 전략에 맞는 상속 로직이 자동으로 적용돼요:

- **STI child**: `WHERE discriminator = 'value'` 조건이 자동 추가돼요
- **STI root (polymorphic)**: discriminator 기반 역직렬화로 올바른 서브클래스 인스턴스를 반환해요
- **TPT child**: 부모 테이블에 `INNER JOIN`을 자동 수행하고, 부모 + 자식 컬럼을 결합한 명시적 SELECT를 빌드해요
- **TPT root (polymorphic)**: 모든 자식 테이블에 `LEFT JOIN`하고, 컬럼 접두사를 제거하고, 올바른 서브클래스 인스턴스를 반환해요
- **TPC child**: 자식의 자체 테이블만 직접 쿼리해요 (추가 로직 없음)
- **TPC root (polymorphic)**: 모든 테이블에 걸쳐 NULL 패딩과 가상 discriminator가 포함된 `UNION ALL` 서브쿼리를 자동 생성해요

```typescript
// STI: discriminator WHERE가 자동으로 추가돼요
const cards = await em
  .createQueryBuilder(CreditCardPayment, "p")
  .where("amount", 100)
  .getMany();
// SELECT "p".* FROM "payment" AS "p"
// WHERE "p"."payment_type" = 'credit_card' AND "p"."amount" = $1

// STI root: polymorphic 역직렬화
const all = await em
  .createQueryBuilder(Payment, "p")
  .getMany();
// CreditCardPayment, BankTransferPayment, Payment 인스턴스를 반환해요

// TPT child: 부모 테이블이 자동으로 JOIN돼요
const cards = await em
  .createQueryBuilder(CreditCardPayment, "cc")
  .where("amount", 100)
  .getMany();
// SELECT "cc"."id", "cc"."cardNumber", "payment"."amount"
// FROM "credit_card_payment" AS "cc"
// INNER JOIN "payment" ON "cc"."id" = "payment"."id"
// WHERE "payment"."amount" = $1

// TPC root: UNION ALL이 자동 생성돼요
const all = await em
  .createQueryBuilder(Payment, "p")
  .getMany();
// SELECT * FROM (
//   SELECT ... FROM "payment" UNION ALL
//   SELECT ... FROM "credit_card_payment" UNION ALL
//   SELECT ... FROM "bank_transfer_payment"
// ) "_tpc"
```

모든 QueryBuilder 메서드(`getMany()`, `getOne()`, `getCount()`, `exists()`, `getRawMany()`, `clone()`)가 상속을 지원해요. WHERE, ORDER BY, GROUP BY 절도 polymorphic 쿼리에서 사용할 수 있어요.

## 데코레이터 레퍼런스

### `@Inheritance(options)`

**Root** 엔티티 클래스에만 적용해요. 계층 구조가 사용할 매핑 전략을 정의해요.

```typescript
@Inheritance({ strategy: "SINGLE_TABLE" | "JOINED" | "TABLE_PER_CLASS" })
```

### `@DiscriminatorColumn(options?)`

**Root** 엔티티 클래스에 적용해요. 각 행의 타입 식별자를 저장하는 컬럼을 설정해요.

| 옵션 | 타입 | 기본값 | 설명 |
|------|------|--------|------|
| `name` | `string` | `"dtype"` | 데이터베이스에서의 컬럼명 |
| `type` | `ColumnType` | `"varchar"` | 컬럼 데이터 타입 |
| `length` | `number` | `31` | 컬럼 길이 (varchar일 때) |

```typescript
@DiscriminatorColumn({ name: "payment_type", type: "varchar", length: 50 })
```

TPC 전략에서는 discriminator 컬럼이 데이터베이스에 실제로 저장되지 않고, UNION ALL 쿼리를 위해 내부적으로만 사용돼요.

### `@DiscriminatorValue(value)`

각 **child** 엔티티 클래스에 적용해요. 해당 타입의 행에 discriminator 컬럼에 저장될 문자열 값을 지정해요.

```typescript
@DiscriminatorValue("credit_card")
export class CreditCardPayment extends Payment { ... }
```

생략하면, 클래스 이름이 기본 discriminator 값으로 사용돼요.

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

실무에서 가장 흔한 선택은 **STI**예요. 대부분의 상속 구조는 자식 고유 컬럼이 2-3개 정도로 적고, JOIN 없는 쿼리 성능이 중요하거든요. 자식 고유 컬럼이 10개 이상이거나 NOT NULL 제약 조건이 중요한 경우에만 TPT를 고려하세요.

## API 요약

| 데코레이터 | 대상 | 설명 |
|-----------|------|------|
| `@Inheritance({ strategy })` | Root 클래스 | 상속 전략 선언 |
| `@DiscriminatorColumn({ name?, type?, length? })` | Root 클래스 | Discriminator 컬럼 설정 |
| `@DiscriminatorValue(value)` | Child 클래스 | 해당 타입의 discriminator 값 지정 |

| EntityManager 메서드 | 상속 지원 |
|---------------------|----------|
| `em.find(RootEntity)` | Polymorphic (올바른 하위 클래스 인스턴스 반환) |
| `em.find(ChildEntity)` | 스코프 적용 (STI: WHERE discriminator, TPT: JOIN parent, TPC: 자체 테이블) |
| `em.save(ChildEntity, data)` | 자동 discriminator 설정 + TPT 2단계 insert |
| `em.delete(ChildEntity, criteria)` | STI: discriminator WHERE 추가, TPT: 2단계 delete |
| `em.createQueryBuilder(Entity)` | 완전 지원 (STI discriminator WHERE, TPT 자동 JOIN, TPC UNION ALL, polymorphic 역직렬화) |
| `buf.find(Entity)` | 완전 지원 (EntityManager에 위임) |

## 다음 단계

- **[엔티티](./entities.md)** -- 엔티티와 컬럼 정의의 기초
- **[관계](./relations.md)** -- @ManyToOne / @OneToMany 관계 설정
- **[WriteBuffer](./write-buffer.md)** -- Unit of Work 패턴과 dirty tracking
- **[QueryBuilder](./query-builder.md)** -- SelectQueryBuilder로 복잡한 쿼리 작성
