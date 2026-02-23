import { Injectable } from '@nestjs/common';

@Injectable()
export class AppService {
  getHello(): string {
    return 'Hello from NestJS Blog API! Visit /posts, /users, /tags, /categories';
  }
}
