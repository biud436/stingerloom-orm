import { ClazzType } from "../utils";
import { getScannerInstance } from "../scanner/ScannerContainer";
import { ManyToManyScanner } from "../scanner";
import { CascadeOption } from "../types/CascadeType";
import { OrmError } from "../errors/OrmError";
import { OrmErrorCode } from "../errors/OrmErrorCode";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const MANY_TO_MANY_TOKEN = Symbol.for("STG_MANY_TO_MANY");

export type JoinTableOption = {
  /**
   * Name of the intermediate (join) table.
   */
  name: string;

  /**
   * FK column in the join table that references this entity's PK.
   */
  joinColumn: string;

  /**
   * FK column in the join table that references the target entity's PK.
   */
  inverseJoinColumn: string;
};

export type ManyToManyOption<T = any> = {
  /**
   * Join-table definition.
   * Must be provided on the owning side of the relation.
   */
  joinTable?: JoinTableOption;

  /**
   * On the inverse side, the property name on the owning side.
   * Type inference restricts it to the target entity's property names.
   */
  mappedBy?: Extract<keyof T, string> | (string & {});

  /**
   * Cascade option (insert, update, delete or true/false).
   */
  cascade?: CascadeOption;
};

export type ManyToManyMetadata<T> = {
  target: ClazzType<unknown>;
  propertyKey: string;

  /**
   * Function returning the target entity class.
   */
  getRelatedEntity: () => ClazzType<T>;

  /**
   * Join-table definition (owning side only).
   */
  joinTable?: JoinTableOption;

  /**
   * Property name on the owning side, used by the inverse side.
   */
  mappedBy?: string;

  /**
   * Cascade option.
   */
  cascade?: CascadeOption;
};

/**
 * Validates a `joinTable` option at registration time.
 *
 * TypeScript rejects malformed values at compile time, but plain-JavaScript
 * consumers (no type checking) can pass `joinTable: true` or a partial
 * object — without this check that surfaces much later as a cryptic
 * `Cannot read properties of undefined` inside schema sync.
 */
export function validateJoinTableOption(
  joinTable: unknown,
  ownerName: string,
  propertyKey: string,
): void {
  if (joinTable == null) return;
  const jt = joinTable as Partial<JoinTableOption>;
  const isValid =
    typeof jt === "object" &&
    typeof jt.name === "string" &&
    jt.name.length > 0 &&
    typeof jt.joinColumn === "string" &&
    jt.joinColumn.length > 0 &&
    typeof jt.inverseJoinColumn === "string" &&
    jt.inverseJoinColumn.length > 0;
  if (!isValid) {
    throw new OrmError(
      OrmErrorCode.SCHEMA_ERROR,
      `Invalid joinTable option on ${ownerName}.${propertyKey}: expected { name, joinColumn, inverseJoinColumn } (all non-empty strings), got ${JSON.stringify(joinTable)}.`,
      `Declare the join table explicitly, e.g. joinTable: { name: "post_tags", joinColumn: "post_id", inverseJoinColumn: "tag_id" }.`,
    );
  }
}

/**
 * Declares a ManyToMany relation.
 * Expresses a many-to-many association between two entities via a join table.
 *
 * @example
 * // Owning side (joinTable specified)
 * @ManyToMany(() => Tag, {
 *   joinTable: {
 *     name: "post_tags",
 *     joinColumn: "post_id",
 *     inverseJoinColumn: "tag_id",
 *   },
 * })
 * tags: Tag[];
 *
 * @example
 * // Inverse side (mappedBy specified)
 * @ManyToMany(() => Post, { mappedBy: "tags" })
 * posts: Post[];
 */
export function ManyToMany<T>(
  getRelatedEntity: () => ClazzType<T>,
  option?: ManyToManyOption<T>,
): PropertyDecorator {
  return (target, propertyKey) => {
    const cls = target.constructor;

    validateJoinTableOption(
      option?.joinTable,
      cls.name,
      propertyKey.toString(),
    );

    const scanner = getScannerInstance(ManyToManyScanner);

    const metadata = <ManyToManyMetadata<T>>{
      target: cls,
      propertyKey: propertyKey.toString(),
      getRelatedEntity,
      joinTable: option?.joinTable,
      mappedBy: option?.mappedBy,
      cascade: option?.cascade,
    };

    const existing: ManyToManyMetadata<T>[] = Reflect.getMetadata(MANY_TO_MANY_TOKEN, cls) || [];
    const filtered = existing.filter((c) => c.propertyKey !== metadata.propertyKey);

    Reflect.defineMetadata(
      MANY_TO_MANY_TOKEN,
      [...filtered, metadata],
      cls,
    );

    const uniqueKey = scanner.createUniqueKey();
    scanner.setOnPublic<ManyToManyMetadata<T>>(uniqueKey, metadata);
  };
}
