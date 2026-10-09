import { closestIdentifier } from "./closestIdentifier";

/**
 * Declarative checks for option objects. A rule inspects one value and
 * records every problem it finds under the value's path (`pool.max`,
 * `entities[2]`), so a single error can list all of them at once.
 *
 * @internal Package-internal — not a public API.
 */
export type OptionRule = (value: unknown, path: string, problems: string[]) => void;

/** Renders a value the way a user would have written it in the options. */
export function showValue(value: unknown): string {
  if (typeof value === "function") return "a function";
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  if (typeof value === "bigint") return `${value}n`;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const isBoolean: OptionRule = (value, path, problems) => {
  if (typeof value !== "boolean") {
    problems.push(`'${path}' must be a boolean, got ${showValue(value)}.`);
  }
};

export const isString: OptionRule = (value, path, problems) => {
  if (typeof value !== "string") {
    problems.push(`'${path}' must be a string, got ${showValue(value)}.`);
  }
};

export const isNonEmptyString: OptionRule = (value, path, problems) => {
  if (typeof value !== "string" || value.length === 0) {
    problems.push(`'${path}' must be a non-empty string, got ${showValue(value)}.`);
  }
};

export const isFunction: OptionRule = (value, path, problems) => {
  if (typeof value !== "function") {
    problems.push(`'${path}' must be a function, got ${showValue(value)}.`);
  }
};

/** A finite number of at least `min`; `integer` also rejects fractions. */
function numberRule(min: 0 | 1, integer: boolean): OptionRule {
  const label = `${min === 0 ? "non-negative" : "positive"} ${integer ? "integer" : "number"}`;
  return (value, path, problems) => {
    const ok =
      typeof value === "number" &&
      Number.isFinite(value) &&
      (integer ? Number.isInteger(value) : true) &&
      (min === 0 ? value >= 0 : value > 0);
    if (!ok) problems.push(`'${path}' must be a ${label}, got ${showValue(value)}.`);
  };
}

export const isPositiveInteger = numberRule(1, true);
export const isNonNegativeInteger = numberRule(0, true);
export const isPositiveNumber = numberRule(1, false);
export const isNonNegativeNumber = numberRule(0, false);

export function isIntegerBetween(min: number, max: number): OptionRule {
  return (value, path, problems) => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      problems.push(`'${path}' must be an integer between ${min} and ${max}, got ${showValue(value)}.`);
    }
  };
}

/** Problem text for a value outside `allowed`, naming the closest string. */
export function notOneOf(path: string, value: unknown, allowed: readonly unknown[]): string {
  const suggestion =
    typeof value === "string"
      ? closestIdentifier(value, allowed.filter((v): v is string => typeof v === "string"))
      : null;
  return (
    `'${path}' must be one of ${allowed.map(showValue).join(", ")}, got ${showValue(value)}.` +
    (suggestion ? ` Did you mean ${showValue(suggestion)}?` : "")
  );
}

export function isOneOf(allowed: readonly unknown[]): OptionRule {
  return (value, path, problems) => {
    if (!allowed.includes(value)) problems.push(notOneOf(path, value, allowed));
  };
}

export function isArrayOf(element: OptionRule, opts: { nonEmpty?: boolean } = {}): OptionRule {
  return (value, path, problems) => {
    if (!Array.isArray(value)) {
      problems.push(`'${path}' must be an array, got ${showValue(value)}.`);
      return;
    }
    if (opts.nonEmpty && value.length === 0) {
      problems.push(`'${path}' must not be empty.`);
    }
    value.forEach((item, i) => element(item, `${path}[${i}]`, problems));
  };
}

/** An object whose every value passes `element` (a `Record<string, T>`). */
export function isRecordOf(element: OptionRule): OptionRule {
  return (value, path, problems) => {
    if (!isPlainObject(value)) {
      problems.push(`'${path}' must be an object, got ${showValue(value)}.`);
      return;
    }
    for (const [key, item] of Object.entries(value)) element(item, `${path}.${key}`, problems);
  };
}

export interface ObjectShape {
  [key: string]: OptionRule;
}

/**
 * Checks each known key that is set (`undefined` counts as unset) and
 * reports a key the shape does not name, with the closest one. Pass a
 * `path` of `""` for the root object.
 */
export function checkObject(
  value: Record<string, unknown>,
  path: string,
  shape: ObjectShape,
  problems: string[],
  opts: { required?: readonly string[]; unknownKeys?: "report" | "skip" } = {},
): void {
  const keyPath = (key: string) => (path ? `${path}.${key}` : key);
  for (const key of opts.required ?? []) {
    if (value[key] === undefined) problems.push(`'${keyPath(key)}' is required.`);
  }
  for (const [key, item] of Object.entries(value)) {
    const rule = shape[key];
    if (!rule) {
      if (opts.unknownKeys === "skip") continue;
      const suggestion = closestIdentifier(key, Object.keys(shape));
      problems.push(
        `'${path}' has no option '${key}'.` + (suggestion ? ` Did you mean '${suggestion}'?` : ""),
      );
      continue;
    }
    if (item !== undefined) rule(item, keyPath(key), problems);
  }
}

/** A nested options object whose keys are all known. */
export function isObjectOf(shape: ObjectShape, opts: { required?: readonly string[] } = {}): OptionRule {
  return (value, path, problems) => {
    if (!isPlainObject(value)) {
      problems.push(`'${path}' must be an object, got ${showValue(value)}.`);
      return;
    }
    checkObject(value, path, shape, problems, opts);
  };
}

/** `true`/`false` or a nested options object — `logging`, `cache`, `ssl`. */
export function isBooleanOr(objectRule: OptionRule): OptionRule {
  return (value, path, problems) => {
    if (typeof value === "boolean") return;
    if (!isPlainObject(value)) {
      problems.push(`'${path}' must be a boolean or an options object, got ${showValue(value)}.`);
      return;
    }
    objectRule(value, path, problems);
  };
}

/**
 * An object that carries every method of `typeName` — an instance of a
 * class implementing the interface, or a literal with the same methods.
 */
export function implementsMethods(typeName: string, methods: readonly string[], hint: string): OptionRule {
  return (value, path, problems) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      problems.push(`'${path}' must be a ${typeName}, got ${showValue(value)}. ${hint}`);
      return;
    }
    const target = value as Record<string, unknown>;
    const missing = methods.filter((m) => typeof target[m] !== "function");
    if (missing.length > 0) {
      problems.push(
        `'${path}' is not a ${typeName}: missing ${missing.map((m) => `${m}()`).join(", ")}. ${hint}`,
      );
    }
  };
}
