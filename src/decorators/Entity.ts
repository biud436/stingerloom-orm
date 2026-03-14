/* eslint-disable @typescript-eslint/no-explicit-any */
import Container from "typedi";
import { ColumnScanner, EntityScanner, ManyToOneScanner, OneToManyScanner, ManyToManyScanner } from "../scanner";
import { OneToOneScanner } from "../scanner/OneToOneScanner";
import { createEntityKey } from "../utils/scanner";
import { ColumnOption } from "./Column";
import { ClazzType } from "../utils";
import { ManyToOneMetadata } from "./ManyToOne";
import { OneToManyMetadata } from "./OneToMany";
import { OneToOneMetadata } from "./OneToOne";
import { ManyToManyMetadata } from "./ManyToMany";
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
  oneToManys?: OneToManyMetadata<unknown>[];
  oneToOnes?: OneToOneMetadata<unknown>[];
  manyToManys?: ManyToManyMetadata<unknown>[];
  options?: EntityOption;
};

export function Entity(options?: EntityOption): ClassDecorator {
  return function (target) {
    const scanner = Container.get(EntityScanner);
    const columnScanner = Container.get(ColumnScanner);
    const manyToOneScanner = Container.get(ManyToOneScanner);
    const oneToManyScanner = Container.get(OneToManyScanner);
    const oneToOneScanner = Container.get(OneToOneScanner);
    const manyToManyScanner = Container.get(ManyToManyScanner);

    const nameKey = camelToSnakeCase(target.name);
    const name = createEntityKey(nameKey);

    // target 기반 필터링: 이 클래스의 메타데이터만 수집
    // @Column의 target은 prototype, @ManyToOne/@OneToMany/@OneToOne/@ManyToMany의 target은 constructor
    const proto = target.prototype;
    const columns = columnScanner
      .allMetadata<ColumnMetadata>()
      .filter((c) => c.target === proto);
    const manyToOnes = manyToOneScanner
      .allMetadata<ManyToOneMetadata<unknown>>()
      .filter((m) => (m.target as Function) === target);
    const oneToManys = oneToManyScanner
      .allMetadata<OneToManyMetadata<unknown>>()
      .filter((m) => (m.target as Function) === target);
    const oneToOnes = oneToOneScanner
      .allMetadata<OneToOneMetadata<unknown>>()
      .filter((m) => (m.target as Function) === target);
    const manyToManys = manyToManyScanner
      .allMetadata<ManyToManyMetadata<unknown>>()
      .filter((m) => (m.target as Function) === target);

    const metadata = {
      target,
      columns,
      manyToOnes,
      oneToManys,
      oneToOnes,
      manyToManys,
      options,
      name: nameKey,
    };
    scanner.set(name, metadata);

    Reflect.defineMetadata(ENTITY_TOKEN, metadata, target);
  };
}
