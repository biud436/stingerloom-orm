/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";

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
 * INSERT 전에 호출됩니다 (PK가 없는 신규 엔티티 저장 시).
 */
export function BeforeInsert(): MethodDecorator {
  return createHookDecorator("beforeInsert");
}

/**
 * INSERT 후에 호출됩니다.
 */
export function AfterInsert(): MethodDecorator {
  return createHookDecorator("afterInsert");
}

/**
 * UPDATE 전에 호출됩니다 (PK가 있는 기존 엔티티 저장 시).
 */
export function BeforeUpdate(): MethodDecorator {
  return createHookDecorator("beforeUpdate");
}

/**
 * UPDATE 후에 호출됩니다.
 */
export function AfterUpdate(): MethodDecorator {
  return createHookDecorator("afterUpdate");
}

/**
 * DELETE 전에 호출됩니다.
 */
export function BeforeDelete(): MethodDecorator {
  return createHookDecorator("beforeDelete");
}

/**
 * DELETE 후에 호출됩니다.
 */
export function AfterDelete(): MethodDecorator {
  return createHookDecorator("afterDelete");
}
