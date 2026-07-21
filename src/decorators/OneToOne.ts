import { ClazzType, Logger } from "../utils";
import { getScannerInstance } from "../scanner/ScannerContainer";
import { OneToOneScanner } from "../scanner/OneToOneScanner";
import { CascadeOption } from "../types/CascadeType";
import { ReferentialAction } from "../types/ReferentialAction";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const ONE_TO_ONE_TOKEN = Symbol.for("STG_ONE_TO_ONE");

const logger = new Logger("OneToOne");

export type OneToOneOption<T = any> = {
  /**
   * FK column name. Set on the owning side.
   *
   * Second tier of FK resolution: `@RelationColumn({ name })` wins when
   * present, then this option, then a `{propertyName}Id` `@Column`.
   * Prefer `@RelationColumn` on new code — it also carries the FK's type and
   * nullability — but this option stays fully supported.
   */
  joinColumn?: string;

  /**
   * Property name on the owning side, referenced from the inverse side.
   * Type inference restricts it to the target entity's property names.
   */
  inverseSide?: Extract<keyof T, string> | (string & {});

  /**
   * When true, find/findOne automatically performs a LEFT JOIN to eager-load the related entity.
   */
  eager?: boolean;

  /**
   * Cascade operations.
   * true applies all cascades (insert, update, delete).
   * An array applies selected cascades, e.g. ["insert", "delete"].
   */
  cascade?: CascadeOption;
  /**
   * Referential action for ON DELETE clause.
   * @default 'NO ACTION'
   */
  onDelete?: ReferentialAction;
  /**
   * Referential action for ON UPDATE clause.
   * @default 'NO ACTION'
   */
  onUpdate?: ReferentialAction;
  /**
   * Set to false to skip creating FK constraint in DDL.
   * @default true
   */
  createForeignKeyConstraints?: boolean;

  /**
   * TypeScript property name that backs this relation's FK value.
   *
   * Stingerloom's convention is `{relationProp}Id` (e.g. relation `profile`
   * → FK property `profileId`). Set `fkProperty` when the FK lives on a
   * differently-named property so `qAlias(Entity).<prop>` resolves to the
   * underlying join column.
   *
   * @example
   * ```ts
   * @OneToOne(() => Profile, { fkProperty: "profilePk" })
   * @RelationColumn({ name: "profile_id" })
   * profile!: Profile;
   * ```
   */
  fkProperty?: string;
};

export type OneToOneMetadata<T> = {
  target: ClazzType<unknown>;
  propertyKey: string;

  /**
   * Function that returns the target entity class.
   */
  getRelatedEntity: () => ClazzType<T>;

  /**
   * FK column name (owning side only).
   */
  joinColumn?: string;

  /**
   * Property name on the owning side, used by the inverse side.
   */
  inverseSide?: string;

  /**
   * Options.
   */
  option?: OneToOneOption;
};

/**
 * Declares a OneToOne relation.
 * Expresses a one-to-one association between two entities.
 *
 * @example
 * // Owning side (FK column specified via @RelationColumn)
 * @OneToOne(() => Profile)
 * @RelationColumn({ name: "profile_id" })
 * profile: Profile;
 *
 * @example
 * // Inverse side (inverseSide specified)
 * @OneToOne(() => User, { inverseSide: "profile" })
 * user: User;
 */
export function OneToOne<T>(
  getRelatedEntity: () => ClazzType<T>,
  option?: OneToOneOption<T>,
): PropertyDecorator {
  return (target, propertyKey) => {
    const cls = target.constructor;

    if (option?.joinColumn) {
      logger.warn(
        `@OneToOne '${propertyKey.toString()}' on ${cls.name}: 'joinColumn' option is deprecated. Use @RelationColumn({ name: "${option.joinColumn}" }) instead.`,
      );
    }

    const scanner = getScannerInstance(OneToOneScanner);

    const metadata = <OneToOneMetadata<T>>{
      target: cls,
      propertyKey: propertyKey.toString(),
      getRelatedEntity,
      joinColumn: option?.joinColumn,
      inverseSide: option?.inverseSide,
      option,
    };

    const existing = Reflect.getMetadata(ONE_TO_ONE_TOKEN, cls);

    Reflect.defineMetadata(
      ONE_TO_ONE_TOKEN,
      [...(existing || []), metadata],
      cls,
    );

    const uniqueKey = scanner.createUniqueKey();
    scanner.setOnPublic<OneToOneMetadata<T>>(uniqueKey, metadata);
  };
}
