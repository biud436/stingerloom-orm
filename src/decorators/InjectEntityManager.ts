export const ENTITY_METADATA_TOKEN = Symbol.for("STG_InjectEntityManager");

/**
 * @deprecated This core decorator stores metadata that no runtime path consumes.
 * Use the NestJS integration decorator instead:
 * `import { InjectEntityManager } from "@stingerloom/orm/nestjs";`
 */
export function InjectEntityManager(): ParameterDecorator {
  return (target, _projectKey, index) => {
    const params = Reflect.getMetadata("design:paramtypes", target) || [];
    const injectParam = params[index];

    Reflect.defineMetadata(ENTITY_METADATA_TOKEN, injectParam, target);
  };
}
