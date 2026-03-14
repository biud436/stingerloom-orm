import "reflect-metadata";
import { ENTITY_TOKEN } from "../../../../src/decorators/Entity";

export class User {
  id!: number;
  name!: string;
}

// Simulate @Entity() decorator
Reflect.defineMetadata(ENTITY_TOKEN, { target: User, name: "user" }, User);
