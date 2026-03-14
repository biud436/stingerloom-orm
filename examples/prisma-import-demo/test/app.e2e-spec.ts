import "reflect-metadata";
import { Test, TestingModule } from "@nestjs/testing";
import { INestApplication } from "@nestjs/common";
import * as request from "supertest";
import { AppModule } from "../src/app.module";

const skipReason = !process.env.INTEGRATION_TEST
  ? "INTEGRATION_TEST not set"
  : undefined;

const describeIf = skipReason ? describe.skip : describe;

const wait = (ms = 200) => new Promise((r) => setTimeout(r, ms));

describeIf("[E2E] prisma-import-demo API", () => {
  let app: INestApplication;
  let server: any;

  let customerId: number;
  let productId: number;
  let orderId: number;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();
    await wait(3000);
    server = app.getHttpServer();
  }, 30000);

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  }, 30000);

  // ===========================
  // App Root
  // ===========================
  describe("App Root", () => {
    it("GET / — should return hello message", async () => {
      const res = await request(server).get("/");
      expect(res.status).toBe(200);
      expect(typeof res.text).toBe("string");
    });
  });

  // ===========================
  // Customers CRUD
  // ===========================
  describe("Customers", () => {
    it("POST /customers — create a customer", async () => {
      const res = await request(server)
        .post("/customers")
        .send({ email: "alice@example.com", name: "Alice" });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id");
      expect(res.body.email).toBe("alice@example.com");
      customerId = res.body.id;
    });

    it("GET /customers — list customers", async () => {
      await wait();
      const res = await request(server).get("/customers");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBeGreaterThanOrEqual(1);
    });

    it("GET /customers/:id — get customer with orders", async () => {
      await wait();
      const res = await request(server).get(`/customers/${customerId}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(customerId);
      expect(res.body.name).toBe("Alice");
    });

    it("GET /customers/999 — not found", async () => {
      const res = await request(server).get("/customers/999");
      expect(res.status).toBe(404);
    });
  });

  // ===========================
  // Products CRUD
  // ===========================
  describe("Products", () => {
    it("POST /products — create a product", async () => {
      const res = await request(server).post("/products").send({
        name: "Wireless Mouse",
        price: 29.99,
        description: "Ergonomic wireless mouse",
        stock: 50,
        category: "ELECTRONICS",
      });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id");
      expect(res.body.name).toBe("Wireless Mouse");
      productId = res.body.id;
    });

    it("GET /products — list products", async () => {
      await wait();
      const res = await request(server).get("/products");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("GET /products/:id — get product", async () => {
      await wait();
      const res = await request(server).get(`/products/${productId}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(productId);
    });
  });

  // ===========================
  // Orders CRUD
  // ===========================
  describe("Orders", () => {
    it("POST /orders — create an order with items", async () => {
      await wait();
      const res = await request(server)
        .post("/orders")
        .send({
          customerId,
          items: [{ productId, quantity: 2, unitPrice: 29.99 }],
        });
      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty("id");
      expect(res.body.status).toBe("PENDING");
      orderId = res.body.id;
    });

    it("GET /orders — list orders", async () => {
      await wait();
      const res = await request(server).get("/orders");
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it("GET /orders/:id — get order with customer & items", async () => {
      await wait();
      const res = await request(server).get(`/orders/${orderId}`);
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(orderId);
    });

    it("DELETE /orders/:id — delete an order", async () => {
      await wait();
      const res = await request(server).delete(`/orders/${orderId}`);
      expect(res.status).toBe(200);
    });
  });

  // ===========================
  // Cleanup (order matters: order → product → customer due to FK)
  // ===========================
  describe("Cleanup", () => {
    it("DELETE /products/:id", async () => {
      await wait();
      const res = await request(server).delete(`/products/${productId}`);
      expect(res.status).toBe(200);
    });

    it("DELETE /customers/:id", async () => {
      await wait();
      const res = await request(server).delete(`/customers/${customerId}`);
      expect(res.status).toBe(200);
    });
  });
});
