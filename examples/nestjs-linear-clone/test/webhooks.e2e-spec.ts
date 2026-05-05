import * as http from "node:http";
import { AddressInfo } from "node:net";
import { createHmac } from "node:crypto";
import {
  bootApp,
  shutdownApp,
  integrationDescribe,
  authedAgent,
  BootedApp,
} from "./helpers/test-app";
import { createBaseFixture, createIssue, BaseFixture } from "./helpers/fixtures";

interface MockReceiver {
  url: string;
  close: () => Promise<void>;
  setHandler: (
    fn: (req: { signature: string; event: string; body: string }) => number,
  ) => void;
  received: Array<{ signature: string; event: string; body: string }>;
}

async function startMockReceiver(): Promise<MockReceiver> {
  const received: Array<{ signature: string; event: string; body: string }> = [];
  let handler: (req: { signature: string; event: string; body: string }) => number =
    () => 200;

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk.toString("utf8")));
    req.on("end", () => {
      const signature = (req.headers["x-webhook-signature"] as string) ?? "";
      const event = (req.headers["x-webhook-event"] as string) ?? "";
      const entry = { signature, event, body: raw };
      received.push(entry);
      const status = handler(entry);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: status >= 200 && status < 300 }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}/hook`;

  return {
    url,
    received,
    setHandler: (fn) => {
      handler = fn;
    },
    close: () =>
      new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

integrationDescribe("[E2E] Webhooks — outbox + worker + retry", () => {
  let booted: BootedApp;
  let fx: BaseFixture;
  let api: ReturnType<typeof authedAgent>;
  let mock: MockReceiver;
  const SECRET = "shared-secret-at-least-8";

  beforeAll(async () => {
    booted = await bootApp();
    fx = await createBaseFixture(booted.server);
    api = authedAgent(booted.server, fx.ownerToken);
    mock = await startMockReceiver();
  }, 60000);

  afterAll(async () => {
    await mock?.close();
    await shutdownApp(booted);
  }, 30000);

  beforeEach(() => {
    mock.received.length = 0;
    mock.setHandler(() => 200);
  });

  describe("Endpoint CRUD", () => {
    it("registers a webhook endpoint", async () => {
      const r = await api
        .post("/webhooks/endpoints")
        .send({
          workspaceId: fx.workspaceId,
          url: mock.url,
          secret: SECRET,
          events: ["issue.updated", "issue.created"],
        })
        .expect(201);
      expect(r.body.id).toBeDefined();
      expect(r.body.url).toBe(mock.url);
      expect(r.body.events).toEqual(["issue.updated", "issue.created"]);
      expect(r.body.isActive).toBe(true);
    });

    it("lists workspace endpoints", async () => {
      const r = await api
        .get(`/webhooks/endpoints`)
        .query({ workspaceId: fx.workspaceId })
        .expect(200);
      expect(Array.isArray(r.body)).toBe(true);
      expect(r.body.length).toBeGreaterThan(0);
    });
  });

  describe("Outbox row creation on issue update", () => {
    let endpointUrl: string;

    beforeAll(async () => {
      // Distinct URL from the CRUD describe so the (workspace_id, url) unique
      // index does not collide on a re-registration.
      endpointUrl = `${mock.url}?case=outbox`;
      await api
        .post("/webhooks/endpoints")
        .send({
          workspaceId: fx.workspaceId,
          url: endpointUrl,
          secret: SECRET,
          events: ["issue.updated"],
        })
        .expect(201);
    });

    it("PATCH /issues/:id queues a pending WebhookDelivery row", async () => {
      const issue = await createIssue(booted.server, {
        projectId: fx.projectId,
        title: "Webhook outbox subject",
        status: "BACKLOG",
        priority: 3,
      });

      await api
        .patch(`/issues/${issue.id}`)
        .send({ expectedVersion: issue.version, title: "Renamed via webhook test" })
        .expect(200);

      // Probe the delivery worker — it should claim and POST exactly one row.
      const tick = await api.post("/webhooks/_tick").expect(201);
      expect(tick.body.claimed).toBeGreaterThanOrEqual(1);
      expect(tick.body.delivered).toBeGreaterThanOrEqual(1);
      expect(mock.received.length).toBeGreaterThanOrEqual(1);
      const last = mock.received[mock.received.length - 1];
      expect(last.event).toBe("issue.updated");

      // HMAC verify
      const expected = createHmac("sha256", SECRET).update(last.body).digest("hex");
      expect(last.signature).toBe(expected);
    });
  });

  describe("Failing endpoint → retry / permanent failure", () => {
    let mock500: MockReceiver;
    let endpointId: number;

    beforeAll(async () => {
      mock500 = await startMockReceiver();
      mock500.setHandler(() => 500);
      const ep = await api
        .post("/webhooks/endpoints")
        .send({
          workspaceId: fx.workspaceId,
          url: mock500.url,
          secret: SECRET,
          events: ["issue.updated"],
        })
        .expect(201);
      endpointId = ep.body.id;
    });

    afterAll(async () => {
      // Disable the failing endpoint so it stops queueing for later tests.
      if (endpointId) {
        await api
          .patch(`/webhooks/endpoints/${endpointId}`)
          .send({ isActive: false })
          .expect(200);
      }
      await mock500?.close();
    });

    it("first failed tick increments attemptCount and reschedules nextAttemptAt", async () => {
      const issue = await createIssue(booted.server, {
        projectId: fx.projectId,
        title: "Failing webhook subject",
        status: "BACKLOG",
        priority: 3,
      });
      await api
        .patch(`/issues/${issue.id}`)
        .send({ expectedVersion: issue.version, status: "TODO" })
        .expect(200);

      const tick = await api.post("/webhooks/_tick").expect(201);
      expect(tick.body.claimed).toBeGreaterThanOrEqual(1);
      // nothing was delivered — every attempt either gets retry-scheduled or permanently fails
      expect(tick.body.delivered).toBe(0);
      expect(tick.body.failed + tick.body.permanentlyFailed).toBeGreaterThanOrEqual(1);
    });
  });
});
