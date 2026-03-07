import "reflect-metadata";
import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication, ValidationPipe } from "@nestjs/common";
import request from "supertest";
import { AppModule } from "../src/app.module";

describe("Todos (e2e) - npm @stingerloom/orm verification", () => {
  let app: INestApplication;
  let createdId: number;

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

  it("POST /todos - create a todo", async () => {
    const res = await request(app.getHttpServer())
      .post("/todos")
      .send({ title: "Buy milk", description: "From the store" })
      .expect(201);

    expect(res.body).toHaveProperty("id");
    expect(res.body.title).toBe("Buy milk");
    // MySQL TINYINT returns 0/1 instead of true/false
    expect(res.body.completed).toBeFalsy();
    createdId = res.body.id;
  });

  it("GET /todos - list all todos", async () => {
    const res = await request(app.getHttpServer())
      .get("/todos")
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(1);
  });

  it("GET /todos/:id - get single todo", async () => {
    const res = await request(app.getHttpServer())
      .get(`/todos/${createdId}`)
      .expect(200);

    expect(res.body.id).toBe(createdId);
    expect(res.body.title).toBe("Buy milk");
  });

  it("PATCH /todos/:id - update a todo", async () => {
    await request(app.getHttpServer())
      .patch(`/todos/${createdId}`)
      .send({ completed: true, title: "Buy milk (done)" })
      .expect(200);

    const res = await request(app.getHttpServer())
      .get(`/todos/${createdId}`)
      .expect(200);

    expect(res.body.title).toBe("Buy milk (done)");
    expect(res.body.completed).toBeTruthy();
  });

  it("DELETE /todos/:id - soft delete a todo", async () => {
    await request(app.getHttpServer())
      .delete(`/todos/${createdId}`)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/todos/${createdId}`)
      .expect(404);
  });

  it("GET /todos/:id - 404 for non-existent", async () => {
    await request(app.getHttpServer())
      .get("/todos/999999")
      .expect(404);
  });
});
