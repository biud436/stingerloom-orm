import { Inject } from "@nestjs/common";
import type { ClazzType } from "@stingerloom/orm";
import { makeInjectRepositoryToken } from "./stingerloom-orm.module";

export const InjectRepository = (entity: ClazzType<unknown>) =>
  Inject(makeInjectRepositoryToken(entity));
