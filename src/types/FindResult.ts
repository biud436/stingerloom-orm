import type { FindOption } from "../dialects/FindOption";

/**
 * The type of each entity a read returns, narrowed by the options that
 * change its shape: a `select` S, a `relations` R and a `withCount` W.
 *
 * - With a `select`, the result keeps the selected properties, the relations
 *   `relations` loads, the properties `withCount` writes and the entity's
 *   methods (the row is still an instance of its class). A `select` that
 *   names every property returns the entity type itself.
 * - A `relations` object with a `select` in an entry, at any depth, narrows
 *   that relation's entities the same way.
 * - Anything else returns the entity type: a read without `select`, a
 *   `relations` list, a `relations` object without `select`, and options
 *   typed as a plain `FindOption<T>`.
 *
 * Columns the read adds on its own (the primary key a relation is matched
 * by, the join column of a nested to-one relation) are on the object at
 * runtime but not in the narrowed type.
 *
 * @template T - The entity.
 * @template S - The read's `select`.
 * @template R - The read's `relations`.
 * @template W - The read's `withCount`.
 *
 * @example
 * ```ts
 * const users = await em.find(User, { select: ["id", "name"] });
 * //    ^? Pick<User, "id" | "name">[]
 *
 * const posts = await em.find(Post, { relations: { author: { select: ["name"] } } });
 * posts[0].author?.name;   // string
 * posts[0].author?.email;  // compile error: not selected
 * ```
 */
export type FindResult<T, S = undefined, R = undefined, W = undefined> =
  IsAny<T> extends true
    ? T
    : [S] extends [object]
      ? [keyof T] extends [SelectedKeys<T, S>]
        ? WithRelations<T, R>
        : Pick<
            T,
            | SelectedKeys<T, S>
            | MethodKeys<T>
            | (R extends ReadonlyArray<unknown> ? LoadedRelationKeys<T, R> : never)
            | (keyof W & keyof T)
          > &
            ([R] extends [object]
              ? R extends ReadonlyArray<unknown>
                ? unknown
                : LoadedRelations<T, R>
              : unknown)
      : WithRelations<T, R>;

/**
 * The options of a read that sets `select`: what the read methods take to
 * narrow their result to {@link FindResult}.
 */
export type SelectFindOption<T, S, R = undefined, W = undefined> = FindOption<T> & {
  select: S;
  relations?: R;
  withCount?: W;
};

/**
 * The options of a read that loads relations in the object form, which
 * narrows a relation whose entry sets `select` (see {@link FindResult}).
 */
export type RelationsFindOption<T, R> = FindOption<T> & { relations: R };

type IsAny<T> = 0 extends 1 & T ? true : false;

/** Properties of `T` that hold a method — kept by a narrowed result. */
type MethodKeys<T> = {
  [K in keyof T]-?: T[K] extends (...args: never[]) => unknown ? K : never;
}[keyof T];

/** The properties a `select` reads: the listed ones, or the object form's keys not set to false. */
type SelectedKeys<T, S> =
  S extends ReadonlyArray<infer K>
    ? K & keyof T
    : { [K in keyof S]-?: S[K] extends false | undefined ? never : K }[keyof S] & keyof T;

/** The relation a `relations` entry loads on the entity itself: a dotted path's first segment. */
type PathHead<P> = P extends `${infer Head}.${string}` ? Head : P;

/** The relation properties a `relations` option loads. */
type LoadedRelationKeys<T, R> =
  R extends ReadonlyArray<infer P>
    ? PathHead<P & string> & keyof T
    : { [K in keyof R]-?: R[K] extends false | undefined ? never : K }[keyof R] & keyof T;

/** Whether a `relations` object sets a `select` in an entry, at any depth. */
type SelectsRelationColumns<R> =
  R extends ReadonlyArray<unknown>
    ? false
    : true extends {
          [K in keyof R]-?: NonNullable<R[K]> extends { select: unknown }
            ? true
            : NonNullable<R[K]> extends { relations: infer N }
              ? SelectsRelationColumns<N>
              : false;
        }[keyof R]
      ? true
      : false;

/**
 * What a relation property of type `V` holds when its entry is `O`. A lazy
 * (Promise-typed) relation keeps its declared type.
 */
type LoadedRelation<V, O> =
  NonNullable<O> extends { select?: infer S; relations?: infer N }
    ? NonNullable<V> extends Promise<unknown>
      ? V
      : NonNullable<V> extends ReadonlyArray<infer E>
        ? FindResult<NonNullable<E>, S, N>[]
        : FindResult<NonNullable<V>, S, N> | Extract<V, null | undefined>
    : V;

type LoadedRelations<T, R> = {
  [K in LoadedRelationKeys<T, R>]: LoadedRelation<T[K], R[K & keyof R]>;
};

type WithRelations<T, R> = [R] extends [object]
  ? R extends ReadonlyArray<unknown>
    ? T
    : SelectsRelationColumns<R> extends true
      ? Omit<T, LoadedRelationKeys<T, R>> & LoadedRelations<T, R>
      : T
  : T;
