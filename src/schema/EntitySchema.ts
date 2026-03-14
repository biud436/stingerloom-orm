/* eslint-disable @typescript-eslint/no-explicit-any */
import { EntitySchemaOptions } from "./EntitySchemaTypes";
import { EntitySchemaRegistrar } from "./EntitySchemaRegistrar";

/**
 * Decorator-free entity definition.
 *
 * Registers the given class as an ORM entity using plain objects
 * instead of decorators. The metadata is stored in the same locations
 * as `@Entity`, `@Column`, `@ManyToOne`, etc., so the rest of the ORM
 * (EntityManager, SchemaGenerator, RelationMetadataResolver) works
 * transparently.
 *
 * @example
 * ```ts
 * class User {
 *   id!: number;
 *   name!: string;
 *   email!: string;
 * }
 *
 * const UserSchema = new EntitySchema<User>({
 *   target: User,
 *   tableName: 'users',
 *   columns: {
 *     id:   { type: 'int', primary: true, autoIncrement: true },
 *     name: { type: 'varchar' },
 *     email: { type: 'varchar', nullable: true, index: true },
 *   },
 * });
 * ```
 *
 * Both decorator-based and EntitySchema-based entities can coexist
 * in the same project.
 */
export class EntitySchema<T> {
  public readonly options: EntitySchemaOptions<T>;

  constructor(options: EntitySchemaOptions<T>) {
    this.options = options;

    // Registration order matters:
    // Column → Relation → Special → Index → Hook → Validation → Entity (last)
    // Entity decorator collects ColumnScanner snapshots, so columns must be registered first.
    EntitySchemaRegistrar.registerColumns(options);
    EntitySchemaRegistrar.registerRelations(options);
    EntitySchemaRegistrar.registerSpecialTokens(options);
    EntitySchemaRegistrar.registerIndexes(options);
    EntitySchemaRegistrar.registerHooks(options);
    EntitySchemaRegistrar.registerValidation(options);
    EntitySchemaRegistrar.registerEntity(options);
  }
}
