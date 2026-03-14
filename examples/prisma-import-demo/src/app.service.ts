import { Injectable } from "@nestjs/common";

@Injectable()
export class AppService {
  getHello(): string {
    return "E-commerce API powered by Stingerloom ORM (Prisma schema import)";
  }
}
