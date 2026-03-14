import "reflect-metadata";
import { ENTITY_TOKEN } from "../../../../src/decorators/Entity";

export class Post {
  id!: number;
  title!: string;
}

// Simulate @Entity() decorator
Reflect.defineMetadata(ENTITY_TOKEN, { target: Post, name: "post" }, Post);
