import { Inject } from "@nestjs/common";
import { getEntityManagerToken } from "./stingerloom-orm.module";

export const InjectEntityManager = (
  connectionName = "default",
): ParameterDecorator => {
  return Inject(getEntityManagerToken(connectionName));
};
