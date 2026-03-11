/* eslint-disable @typescript-eslint/no-explicit-any */
import Container from "typedi";
import { ColumnScanner, EntityScanner, ManyToOneScanner } from "../scanner";
import { createEntityKey } from "../utils/scanner";
import { ColumnOption } from "./Column";
import { ClazzType } from "../utils";
import { ManyToOneMetadata } from "./ManyToOne";
import { ColumnMetadata } from "../scanner/ColumnScanner";
import { camelToSnakeCase } from "../utils/camelToSnakeCase";

export interface EntityOption {
  name?: string;
}

export const ENTITY_TOKEN = Symbol.for("STG_ENTITY");

export type EntityMetadata<T = any> = {
  target: ClazzType<T>;
  name: string;
  columns: ColumnOption[];
  manyToOnes?: ManyToOneMetadata<unknown>[];
  options?: EntityOption;
};

export function Entity(options?: EntityOption): ClassDecorator {
  return function (target) {
    const scanner = Container.get(EntityScanner);
    const columnScanner = Container.get(ColumnScanner);
    const manyToOneScanner = Container.get(ManyToOneScanner);

    const nameKey = camelToSnakeCase(target.name);
    const name = createEntityKey(nameKey);

    // target 기반 필터링: 이 클래스의 메타데이터만 수집
    // @Column의 target은 prototype, @ManyToOne의 target은 constructor
    const proto = target.prototype;
    const columns = columnScanner
      .allMetadata<ColumnMetadata>()
      .filter((c) => c.target === proto);
    const manyToOnes = manyToOneScanner
      .allMetadata<ManyToOneMetadata<unknown>>()
      .filter((m) => (m.target as Function) === target);

    const metadata = {
      target,
      columns,
      manyToOnes,
      options,
      name: nameKey,
    };
    scanner.set(name, metadata);

    Reflect.defineMetadata(ENTITY_TOKEN, metadata, target);
  };
}
