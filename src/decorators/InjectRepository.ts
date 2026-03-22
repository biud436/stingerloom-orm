import { ClazzType } from "../utils/types";

/**
 * A WeakMap-based registry that maps each entity class to a unique Symbol token.
 * Using WeakMap ensures tokens are unique per class reference (not by name),
 * preventing collisions when two different entity classes share the same name.
 */
const repositoryTokenMap = new WeakMap<Function, symbol>();

/**
 * Returns a unique Symbol token for the given entity class.
 * The token is lazily created and cached in a WeakMap keyed by class reference.
 *
 * @param entityClass The entity class constructor
 * @returns A unique Symbol token for the entity's repository
 */
export function getRepositoryToken(entityClass: ClazzType<unknown>): symbol {
  let token = repositoryTokenMap.get(entityClass);
  if (!token) {
    token = Symbol(`Repository_${entityClass.name}`);
    repositoryTokenMap.set(entityClass, token);
  }
  return token;
}

/**
 * @deprecated This core decorator stores metadata that no runtime reads.
 * Use `InjectRepository` from `stingerloom-orm/nestjs` instead for NestJS projects.
 *
 * @example
 * ```ts
 * import { InjectRepository } from "stingerloom-orm/nestjs";
 * ```
 */
export function InjectRepository(
  entityClass: ClazzType<unknown>,
): ParameterDecorator {
  const token = getRepositoryToken(entityClass);
  return (
    target: Object,
    propertyKey: string | symbol | undefined,
    parameterIndex: number,
  ) => {
    const existingTokens: Record<number, symbol> =
      Reflect.getOwnMetadata("custom:inject_tokens", target) || {};
    existingTokens[parameterIndex] = token;
    Reflect.defineMetadata("custom:inject_tokens", existingTokens, target);
  };
}
