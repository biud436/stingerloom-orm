import { ClazzType } from "../utils";
import { getScannerInstance } from "../scanner/ScannerContainer";
import { OneToManyScanner } from "../scanner";
import { CascadeOption, normalizeCascade } from "../types/CascadeType";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const ONE_TO_MANY_TOKEN = Symbol.for("STG_ONE_TO_MANY");

export type OneToManyOption<T = any> = {
  /**
   * Property name on the owning side (the ManyToOne side).
   * Type inference restricts it to the target entity's property names.
   */
  mappedBy: Extract<keyof T, string> | (string & {});
  /**
   * Cascade operations.
   * true applies all cascades (insert, update, delete).
   * An array applies selected cascades, e.g. ["insert", "delete"].
   */
  cascade?: CascadeOption;
};

export type OneToManyMetadata<T> = {
  target: ClazzType<unknown>;
  propertyKey: string;

  /**
   * Function returning the related entity class.
   */
  getRelatedEntity: () => ClazzType<T>;

  /**
   * mappedBy: property name on the ManyToOne side.
   */
  mappedBy: string;

  /**
   * Normalized cascade array.
   */
  cascade?: CascadeOption;
};

/**
 * Declares a OneToMany relation.
 * Must be placed on the inverse (non-owning) side of the relation.
 *
 * @example
 *
 * @OneToMany(() => Post, { mappedBy: "user" })
 * posts: Post[];
 */
export function OneToMany<T>(
  getRelatedEntity: () => ClazzType<T>,
  option: OneToManyOption<T>,
): PropertyDecorator {
  return (target, propertyKey) => {
    const cls = target.constructor;

    const scanner = getScannerInstance(OneToManyScanner);

    const metadata = {
      target: cls as ClazzType<unknown>,
      propertyKey: propertyKey.toString(),
      getRelatedEntity,
      mappedBy: option.mappedBy as string,
      cascade: option.cascade,
    } as OneToManyMetadata<T>;

    const columns = Reflect.getMetadata(ONE_TO_MANY_TOKEN, cls);

    Reflect.defineMetadata(
      ONE_TO_MANY_TOKEN,
      [...(columns || []), metadata],
      cls,
    );

    const uniqueKey = scanner.createUniqueKey();
    scanner.setOnPublic<OneToManyMetadata<T>>(uniqueKey, metadata);
  };
}
