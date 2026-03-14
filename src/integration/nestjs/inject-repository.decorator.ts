import { Inject } from "@nestjs/common";
import { makeInjectRepositoryToken } from "./stingerloom-orm.module";
import type { ClazzType } from "../../utils/types";

export const InjectRepository = (
  entity: ClazzType<unknown>,
  connectionName = "default",
): ParameterDecorator => {
  return Inject(makeInjectRepositoryToken(entity, connectionName));
};
