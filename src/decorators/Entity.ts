/* eslint-disable @typescript-eslint/no-explicit-any */
import { getScannerInstance } from "../scanner/ScannerContainer";
import { ColumnScanner, EntityScanner, ManyToOneScanner, OneToManyScanner, ManyToManyScanner } from "../scanner";
import { OneToOneScanner } from "../scanner/OneToOneScanner";
import { createEntityKey } from "../utils/scanner";
import { ColumnOption } from "./Column";
import { ClazzType } from "../utils";
import { ManyToOneMetadata } from "./ManyToOne";
import { OneToManyMetadata } from "./OneToMany";
import { OneToOneMetadata } from "./OneToOne";
import { ManyToManyMetadata } from "./ManyToMany";
import { ColumnMetadata } from "../scanner/ColumnScanner";
import { camelToSnakeCase } from "../utils/camelToSnakeCase";
import { INHERITANCE_TOKEN, InheritanceStrategy } from "./Inheritance";
import { DISCRIMINATOR_COLUMN_TOKEN } from "./DiscriminatorColumn";
import { DISCRIMINATOR_VALUE_TOKEN } from "./DiscriminatorValue";
import { KnownColumnType } from "./Column";

export interface EntityOption {
  name?: string;
}

export const ENTITY_TOKEN = Symbol.for("STG_ENTITY");

export type EntityMetadata<T = any> = {
  target: ClazzType<T>;
  name: string;
  /** True when the user explicitly provided `@Entity({ name: "..." })`. */
  nameExplicit?: boolean;
  /** Raw class name before NamingStrategy transformation. */
  rawClassName?: string;
  columns: ColumnOption[];
  manyToOnes?: ManyToOneMetadata<unknown>[];
  oneToManys?: OneToManyMetadata<unknown>[];
  oneToOnes?: OneToOneMetadata<unknown>[];
  manyToManys?: ManyToManyMetadata<unknown>[];
  options?: EntityOption;
  /** Root entity of the inheritance hierarchy (set on children). */
  inheritanceRoot?: ClazzType<any>;
  /** Inheritance strategy for this entity hierarchy. */
  inheritanceStrategy?: InheritanceStrategy;
  /** Discriminator value for this entity (STI/TPT). */
  discriminatorValue?: string;
  /** Discriminator column definition (only on root entity). */
  discriminatorColumn?: { name: string; type: KnownColumnType; length: number };
  /** Child entity classes in this inheritance hierarchy (only on root entity). */
  childEntities?: ClazzType<any>[];
};

export function Entity(options?: EntityOption): ClassDecorator {
  return function (target) {
    const scanner = getScannerInstance(EntityScanner);
    const columnScanner = getScannerInstance(ColumnScanner);
    const manyToOneScanner = getScannerInstance(ManyToOneScanner);
    const oneToManyScanner = getScannerInstance(OneToManyScanner);
    const oneToOneScanner = getScannerInstance(OneToOneScanner);
    const manyToManyScanner = getScannerInstance(ManyToManyScanner);

    const hasExplicitName = !!options?.name;
    let nameKey = hasExplicitName
      ? options!.name!
      : camelToSnakeCase(target.name);

    // Target-based filtering: collect metadata from this class and its ancestors (inheritance support).
    // @Column target is the prototype; @ManyToOne/@OneToMany/@OneToOne/@ManyToMany targets are constructors.
    const proto = target.prototype;

    // Walk the prototype chain so ancestor metadata is included
    const protoChain: object[] = [];
    let current = proto;
    while (current && current !== Object.prototype) {
      protoChain.push(current);
      current = Object.getPrototypeOf(current);
    }

    const constructorChain: Function[] = [];
    let ctor: Function = target;
    while (ctor && ctor !== Function.prototype && ctor !== Object) {
      constructorChain.push(ctor);
      ctor = Object.getPrototypeOf(ctor);
    }

    // ── Inheritance detection ──────────────────────────────────
    let inheritanceRoot: ClazzType<any> | undefined;
    let inheritanceStrategy: InheritanceStrategy | undefined;
    let discriminatorValue: string | undefined;
    let discriminatorColumn:
      | { name: string; type: KnownColumnType; length: number }
      | undefined;
    let childEntities: ClazzType<any>[] | undefined;

    // Check if THIS class is the inheritance root (use getOwnMetadata to avoid
    // finding parent's @Inheritance via prototype chain traversal)
    const inheritanceMeta = Reflect.getOwnMetadata(INHERITANCE_TOKEN, target);
    if (inheritanceMeta) {
      inheritanceStrategy = inheritanceMeta.strategy;
      const dcMeta = Reflect.getOwnMetadata(DISCRIMINATOR_COLUMN_TOKEN, target);
      discriminatorColumn = dcMeta ?? {
        name: "dtype",
        type: "varchar" as KnownColumnType,
        length: 31,
      };
      childEntities = [];
      // Root entity's own discriminator value
      discriminatorValue =
        Reflect.getOwnMetadata(DISCRIMINATOR_VALUE_TOKEN, target) ?? target.name;
    } else {
      // Walk up the constructor chain to find the ancestor with @Inheritance (the root).
      // Use getOwnMetadata so intermediate classes (B in A→B→C) don't
      // falsely match due to prototype-chain traversal.
      for (let i = 1; i < constructorChain.length; i++) {
        const parent = constructorChain[i];
        const parentInheritance = Reflect.getOwnMetadata(
          INHERITANCE_TOKEN,
          parent,
        );
        if (parentInheritance) {
          inheritanceRoot = parent as ClazzType<any>;
          inheritanceStrategy = parentInheritance.strategy;

          // Read discriminator value (default: class name)
          discriminatorValue =
            Reflect.getOwnMetadata(DISCRIMINATOR_VALUE_TOKEN, target) ??
            target.name;

          // Read discriminator column from root
          discriminatorColumn =
            Reflect.getOwnMetadata(DISCRIMINATOR_COLUMN_TOKEN, parent) ?? {
              name: "dtype",
              type: "varchar" as KnownColumnType,
              length: 31,
            };

          // For STI: use the root's table name (all subclasses share one table)
          if (inheritanceStrategy === "SINGLE_TABLE" && !hasExplicitName) {
            const rootMeta = Reflect.getOwnMetadata(ENTITY_TOKEN, parent) as
              | EntityMetadata
              | undefined;
            if (rootMeta) {
              nameKey = rootMeta.name;
            }
          }

          // Register this child in the root's metadata
          const rootMeta = Reflect.getOwnMetadata(ENTITY_TOKEN, parent) as
            | EntityMetadata
            | undefined;
          if (rootMeta?.childEntities) {
            rootMeta.childEntities.push(target as unknown as ClazzType<any>);
          }

          break;
        }
      }
    }

    const columns = columnScanner
      .allMetadata<ColumnMetadata>()
      .filter((c) => protoChain.includes(c.target as object));
    const manyToOnes = manyToOneScanner
      .allMetadata<ManyToOneMetadata<unknown>>()
      .filter((m) => constructorChain.includes(m.target as Function));
    const oneToManys = oneToManyScanner
      .allMetadata<OneToManyMetadata<unknown>>()
      .filter((m) => constructorChain.includes(m.target as Function));
    const oneToOnes = oneToOneScanner
      .allMetadata<OneToOneMetadata<unknown>>()
      .filter((m) => constructorChain.includes(m.target as Function));
    const manyToManys = manyToManyScanner
      .allMetadata<ManyToManyMetadata<unknown>>()
      .filter((m) => constructorChain.includes(m.target as Function));

    const metadata: EntityMetadata = {
      target: target as unknown as ClazzType<any>,
      columns,
      manyToOnes,
      oneToManys,
      oneToOnes,
      manyToManys,
      options,
      name: nameKey,
      nameExplicit: hasExplicitName,
      rawClassName: target.name,
      inheritanceRoot,
      inheritanceStrategy,
      discriminatorValue,
      discriminatorColumn,
      childEntities,
    };

    // Scanner key must be unique per class — use the class's own name,
    // NOT the table name (which may be shared in STI hierarchies).
    const scannerKey = createEntityKey(camelToSnakeCase(target.name));
    scanner.set(scannerKey, metadata);

    Reflect.defineMetadata(ENTITY_TOKEN, metadata, target);
  };
}
