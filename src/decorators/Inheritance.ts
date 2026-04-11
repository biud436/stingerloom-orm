export type InheritanceStrategy = "SINGLE_TABLE" | "JOINED" | "TABLE_PER_CLASS";

export interface InheritanceOptions {
  strategy: InheritanceStrategy;
}

export const INHERITANCE_TOKEN = Symbol.for("STG_INHERITANCE");

/**
 * Marks an entity as the root of an inheritance hierarchy.
 * Applied to the parent (root) class only.
 *
 * @example
 * @Entity()
 * @Inheritance({ strategy: "SINGLE_TABLE" })
 * @DiscriminatorColumn({ name: "type" })
 * class Payment {
 *   @PrimaryGeneratedColumn() id: number;
 *   @Column() amount: number;
 * }
 */
export function Inheritance(options: InheritanceOptions): ClassDecorator {
  return function (target) {
    Reflect.defineMetadata(
      INHERITANCE_TOKEN,
      { strategy: options.strategy, target },
      target,
    );
  };
}
