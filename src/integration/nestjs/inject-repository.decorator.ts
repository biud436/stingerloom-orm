import { Inject } from "@nestjs/common";
import { makeInjectRepositoryToken } from "./stingerloom-orm.module";
import type { ClazzType } from "../../utils/types";

export const InjectRepository = (
  entity: ClazzType<unknown>,
): ParameterDecorator => {
  return Inject(makeInjectRepositoryToken(entity));
};
