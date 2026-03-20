import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';

describe('Todos (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  let createdId: number;

  it('POST /todos - create a todo', () => {
    return request(app.getHttpServer())
      .post('/todos')
      .send({ title: 'Test Todo', description: 'e2e test' })
      .expect(201)
      .expect((res) => {
        expect(res.body.title).toBe('Test Todo');
        expect(res.body.completed).toBe(false);
        createdId = res.body.id;
      });
  });

  it('GET /todos - list todos', () => {
    return request(app.getHttpServer())
      .get('/todos')
      .expect(200)
      .expect((res) => {
        expect(Array.isArray(res.body)).toBe(true);
      });
  });

  it('GET /todos/:id - get single todo', () => {
    return request(app.getHttpServer())
      .get(`/todos/${createdId}`)
      .expect(200)
      .expect((res) => {
        expect(res.body.title).toBe('Test Todo');
      });
  });

  it('PATCH /todos/:id - update todo', () => {
    return request(app.getHttpServer())
      .patch(`/todos/${createdId}`)
      .send({ completed: true })
      .expect(200)
      .expect((res) => {
        expect(res.body.completed).toBe(true);
      });
  });

  it('DELETE /todos/:id - soft delete todo', () => {
    return request(app.getHttpServer())
      .delete(`/todos/${createdId}`)
      .expect(200);
  });

  it('GET /todos/:id - should 404 after soft delete', () => {
    return request(app.getHttpServer())
      .get(`/todos/${createdId}`)
      .expect(404);
  });
});
