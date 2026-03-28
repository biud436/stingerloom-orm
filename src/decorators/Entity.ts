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

    // target 기반 필터링: 이 클래스 및 부모 클래스의 메타데이터를 수집 (상속 지원)
    // @Column의 target은 prototype, @ManyToOne/@OneToMany/@OneToOne/@ManyToMany의 target은 constructor
    const proto = target.prototype;

    // 프로토타입 체인을 순회하여 부모 클래스의 메타데이터도 포함
    const protoChain: object[] = [];
    let current = proto;
    while (current && current !== Object.prototype) {
      protoChain.push(current);
      current = Object.getPrototypeOf(current);
    }

    const constructorChain: Function[] = [];
    let ctor: Function = target;
    while (ctor && ctor !== Function.prototype && ctor !== Object) {
      constructorChain.push(ctor);
      ctor = Object.getPrototypeOf(ctor);
    }

    const columns = columnScanner
      .allMetadata<ColumnMetadata>()
      .filter((c) => protoChain.includes(c.target as object));
    const manyToOnes = manyToOneScanner
      .allMetadata<ManyToOneMetadata<unknown>>()
      .filter((m) => constructorChain.includes(m.target as Function));
    const oneToManys = oneToManyScanner
      .allMetadata<OneToManyMetadata<unknown>>()
      .filter((m) => constructorChain.includes(m.target as Function));
    const oneToOnes = oneToOneScanner
      .allMetadata<OneToOneMetadata<unknown>>()
      .filter((m) => constructorChain.includes(m.target as Function));
    const manyToManys = manyToManyScanner
      .allMetadata<ManyToManyMetadata<unknown>>()
      .filter((m) => constructorChain.includes(m.target as Function));

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
