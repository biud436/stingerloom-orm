import { ClazzType } from "../utils";
import { ColumnType } from "./Column";

export const RELATION_COLUMN_TOKEN = Symbol.for("STG_RELATION_COLUMN");

/**
 * Options for the @RelationColumn decorator.
 *
 * Attach to a @ManyToOne / @OneToOne property to declare the FK column's
 * name, type, nullable flag, and so on.
 */
export type RelationColumnOption = {
  /** FK column name. Inferred as `{propertyName}Id` when omitted (logged as warn). */
  name?: string;
  /** FK column type. Inferred from the target PK when omitted; ultimate fallback is "int". */
  type?: ColumnType;
  /** Nullable flag. Defaults to true. */
  nullable?: boolean;
  /** Referenced column on the target table. Defaults to the target PK. */
  referencedColumn?: string;
};

export type RelationColumnMetadata = {
  target: ClazzType<unknown>;
  /** Relation property name (e.g., "author"). */
  propertyKey: string;
  /** Explicit FK column name. */
  name?: string;
  /** FK column type. */
  type?: ColumnType;
  /** Nullable flag. */
  nullable?: boolean;
  /** Referenced column on the target table. */
  referencedColumn?: string;
};

/**
 * @RelationColumn decorator.
 *
 * Attach to a `@ManyToOne` or `@OneToOne` property to declare the FK column
 * metadata.
 *
 * @example
 * ```typescript
 * // Explicit FK column name
 * @ManyToOne(() => User, u => u.posts)
 * @RelationColumn({ name: "author_id" })
 * author!: User;
 *
 * // Inferred name (logged as warn)
 * @ManyToOne(() => User, u => u.posts)
 * @RelationColumn()
 * author!: User;
 *
 * // Combined with @Column — o.userId remains directly accessible
 * @Column({ type: "int", name: "user_id" })
 * userId!: number;
 *
 * @ManyToOne(() => User, u => u.posts)
 * @RelationColumn({ name: "user_id" })
 * author!: User;
 * ```
 */
export function RelationColumn(
  option?: RelationColumnOption,
): PropertyDecorator {
  return (target, propertyKey) => {
    const cls = target.constructor as ClazzType<unknown>;
    const metadata: RelationColumnMetadata = {
      target: cls,
      propertyKey: propertyKey.toString(),
      name: option?.name,
      type: option?.type,
      nullable: option?.nullable,
      referencedColumn: option?.referencedColumn,
    };

    const existing: RelationColumnMetadata[] =
      Reflect.getMetadata(RELATION_COLUMN_TOKEN, cls) || [];
    const filtered = existing.filter(
      (m) => m.propertyKey !== metadata.propertyKey,
    );
    Reflect.defineMetadata(
      RELATION_COLUMN_TOKEN,
      [...filtered, metadata],
      cls,
    );
  };
}
