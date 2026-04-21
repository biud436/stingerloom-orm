/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { resetScannerContainer } from "../../../src/scanner/ScannerContainer";
import {
  Entity,
  ENTITY_TOKEN,
  EntityMetadata,
  Column,
  PrimaryGeneratedColumn,
  Inheritance,
  DiscriminatorColumn,
  DiscriminatorValue,
} from "../../../src/decorators";
import { InheritanceResolver } from "../../../src/core/InheritanceResolver";

describe("Single Table Inheritance (STI)", () => {
  beforeEach(() => {
    resetScannerContainer();
  });

  // ── Decorator metadata tests ──────────────────────────

  describe("Decorator metadata", () => {
    it("should store @Inheritance metadata on root entity", () => {
      @Entity()
      @Inheritance({ strategy: "SINGLE_TABLE" })
      @DiscriminatorColumn({ name: "type", type: "varchar", length: 50 })
      class Payment {
        @PrimaryGeneratedColumn() id!: number;
        @Column() amount!: number;
      }

      const meta = Reflect.getMetadata(ENTITY_TOKEN, Payment) as EntityMetadata;
      expect(meta.inheritanceStrategy).toBe("SINGLE_TABLE");
      expect(meta.discriminatorColumn).toEqual({
        name: "type",
        type: "varchar",
        length: 50,
      });
      expect(meta.childEntities).toEqual([]);
      expect(meta.inheritanceRoot).toBeUndefined();
    });

    it("should use default discriminator column when @DiscriminatorColumn omitted", () => {
      @Entity()
      @Inheritance({ strategy: "SINGLE_TABLE" })
      class Animal {
        @PrimaryGeneratedColumn() id!: number;
      }

      const meta = Reflect.getMetadata(ENTITY_TOKEN, Animal) as EntityMetadata;
      expect(meta.discriminatorColumn).toEqual({
        name: "dtype",
        type: "varchar",
        length: 31,
      });
    });

    it("should set child entity table name to parent table name for STI", () => {
      @Entity()
      @Inheritance({ strategy: "SINGLE_TABLE" })
      @DiscriminatorColumn({ name: "type" })
      class Payment {
        @PrimaryGeneratedColumn() id!: number;
        @Column() amount!: number;
      }

      @Entity()
      @DiscriminatorValue("credit_card")
      class CreditCardPayment extends Payment {
        @Column({ nullable: true }) cardNumber!: string;
      }

      const parentMeta = Reflect.getMetadata(ENTITY_TOKEN, Payment) as EntityMetadata;
      const childMeta = Reflect.getMetadata(ENTITY_TOKEN, CreditCardPayment) as EntityMetadata;

      // STI child must reuse the parent's table name
      expect(childMeta.name).toBe(parentMeta.name);
      expect(childMeta.inheritanceRoot).toBe(Payment);
      expect(childMeta.inheritanceStrategy).toBe("SINGLE_TABLE");
      expect(childMeta.discriminatorValue).toBe("credit_card");
    });

    it("should register child in parent's childEntities array", () => {
      @Entity()
      @Inheritance({ strategy: "SINGLE_TABLE" })
      class Vehicle {
        @PrimaryGeneratedColumn() id!: number;
      }

      @Entity()
      @DiscriminatorValue("car")
      class Car extends Vehicle {
        @Column({ nullable: true }) doors!: number;
      }

      @Entity()
      @DiscriminatorValue("truck")
      class Truck extends Vehicle {
        @Column({ nullable: true }) payload!: number;
      }

      const meta = Reflect.getMetadata(ENTITY_TOKEN, Vehicle) as EntityMetadata;
      expect(meta.childEntities).toHaveLength(2);
      expect(meta.childEntities).toContain(Car);
      expect(meta.childEntities).toContain(Truck);
    });

    it("should default discriminator value to class name when @DiscriminatorValue omitted", () => {
      @Entity()
      @Inheritance({ strategy: "SINGLE_TABLE" })
      class Shape {
        @PrimaryGeneratedColumn() id!: number;
      }

      @Entity()
      class Circle extends Shape {
        @Column({ nullable: true }) radius!: number;
      }

      const childMeta = Reflect.getMetadata(ENTITY_TOKEN, Circle) as EntityMetadata;
      expect(childMeta.discriminatorValue).toBe("Circle");
    });

    it("should inherit parent columns in child metadata", () => {
      @Entity()
      @Inheritance({ strategy: "SINGLE_TABLE" })
      class Base {
        @PrimaryGeneratedColumn() id!: number;
        @Column() name!: string;
      }

      @Entity()
      @DiscriminatorValue("child")
      class Child extends Base {
        @Column({ nullable: true }) extra!: string;
      }

      const childMeta = Reflect.getMetadata(ENTITY_TOKEN, Child) as EntityMetadata;
      const colNames = childMeta.columns.map((c: any) => c.propertyKey ?? c.name);
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

    it("should return null for non-inheritance entities", () => {
      @Entity()
      class PlainEntity {
        @PrimaryGeneratedColumn() id!: number;
      }

      expect(resolver.getStrategy(PlainEntity)).toBeNull();
      expect(resolver.getRoot(PlainEntity)).toBeNull();
      expect(resolver.isChildEntity(PlainEntity)).toBe(false);
      expect(resolver.isRootEntity(PlainEntity)).toBe(false);
    });

    it("should identify root entity", () => {
      @Entity()
      @Inheritance({ strategy: "SINGLE_TABLE" })
      class Payment {
        @PrimaryGeneratedColumn() id!: number;
      }

      @Entity()
      @DiscriminatorValue("cc")
      class CC extends Payment {}

      expect(resolver.isRootEntity(Payment)).toBe(true);
      expect(resolver.isChildEntity(Payment)).toBe(false);
      expect(resolver.getStrategy(Payment)).toBe("SINGLE_TABLE");
      expect(resolver.getRoot(Payment)).toBe(Payment);
    });

    it("should identify child entity", () => {
      @Entity()
      @Inheritance({ strategy: "SINGLE_TABLE" })
      class A {
        @PrimaryGeneratedColumn() id!: number;
      }

      @Entity()
      @DiscriminatorValue("b")
      class B extends A {
        @Column({ nullable: true }) extra!: string;
      }

      expect(resolver.isChildEntity(B)).toBe(true);
      expect(resolver.isRootEntity(B)).toBe(false);
      expect(resolver.getStrategy(B)).toBe("SINGLE_TABLE");
      expect(resolver.getRoot(B)).toBe(A);
    });

    it("should build discriminator map", () => {
      @Entity()
      @Inheritance({ strategy: "SINGLE_TABLE" })
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

    it("should get own columns (excluding parent columns)", () => {
      @Entity()
      @Inheritance({ strategy: "SINGLE_TABLE" })
      class Base {
        @PrimaryGeneratedColumn() id!: number;
        @Column() shared!: string;
      }

      @Entity()
      @DiscriminatorValue("child")
      class Child extends Base {
        @Column({ nullable: true }) ownField!: string;
      }

      const ownCols = resolver.getOwnColumns(Child);
      const ownNames = ownCols.map((c) => c.propertyKey ?? c.name);
      expect(ownNames).toContain("ownField");
      expect(ownNames).not.toContain("id");
      expect(ownNames).not.toContain("shared");
    });

    it("should return all columns as own for root entity", () => {
      @Entity()
      @Inheritance({ strategy: "SINGLE_TABLE" })
      class Root {
        @PrimaryGeneratedColumn() id!: number;
        @Column() name!: string;
      }

      const ownCols = resolver.getOwnColumns(Root);
      const ownNames = ownCols.map((c) => c.propertyKey ?? c.name);
      expect(ownNames).toContain("id");
      expect(ownNames).toContain("name");
    });

    it("should detect polymorphic query for root with children", () => {
      @Entity()
      @Inheritance({ strategy: "SINGLE_TABLE" })
      class Root {
        @PrimaryGeneratedColumn() id!: number;
      }

      @Entity()
      @DiscriminatorValue("a")
      class ChildA extends Root {}

      expect(resolver.isPolymorphicQuery(Root)).toBe(true);
      expect(resolver.isPolymorphicQuery(ChildA)).toBe(false);
    });

    it("should get discriminator column from child entity", () => {
      @Entity()
      @Inheritance({ strategy: "SINGLE_TABLE" })
      @DiscriminatorColumn({ name: "kind", type: "varchar", length: 20 })
      class Animal {
        @PrimaryGeneratedColumn() id!: number;
      }

      @Entity()
      @DiscriminatorValue("dog")
      class Dog extends Animal {}

      const col = resolver.getDiscriminatorColumn(Dog);
      expect(col).toEqual({ name: "kind", type: "varchar", length: 20 });
    });
  });

  // ── Deep hierarchy test ──────────────────────────

  describe("Deep inheritance hierarchy", () => {
    it("should handle A → B → C chain", () => {
      @Entity()
      @Inheritance({ strategy: "SINGLE_TABLE" })
      @DiscriminatorColumn({ name: "type" })
      class A {
        @PrimaryGeneratedColumn() id!: number;
        @Column() baseField!: string;
      }

      @Entity()
      @DiscriminatorValue("b")
      class B extends A {
        @Column({ nullable: true }) bField!: string;
      }

      @Entity()
      @DiscriminatorValue("c")
      class C extends B {
        @Column({ nullable: true }) cField!: string;
      }

      const resolver = new InheritanceResolver();

      // C should have all columns from A, B, C
      const cMeta = Reflect.getMetadata(ENTITY_TOKEN, C) as EntityMetadata;
      const cColNames = cMeta.columns.map((c: any) => c.propertyKey ?? c.name);
      expect(cColNames).toContain("id");
      expect(cColNames).toContain("baseField");
      expect(cColNames).toContain("bField");
      expect(cColNames).toContain("cField");

      // C is a child, B is also a child
      expect(resolver.isChildEntity(C)).toBe(true);
      expect(resolver.isChildEntity(B)).toBe(true);
      expect(resolver.isRootEntity(A)).toBe(true);

      // C's root should be A
      expect(resolver.getRoot(C)).toBe(A);
      expect(resolver.getRoot(B)).toBe(A);

      // All entities should use A's table name
      expect(cMeta.name).toBe("a");

      // A should have B and C as children
      const aMeta = Reflect.getMetadata(ENTITY_TOKEN, A) as EntityMetadata;
      expect(aMeta.childEntities).toContain(B);
      // Note: C extends B, not A directly. C registers on B's parent (A).
      // Both B and C should be in A's childEntities.
      expect(aMeta.childEntities).toContain(C);
    });
  });
});
