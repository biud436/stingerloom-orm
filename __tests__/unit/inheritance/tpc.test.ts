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

describe("Table Per Concrete Class Inheritance (TPC)", () => {
  beforeEach(() => {
    resetScannerContainer();
  });

  // ── Decorator metadata tests ──────────────────────────

  describe("Decorator metadata", () => {
    it("should store @Inheritance({ strategy: 'TABLE_PER_CLASS' }) metadata", () => {
      @Entity()
      @Inheritance({ strategy: "TABLE_PER_CLASS" })
      @DiscriminatorColumn({ name: "dtype" })
      class Payment {
        @PrimaryGeneratedColumn() id!: number;
        @Column() amount!: number;
      }

      const meta = Reflect.getMetadata(ENTITY_TOKEN, Payment) as EntityMetadata;
      expect(meta.inheritanceStrategy).toBe("TABLE_PER_CLASS");
      expect(meta.childEntities).toEqual([]);
    });

    it("should keep each entity's own table name", () => {
      @Entity()
      @Inheritance({ strategy: "TABLE_PER_CLASS" })
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

      expect(parentMeta.name).toBe("payment");
      expect(childMeta.name).toBe("credit_card_payment");
      expect(childMeta.name).not.toBe(parentMeta.name);
    });

    it("should include ALL columns (inherited + own) in child metadata", () => {
      @Entity()
      @Inheritance({ strategy: "TABLE_PER_CLASS" })
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
      expect(colNames).toContain("id");
      expect(colNames).toContain("name");
      expect(colNames).toContain("extra");
    });

    it("should register children in parent's childEntities", () => {
      @Entity()
      @Inheritance({ strategy: "TABLE_PER_CLASS" })
      class Shape {
        @PrimaryGeneratedColumn() id!: number;
      }

      @Entity()
      @DiscriminatorValue("circle")
      class Circle extends Shape {
        @Column() radius!: number;
      }

      @Entity()
      @DiscriminatorValue("rect")
      class Rect extends Shape {
        @Column() width!: number;
        @Column() height!: number;
      }

      const meta = Reflect.getMetadata(ENTITY_TOKEN, Shape) as EntityMetadata;
      expect(meta.childEntities).toHaveLength(2);
      expect(meta.childEntities).toContain(Circle);
      expect(meta.childEntities).toContain(Rect);
    });
  });

  // ── InheritanceResolver tests ──────────────────────────

  describe("InheritanceResolver", () => {
    let resolver: InheritanceResolver;

    beforeEach(() => {
      resolver = new InheritanceResolver();
    });

    it("should identify root and children for TABLE_PER_CLASS", () => {
      @Entity()
      @Inheritance({ strategy: "TABLE_PER_CLASS" })
      class Payment {
        @PrimaryGeneratedColumn() id!: number;
      }

      @Entity()
      @DiscriminatorValue("cc")
      class CC extends Payment {}

      expect(resolver.isRootEntity(Payment)).toBe(true);
      expect(resolver.isChildEntity(CC)).toBe(true);
      expect(resolver.getStrategy(Payment)).toBe("TABLE_PER_CLASS");
      expect(resolver.getStrategy(CC)).toBe("TABLE_PER_CLASS");
    });

    it("should detect polymorphic query for TPC root", () => {
      @Entity()
      @Inheritance({ strategy: "TABLE_PER_CLASS" })
      class Root {
        @PrimaryGeneratedColumn() id!: number;
      }

      @Entity()
      @DiscriminatorValue("a")
      class ChildA extends Root {}

      expect(resolver.isPolymorphicQuery(Root)).toBe(true);
      expect(resolver.isPolymorphicQuery(ChildA)).toBe(false);
    });

    it("should return all hierarchy columns as superset", () => {
      @Entity()
      @Inheritance({ strategy: "TABLE_PER_CLASS" })
      class Payment {
        @PrimaryGeneratedColumn() id!: number;
        @Column() amount!: number;
      }

      @Entity()
      @DiscriminatorValue("cc")
      class CC extends Payment {
        @Column() cardNumber!: string;
      }

      @Entity()
      @DiscriminatorValue("bank")
      class Bank extends Payment {
        @Column() bankCode!: string;
      }

      const allCols = resolver.getAllHierarchyColumns(Payment);
      const allNames = allCols.map((c) => c.propertyKey ?? c.name);
      expect(allNames).toContain("id");
      expect(allNames).toContain("amount");
      expect(allNames).toContain("cardNumber");
      expect(allNames).toContain("bankCode");
    });

    it("should get own columns for TPC (same as STI)", () => {
      @Entity()
      @Inheritance({ strategy: "TABLE_PER_CLASS" })
      class Base {
        @PrimaryGeneratedColumn() id!: number;
        @Column() shared!: string;
      }

      @Entity()
      @DiscriminatorValue("child")
      class Child extends Base {
        @Column() own!: string;
      }

      const ownCols = resolver.getOwnColumns(Child);
      const ownNames = ownCols.map((c) => c.propertyKey ?? c.name);
      expect(ownNames).toContain("own");
      expect(ownNames).not.toContain("id");
      expect(ownNames).not.toContain("shared");
    });
  });
});
