import { ClazzType, ReflectManager, Logger } from "../utils";
import { getScannerInstance } from "../scanner/ScannerContainer";
import { ManyToOneScanner } from "../scanner";
import { CascadeOption } from "../types/CascadeType";
import { ReferentialAction } from "../types/ReferentialAction";

/* eslint-disable @typescript-eslint/no-explicit-any */
export const MANY_TO_ONE_TOKEN = Symbol.for("STG_MANY_TO_ONE");

const logger = new Logger("ManyToOne");

export type EntityLike<T = any> = ClazzType<T>;
export type RetrieveEntity<T> = () => T;
export type SetRelatedEntity<T extends EntityLike> = (
  entity: InstanceType<T>,
) => void;

export type ManyToOneOption = {
  /**
   * Function that converts the column value when reading from the database into the entity.
   */
  transform?: <T = any>(raw: unknown) => T;
  /**
   * FK column name.
   * @deprecated Use the `@RelationColumn({ name: "..." })` decorator instead.
   */
  joinColumn?: string;
  /**
   * Column name on the referenced entity.
   * Defaults to the target entity's primary key when omitted.
   */
  references?: string;
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
   * When true, the related entity is loaded with a separate query on first access (Proxy-based lazy loading).
   * Cannot be combined with eager; eager takes precedence if both are set.
   */
  lazy?: boolean;
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
   * The column will still be created but without a FOREIGN KEY constraint.
   * @default true
   */
  createForeignKeyConstraints?: boolean;
};

export type ManyToOneMetadata<T> = {
  target: ClazzType<unknown>;
  type: EntityLike;

  columnName: string;

  joinColumn?: string;

  /**
   * Column name on the referenced entity.
   * Defaults to the target entity's PK when omitted.
   */
  references?: string;

  /**
   * Function that returns the related entity class.
   */
  getMappingEntity: RetrieveEntity<T>;

  /**
   * Function that returns the inverse-side property accessor on the related entity.
   */
  getMappingProperty: SetRelatedEntity<EntityLike>;

  option?: ManyToOneOption;
};

/**
 * Declares a ManyToOne relation.
 * Must be placed on the owning side of the relation.
 *
 * @example
 *
 * @ManyToOne(() => User, (entity) => entity.user)
 * user: User;
 */
export function ManyToOne<T extends EntityLike>(
  getMappingEntity: RetrieveEntity<T>,
  getMappingProperty: SetRelatedEntity<T>,
  option?: ManyToOneOption,
): PropertyDecorator {
  return (target, propertyKey) => {
    const cls = target.constructor;

    if (option?.joinColumn) {
      logger.warn(
        `@ManyToOne '${propertyKey.toString()}' on ${cls.name}: 'joinColumn' option is deprecated. Use @RelationColumn({ name: "${option.joinColumn}" }) instead.`,
      );
    }
    const injectParam = ReflectManager.getType<any>(cls, propertyKey);

    const scanner = getScannerInstance(ManyToOneScanner);

    const columnName = propertyKey.toString();
    const metadata = <ManyToOneMetadata<T>>{
      target: cls,
      type: injectParam,
      columnName,
      joinColumn: option?.joinColumn,
      references: option?.references,
      getMappingEntity,
      getMappingProperty,
      option,
    };

    const columns: ManyToOneMetadata<T>[] = Reflect.getMetadata(MANY_TO_ONE_TOKEN, cls) || [];
    const filtered = columns.filter((c) => c.columnName !== metadata.columnName);

    Reflect.defineMetadata(
      MANY_TO_ONE_TOKEN,
      [...filtered, metadata],
      cls,
    );

    const uniqueKey = scanner.createUniqueKey();
    scanner.set<ManyToOneMetadata<T>>(uniqueKey, metadata);
  };
}
