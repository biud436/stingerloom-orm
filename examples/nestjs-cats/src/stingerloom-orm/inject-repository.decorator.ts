import { Inject } from "@nestjs/common";
import { INJECT_REPOSITORIES_TOKEN } from "./stingerloom-orm.module";
import { ClazzType } from "stingerloom-orm";

export const InjectRepository = (entity: ClazzType<unknown>): ParameterDecorator => {
  return Inject(INJECT_REPOSITORIES_TOKEN + entity.name);
};
