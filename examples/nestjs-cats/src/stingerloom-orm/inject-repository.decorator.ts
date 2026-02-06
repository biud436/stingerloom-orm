import { Inject } from "@nestjs/common";
import {
  INJECT_REPOSITORIES_TOKEN,
  makeInjectRepositoryToken,
} from "./stingerloom-orm.module";
import { ClazzType } from "stingerloom-orm";

export const InjectRepository = (
  entity: ClazzType<unknown>,
): ParameterDecorator => {
  return Inject(makeInjectRepositoryToken(entity));
};
