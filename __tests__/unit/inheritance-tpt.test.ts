/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { resetScannerContainer } from "../../src/scanner/ScannerContainer";
import {
  Entity,
  ENTITY_TOKEN,
  EntityMetadata,
  Column,
  PrimaryGeneratedColumn,
  Inheritance,
  DiscriminatorColumn,
  DiscriminatorValue,
} from "../../src/decorators";
import { InheritanceResolver } from "../../src/core/InheritanceResolver";

describe("Table Per Type Inheritance (TPT / JOINED)", () => {
  beforeEach(() => {
    resetScannerContainer();
  });

  // ── Decorator metadata tests ──────────────────────────

  describe("Decorator metadata", () => {
    it("should store @Inheritance({ strategy: 'JOINED' }) metadata on root entity", () => {
      @Entity()
      @Inheritance({ strategy: "JOINED" })
      @DiscriminatorColumn({ name: "type", type: "varchar", length: 50 })
      class Payment {
        @PrimaryGeneratedColumn() id!: number;
        @Column() amount!: number;
      }

      const meta = Reflect.getMetadata(ENTITY_TOKEN, Payment) as EntityMetadata;
      expect(meta.inheritanceStrategy).toBe("JOINED");
      expect(meta.discriminatorColumn).toEqual({
        name: "type",
        type: "varchar",
        length: 50,
      });
      expect(meta.childEntities).toEqual([]);
      expect(meta.inheritanceRoot).toBeUndefined();
    });

    it("should keep child entity's own table name (not parent's)", () => {
      @Entity()
      @Inheritance({ strategy: "JOINED" })
      @DiscriminatorColumn({ name: "type" })
      class Payment {
        @PrimaryGeneratedColumn() id!: number;
        @Column() amount!: number;
      }

      @Entity()
      @DiscriminatorValue("credit_card")
      class CreditCardPayment extends Payment {
        @Column() cardNumber!: string;
      }

      const parentMeta = Reflect.getMetadata(ENTITY_TOKEN, Payment) as EntityMetadata;
      const childMeta = Reflect.getMetadata(ENTITY_TOKEN, CreditCardPayment) as EntityMetadata;

      // TPT: child keeps its own table name
      expect(childMeta.name).not.toBe(parentMeta.name);
      expect(childMeta.name).toBe("credit_card_payment");
      expect(childMeta.inheritanceRoot).toBe(Payment);
      expect(childMeta.inheritanceStrategy).toBe("JOINED");
      expect(childMeta.discriminatorValue).toBe("credit_card");
    });

    it("should register child in parent's childEntities array", () => {
      @Entity()
      @Inheritance({ strategy: "JOINED" })
      class Vehicle {
        @PrimaryGeneratedColumn() id!: number;
      }

      @Entity()
      @DiscriminatorValue("car")
      class Car extends Vehicle {
        @Column() doors!: number;
      }

      @Entity()
      @DiscriminatorValue("truck")
      class Truck extends Vehicle {
        @Column() payload!: number;
      }

      const meta = Reflect.getMetadata(ENTITY_TOKEN, Vehicle) as EntityMetadata;
      expect(meta.childEntities).toHaveLength(2);
      expect(meta.childEntities).toContain(Car);
      expect(meta.childEntities).toContain(Truck);
    });

    it("should inherit parent columns in child metadata (full set)", () => {
      @Entity()
      @Inheritance({ strategy: "JOINED" })
      class Base {
        @PrimaryGeneratedColumn() id!: number;
        @Column() name!: string;
      }

      @Entity()
      @DiscriminatorValue("child")
      class Child extends Base {
        @Column() extra!: string;
      }

      const childMeta = Reflect.getMetadata(ENTITY_TOKEN, Child) as EntityMetadata;
      const colNames = childMeta.columns.map((c: any) => c.propertyKey ?? c.name);
      // Child metadata still has all columns (Entity decorator walks prototype chain)
      expect(colNames).toContain("id");
      expect(colNames).toContain("name");
      expect(colNames).toContain("extra");
    });
  });

  // ── InheritanceResolver tests ──────────────────────────

  describe("InheritanceResolver", () => {
    let resolver: InheritanceResolver;

    beforeEach(() => {
      resolver = new InheritanceResolver();
    });

    it("should identify root entity with JOINED strategy", () => {
      @Entity()
      @Inheritance({ strategy: "JOINED" })
      class Payment {
        @PrimaryGeneratedColumn() id!: number;
      }

      @Entity()
      @DiscriminatorValue("cc")
      class CC extends Payment {}

      expect(resolver.isRootEntity(Payment)).toBe(true);
      expect(resolver.getStrategy(Payment)).toBe("JOINED");
      expect(resolver.getRoot(Payment)).toBe(Payment);
    });

    it("should identify child entity with JOINED strategy", () => {
      @Entity()
      @Inheritance({ strategy: "JOINED" })
      class A {
        @PrimaryGeneratedColumn() id!: number;
      }

      @Entity()
      @DiscriminatorValue("b")
      class B extends A {
        @Column() extra!: string;
      }

      expect(resolver.isChildEntity(B)).toBe(true);
      expect(resolver.getStrategy(B)).toBe("JOINED");
      expect(resolver.getRoot(B)).toBe(A);
    });

    it("should get own columns (excluding parent columns) for TPT", () => {
      @Entity()
      @Inheritance({ strategy: "JOINED" })
      class Base {
        @PrimaryGeneratedColumn() id!: number;
        @Column() shared!: string;
      }

      @Entity()
      @DiscriminatorValue("child")
      class Child extends Base {
        @Column() ownField!: string;
      }

      const ownCols = resolver.getOwnColumns(Child);
      const ownNames = ownCols.map((c) => c.propertyKey ?? c.name);
      expect(ownNames).toContain("ownField");
      expect(ownNames).not.toContain("id");
      expect(ownNames).not.toContain("shared");
    });

    it("should build discriminator map for JOINED strategy", () => {
      @Entity()
      @Inheritance({ strategy: "JOINED" })
      @DiscriminatorColumn({ name: "type" })
      class Payment {
        @PrimaryGeneratedColumn() id!: number;
      }

      @Entity()
      @DiscriminatorValue("credit_card")
      class CreditCard extends Payment {}

      @Entity()
      @DiscriminatorValue("bank")
      class Bank extends Payment {}

      const map = resolver.buildDiscriminatorMap(Payment);
      expect(map.size).toBe(3);
      expect(map.get("Payment")).toBe(Payment);
      expect(map.get("credit_card")).toBe(CreditCard);
      expect(map.get("bank")).toBe(Bank);
    });

    it("should detect polymorphic query for root with children", () => {
      @Entity()
      @Inheritance({ strategy: "JOINED" })
      class Root {
        @PrimaryGeneratedColumn() id!: number;
      }

      @Entity()
      @DiscriminatorValue("a")
      class ChildA extends Root {}

      expect(resolver.isPolymorphicQuery(Root)).toBe(true);
      expect(resolver.isPolymorphicQuery(ChildA)).toBe(false);
    });
  });

  // ── Deep hierarchy test ──────────────────────────

  describe("Deep inheritance hierarchy (JOINED)", () => {
    it("should handle A -> B -> C chain", () => {
      @Entity()
      @Inheritance({ strategy: "JOINED" })
      @DiscriminatorColumn({ name: "type" })
      class A {
        @PrimaryGeneratedColumn() id!: number;
        @Column() baseField!: string;
      }

      @Entity()
      @DiscriminatorValue("b")
      class B extends A {
        @Column() bField!: string;
      }

      @Entity()
      @DiscriminatorValue("c")
      class C extends B {
        @Column() cField!: string;
      }

      const resolver = new InheritanceResolver();

      // C has all columns from A, B, C in its metadata
      const cMeta = Reflect.getMetadata(ENTITY_TOKEN, C) as EntityMetadata;
      const cColNames = cMeta.columns.map((c: any) => c.propertyKey ?? c.name);
      expect(cColNames).toContain("id");
      expect(cColNames).toContain("baseField");
      expect(cColNames).toContain("bField");
      expect(cColNames).toContain("cField");

      expect(resolver.isChildEntity(C)).toBe(true);
      expect(resolver.isChildEntity(B)).toBe(true);
      expect(resolver.isRootEntity(A)).toBe(true);
      expect(resolver.getRoot(C)).toBe(A);
      expect(resolver.getRoot(B)).toBe(A);

      // TPT: each child keeps its own table name
      expect(cMeta.name).toBe("c");
      const bMeta = Reflect.getMetadata(ENTITY_TOKEN, B) as EntityMetadata;
      expect(bMeta.name).toBe("b");

      const aMeta = Reflect.getMetadata(ENTITY_TOKEN, A) as EntityMetadata;
      expect(aMeta.childEntities).toContain(B);
      expect(aMeta.childEntities).toContain(C);
    });
  });
});
