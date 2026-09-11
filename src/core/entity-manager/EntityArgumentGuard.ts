/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Entity-argument guard for the EntityManager's root entry points.
 *
 * Every public method takes the entity *class* first (`em.find(User, …)`).
 * The common slips — an instance (`em.find(new User())`), a class that was
 * never decorated, `undefined` from a circular import, a thunk or an uncalled
 * factory, a table name string — used to fall through to metadata resolution,
 * which reported `Entity metadata for "undefined" does not exist` (or a bare
 * `TypeError` from `Reflect.getMetadata`) without naming the actual mistake.
 *
 * This module classifies the argument and turns each shape into a message
 * that says what was received and what to pass instead, plus the entity
 * classes the connection knows and a closest-match suggestion where a name
 * is available. The error class and code stay `EntityMetadataNotFoundError`
 * / `ORM_ENTITY_METADATA_NOT_FOUND`, so existing `catch` contracts hold.
 */
import { ENTITY_TOKEN } from "../../decorators/Entity";
import { EntityMetadataNotFoundError } from "../../errors/EntityMetadataNotFoundError";
import { EntityScanner } from "../../scanner/EntityScanner";
import { getScannerInstance } from "../../scanner/ScannerContainer";
import { closestIdentifier } from "../../utils/closestIdentifier";
import { ClazzType } from "../../utils/types";

/** What the first argument of a root entry point turned out to be. */
export type EntityArgumentKind =
  /** A class that carries entity metadata — the only accepted shape. */
  | "entity"
  /** `undefined` or `null`. */
  | "nullish"
  /** string, number, boolean, symbol or bigint. */
  | "primitive"
  /** An object created by a class constructor (`new User()`). */
  | "instance"
  /** An object literal, an array or a prototype-less object. */
  | "plain-object"
  /** A function without a `prototype` — arrow function, method, bound function. */
  | "non-constructor"
  /** A class or `function` with a prototype but no entity metadata. */
  | "unregistered-class";

export interface EntityArgumentClassification {
  kind: EntityArgumentKind;
  /**
   * Best-effort display name: the class name, the instance's constructor
   * name, the function name, or the primitive rendered as text. Empty for
   * anonymous classes and functions.
   */
  name: string;
}

/** Message and suggestion for one misuse, consumed by `EntityMetadataNotFoundError`. */
export interface EntityArgumentDiagnosis {
  kind: Exclude<EntityArgumentKind, "entity">;
  name: string;
  message: string;
  suggestion: string;
}

/** Answers "does this class carry entity metadata?" for a candidate constructor. */
export type EntityMetadataProbe = (target: Function) => boolean;

export interface EntityArgumentGuardOptions {
  /** Connection the EntityManager is bound to; named in the registered-entity list. */
  connectionName?: string;
  /**
   * Entity class names the EntityManager serves (scoped) or knows (unscoped).
   * A thunk so the list is only built when the argument is rejected.
   */
  registeredEntities?: () => readonly string[];
  /**
   * Authoritative fallback consulted when {@link hasEntityMetadata} finds
   * nothing on the constructor — the EntityManager passes its metadata
   * resolver, so whatever resolves downstream is accepted here too.
   */
  hasMetadata?: EntityMetadataProbe;
}

/**
 * True when `target` carries entity metadata from `@Entity()`, `defineEntity()`
 * or `EntitySchema` on the constructor or an ancestor (so STI/TPT children
 * resolve). Silent and allocation-free: one `Reflect.getMetadata` walk.
 */
export function hasEntityMetadata(target: Function): boolean {
  return Reflect.getMetadata(ENTITY_TOKEN, target) !== undefined;
}

/**
 * Entity class names known to the current metadata context. Scoped
 * EntityManagers pass their `entities` array; unscoped ones fall back to
 * every entity the layered store holds in the active context.
 */
export function listKnownEntityNames(
  scoped: readonly ClazzType<any>[],
): string[] {
  if (scoped.length > 0) {
    return scoped.map((e) => e.name).filter((n): n is string => !!n);
  }
  const scanner = getScannerInstance(EntityScanner);
  if (typeof scanner?.makeEntities !== "function") return [];
  const entries = scanner.makeEntities();
  if (!entries || typeof entries[Symbol.iterator] !== "function") return [];
  const names: string[] = [];
  for (const meta of entries) {
    const name = meta?.target?.name;
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function isEntityClass(value: Function, probe?: EntityMetadataProbe): boolean {
  return hasEntityMetadata(value) || probe?.(value) === true;
}

/** Classifies `value` without throwing. */
export function classifyEntityArgument(
  value: unknown,
  probe?: EntityMetadataProbe,
): EntityArgumentClassification {
  if (value === undefined || value === null) {
    return { kind: "nullish", name: String(value) };
  }
  if (typeof value === "function") {
    if (isEntityClass(value, probe)) return { kind: "entity", name: value.name };
    // Arrow functions, methods and bound functions have no `prototype`, so
    // they can never be a class — a thunk (`() => User`) is the usual case.
    if (!Object.prototype.hasOwnProperty.call(value, "prototype")) {
      return { kind: "non-constructor", name: value.name };
    }
    return { kind: "unregistered-class", name: value.name };
  }
  if (typeof value === "object") {
    const ctor = (value as { constructor?: unknown }).constructor;
    if (
      Array.isArray(value) ||
      typeof ctor !== "function" ||
      ctor === Object
    ) {
      return { kind: "plain-object", name: Array.isArray(value) ? "Array" : "Object" };
    }
    return { kind: "instance", name: ctor.name };
  }
  return { kind: "primitive", name: String(value) };
}

/** `class X {}` syntax versus a plain `function` — decides the wording only. */
function isClassSyntax(fn: Function): boolean {
  try {
    return /^class[\s{]/.test(Function.prototype.toString.call(fn));
  } catch {
    return false;
  }
}

function describePrimitive(value: unknown): string {
  switch (typeof value) {
    case "string":
      return `the string "${value}"`;
    case "number":
      return `the number ${value}`;
    case "boolean":
      return `the boolean ${value}`;
    case "bigint":
      return `the bigint ${value}n`;
    case "symbol":
      return "a symbol";
    default:
      return `a ${typeof value}`;
  }
}

function didYouMean(name: string, registered: readonly string[]): string {
  if (!name) return "";
  const match = closestIdentifier(name, registered);
  return match && match !== name ? ` Did you mean "${match}"?` : "";
}

/**
 * Builds the message/suggestion pair for a rejected argument. Returns null
 * when `value` is an entity class.
 */
export function diagnoseEntityArgument(
  value: unknown,
  method: string,
  registeredEntities: readonly string[] | (() => readonly string[]) = [],
  probe?: EntityMetadataProbe,
): EntityArgumentDiagnosis | null {
  // Classify exactly once: the probe may be a test double whose answer
  // changes between calls, and a second look must not overturn the first.
  const { kind, name } = classifyEntityArgument(value, probe);
  if (kind === "entity") return null;

  const registered =
    typeof registeredEntities === "function"
      ? registeredEntities()
      : registeredEntities;
  const call = `em.${method}(User, ...)`;

  switch (kind) {

    case "nullish":
      return {
        kind,
        name,
        message: `${method}() received ${name} where an entity class was expected.`,
        suggestion:
          `Pass the entity class as the first argument, e.g. ${call}. ` +
          `A class that is undefined at call time usually comes from a circular import or a missing export — ` +
          `make sure the module that defines the entity has finished loading before this call.`,
      };

    case "primitive":
      return {
        kind,
        name,
        message: `${method}() received ${describePrimitive(value)} where an entity class was expected.`,
        suggestion:
          `Entities are referenced by class, not by name — import the class and pass it, e.g. ${call}.` +
          (typeof value === "string" ? didYouMean(value, registered) : ""),
      };

    case "plain-object":
      return {
        kind,
        name,
        message:
          `${method}() received ${name === "Array" ? "an array" : "a plain object"} ` +
          `where an entity class was expected.`,
        suggestion:
          `Pass the entity class as the first argument, e.g. ${call}; ` +
          `the object belongs in the payload or criteria argument.`,
      };

    case "instance": {
      const ctor = (value as { constructor: Function }).constructor;
      const display = name || "an anonymous class";
      const ctorIsEntity = isEntityClass(ctor, probe);
      return {
        kind,
        name,
        message: `${method}() received an instance of ${display} where the entity class was expected.`,
        suggestion: ctorIsEntity
          ? `Pass the class itself as the first argument: em.${method}(${display}, ...). ` +
            `An instance is persisted with em.save(${display}, instance).`
          : `Pass the class itself as the first argument: em.${method}(${display}, ...). ` +
            `${display} carries no entity metadata either: decorate it with @Entity() or define it with defineEntity().` +
            didYouMean(name, registered),
      };
    }

    case "non-constructor":
      return {
        kind,
        name,
        message:
          `${method}() received ${name ? `the function "${name}"` : "an anonymous function"} ` +
          `which is not a class.`,
        suggestion:
          `If it is a thunk such as () => User, pass the class it returns. ` +
          `If it is a factory, call it — did you forget the parentheses? — and pass the class it returns.` +
          didYouMean(name, registered),
      };

    case "unregistered-class": {
      const fn = value as Function;
      const display = name || "<anonymous>";
      const classLike = isClassSyntax(fn);
      const suggestion =
        name === "defineEntity"
          ? `defineEntity is the factory itself — call it at module load, ` +
            `const User = defineEntity("users", { ... }), and pass the class it returns.`
          : classLike
            ? `Decorate ${display} with @Entity() — and make sure its module is imported before the EntityManager connects — ` +
              `or define it with defineEntity(). If ${display} is meant to be a defineEntity() entity, pass the class that call returned.`
            : `If ${display} is a factory, call it — did you forget the parentheses? — and pass the class it returns; ` +
              `if it is a class, decorate it with @Entity() or define it with defineEntity().`;
      return {
        kind,
        name,
        // The leading sentence is a long-standing contract; keep it verbatim.
        message:
          `Entity metadata for "${display}" does not exist. ` +
          `${method}() received the ${classLike ? "class" : "function"} ${display}, ` +
          `which is not decorated with @Entity() and was not created by defineEntity() or EntitySchema.`,
        suggestion: suggestion + didYouMean(name, registered),
      };
    }
  }
}

/**
 * Throws `EntityMetadataNotFoundError` unless `value` is an entity class.
 * Cheap on the accepted path: one `Reflect.getMetadata` per call — callers
 * that sit on a hot path cache approvals per class (see
 * `EntityManager.assertEntityInScope`).
 */
export function assertEntityClassArgument(
  value: unknown,
  method: string,
  options: EntityArgumentGuardOptions = {},
): asserts value is ClazzType<any> {
  let registered: readonly string[] = [];
  const diagnosis = diagnoseEntityArgument(
    value,
    method,
    () => (registered = options.registeredEntities?.() ?? []),
    options.hasMetadata,
  );
  if (!diagnosis) return;

  throw new EntityMetadataNotFoundError(diagnosis.name, {
    connectionName: options.connectionName,
    registeredEntities: registered,
    argument: diagnosis,
  });
}
