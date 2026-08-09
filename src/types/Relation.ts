/**
 * Wrapper type for single-valued relation properties on decorator entities.
 *
 * `Relation<User>` is just `User` at the type level, but because the outer
 * reference resolves to a type alias with no runtime value,
 * `emitDecoratorMetadata` serializes the property's `design:type` as `Object`
 * instead of the entity class. Without the wrapper, two entities that
 * reference each other compile into modules whose class-definition code reads
 * the other module's class binding eagerly — under ESM (live bindings) that
 * throws `ReferenceError: Cannot access 'X' before initialization` the moment
 * the circular pair is imported. CJS tolerates it only by yielding
 * `undefined`.
 *
 * The ORM never reads `design:type` for relation properties (relations are
 * resolved through the decorator's lazy `() => Entity` thunk), so nothing is
 * lost.
 *
 * Only single-valued relations (`@ManyToOne`, `@OneToOne`) need this —
 * collection properties (`Post[]`) already serialize as `Array`.
 *
 * @example
 * ```ts
 * @Entity()
 * class Post {
 *   @ManyToOne(() => User, (user) => user.posts)
 *   author!: Relation<User>;
 * }
 * ```
 */
export type Relation<T> = T;
