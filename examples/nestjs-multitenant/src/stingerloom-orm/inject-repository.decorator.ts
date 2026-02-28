import { Inject } from "@nestjs/common";
import { makeInjectRepositoryToken } from "./stingerloom-orm.module";
import { ClazzType } from "@stingerloom/orm";

export const InjectRepository = (
  entity: ClazzType<unknown>,
): ParameterDecorator => {
  return Inject(makeInjectRepositoryToken(entity));
};
