/* eslint-disable @typescript-eslint/no-explicit-any */
import "reflect-metadata";
import { PostgresConnector } from "../../src/dialects/postgres/PostgresConnector";
import { OrmError } from "../../src/errors/OrmError";

const mockPoolConfigs: any[] = [];
const mockPoolOn = jest.fn();

jest.mock("pg", () => ({
  Pool: jest.fn().mockImplementation((config: any) => {
    mockPoolConfigs.push(config);
    return { on: mockPoolOn, query: jest.fn(), end: jest.fn() };
  }),
}));

async function connect(schema?: string): Promise<any> {
  await new PostgresConnector().connect({
    type: "postgres",
    host: "localhost",
    port: 5432,
    username: "postgres",
    password: "postgres",
    database: "app",
    entities: [],
    versionOverride: "16.0",
    ...(schema === undefined ? {} : { schema }),
  });
  return mockPoolConfigs[mockPoolConfigs.length - 1];
}

function fakeClient(query: jest.Mock = jest.fn().mockResolvedValue({ rows: [] })) {
  return { query } as any;
}

describe("PostgresConnector — search_path on new pooled clients", () => {
  beforeEach(() => {
    mockPoolConfigs.length = 0;
    mockPoolOn.mockClear();
  });

  it("prepares a new client through pool hooks, not the connect event", async () => {
    const config = await connect("tenant_a");

    expect(typeof config.onConnect).toBe("function");
    expect(typeof config.verify).toBe("function");
    // The connect event does not wait for the SET, so the caller's first
    // query would queue behind it on the same client.
    expect(mockPoolOn).not.toHaveBeenCalledWith("connect", expect.anything());
  });

  it("sets search_path to the configured schema, quoted", async () => {
    const config = await connect("tenant_a");
    const client = fakeClient();

    await config.onConnect(client);

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(client.query).toHaveBeenCalledWith('SET search_path TO "tenant_a"');
  });

  it("sets search_path to public when no schema is configured", async () => {
    const config = await connect();
    const client = fakeClient();

    await config.onConnect(client);

    expect(client.query).toHaveBeenCalledWith('SET search_path TO "public"');
  });

  it("sends the SET once when the pool runs both hooks", async () => {
    // pg-pool 3.13+ runs onConnect and then verify on every new client.
    const config = await connect("tenant_a");
    const client = fakeClient();
    const done = jest.fn();

    await config.onConnect(client);
    config.verify(client, done);
    await new Promise(process.nextTick);

    expect(client.query).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledWith();
  });

  it("reports through verify only once the SET has finished, on a pool without onConnect", async () => {
    const config = await connect("tenant_a");
    let finish!: () => void;
    const client = fakeClient(
      jest.fn(() => new Promise<void>((resolve) => (finish = resolve))),
    );
    const done = jest.fn();

    config.verify(client, done);
    await new Promise(process.nextTick);
    expect(client.query).toHaveBeenCalledWith('SET search_path TO "tenant_a"');
    expect(done).not.toHaveBeenCalled();

    finish();
    await new Promise(process.nextTick);
    expect(done).toHaveBeenCalledWith();
  });

  it("hands a failed SET to the pool, which discards the client and fails the acquire", async () => {
    const config = await connect("tenant_a");
    const failure = new Error("permission denied");

    await expect(
      config.onConnect(fakeClient(jest.fn().mockRejectedValue(failure))),
    ).rejects.toBe(failure);

    const done = jest.fn();
    config.verify(fakeClient(jest.fn().mockRejectedValue(failure)), done);
    await new Promise(process.nextTick);
    expect(done).toHaveBeenCalledWith(failure);
  });

  it("prepares a client again after its SET failed", async () => {
    const config = await connect("tenant_a");
    const query = jest
      .fn()
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValueOnce({ rows: [] });
    const client = fakeClient(query);

    await expect(config.onConnect(client)).rejects.toThrow("permission denied");
    const done = jest.fn();
    config.verify(client, done);
    await new Promise(process.nextTick);

    expect(query).toHaveBeenCalledTimes(2);
    expect(done).toHaveBeenCalledWith();
  });

  it("rejects an invalid schema name before opening a pool", async () => {
    await expect(connect("app; DROP TABLE users")).rejects.toThrow(OrmError);
    expect(mockPoolConfigs).toHaveLength(0);
  });
});
