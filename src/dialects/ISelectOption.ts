/**
 * The columns a read selects: a list of property names, or an object keyed
 * by property whose `true` entries are selected.
 *
 * It names the entity's own columns. Relations are loaded with `relations`,
 * and a relation's columns are picked by the `select` of its entry there:
 * `relations: { author: { select: ["id", "name"] } }`.
 */
export type ISelectOption<T> =
  | ReadonlyArray<keyof T>
  | {
      [K in keyof T]?: boolean;
    };
