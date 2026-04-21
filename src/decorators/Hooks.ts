/* eslint-disable @typescript-eslint/no-explicit-any */

export type HookEvent =
  | "beforeInsert"
  | "afterInsert"
  | "beforeUpdate"
  | "afterUpdate"
  | "beforeDelete"
  | "afterDelete";

export interface HookMetadata {
  methodName: string;
  event: HookEvent;
}

export const HOOK_TOKEN = Symbol.for("STG_HOOKS");

function createHookDecorator(event: HookEvent): MethodDecorator {
  return (target, propertyKey) => {
    const hooks: HookMetadata[] =
      Reflect.getMetadata(HOOK_TOKEN, target.constructor) || [];

    Reflect.defineMetadata(
      HOOK_TOKEN,
      [...hooks, { methodName: propertyKey.toString(), event }],
      target.constructor,
    );
  };
}

/**
 * Invoked before INSERT (when persisting a new entity without a PK).
 */
export function BeforeInsert(): MethodDecorator {
  return createHookDecorator("beforeInsert");
}

/**
 * Invoked after INSERT.
 */
export function AfterInsert(): MethodDecorator {
  return createHookDecorator("afterInsert");
}

/**
 * Invoked before UPDATE (when persisting an existing entity that has a PK).
 */
export function BeforeUpdate(): MethodDecorator {
  return createHookDecorator("beforeUpdate");
}

/**
 * Invoked after UPDATE.
 */
export function AfterUpdate(): MethodDecorator {
  return createHookDecorator("afterUpdate");
}

/**
 * Invoked before DELETE.
 */
export function BeforeDelete(): MethodDecorator {
  return createHookDecorator("beforeDelete");
}

/**
 * Invoked after DELETE.
 */
export function AfterDelete(): MethodDecorator {
  return createHookDecorator("afterDelete");
}
