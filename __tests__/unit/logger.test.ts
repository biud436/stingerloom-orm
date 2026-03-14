import { Logger } from "../../src/utils/Logger";

describe("Logger level filtering", () => {
  let output: string[];

  beforeEach(() => {
    Logger.reset();
    output = [];
    Logger.setOutput((msg) => output.push(msg));
  });

  afterAll(() => {
    Logger.reset();
  });

  it("default INFO level: suppresses debug and trace", () => {
    const logger = new Logger("Test");

    logger.debug("should not appear");
    logger.trace("should not appear");
    expect(output).toHaveLength(0);

    logger.info("visible");
    logger.warn("visible");
    logger.error("visible");
    logger.fatal("visible");
    expect(output).toHaveLength(4);
  });

  it("setLevel('debug') allows debug messages", () => {
    Logger.setLevel("debug");
    const logger = new Logger("Test");

    logger.debug("debug msg");
    expect(output).toHaveLength(1);
    expect(output[0]).toContain("DEBUG");

    logger.trace("still hidden");
    expect(output).toHaveLength(1);
  });

  it("setLevel('trace') allows all messages", () => {
    Logger.setLevel("trace");
    const logger = new Logger("Test");

    logger.trace("t");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    logger.fatal("f");
    expect(output).toHaveLength(6);
  });

  it("setLevel('silent') suppresses all messages", () => {
    Logger.setLevel("silent");
    const logger = new Logger("Test");

    logger.trace("nope");
    logger.debug("nope");
    logger.info("nope");
    logger.warn("nope");
    logger.error("nope");
    logger.fatal("nope");
    expect(output).toHaveLength(0);
  });

  it("setLevel('error') only allows error and fatal", () => {
    Logger.setLevel("error");
    const logger = new Logger("Test");

    logger.info("nope");
    logger.warn("nope");
    logger.debug("nope");
    expect(output).toHaveLength(0);

    logger.error("yes");
    logger.fatal("yes");
    expect(output).toHaveLength(2);
  });

  it("setOutput replaces the output function", () => {
    const custom: string[] = [];
    Logger.setOutput((msg) => custom.push(msg));
    const logger = new Logger("Custom");

    logger.info("hello");
    expect(custom).toHaveLength(1);
    expect(custom[0]).toContain("hello");
    expect(output).toHaveLength(0); // original capture not used
  });

  it("reset() restores defaults", () => {
    Logger.setLevel("silent");
    Logger.reset();
    // After reset, output goes to console.log (not our capture),
    // and level is back to info
    expect(Logger.getLevel()).toBe("info");
  });

  it("formats messages with context name", () => {
    const logger = new Logger("MyService");
    logger.info("test message");
    expect(output).toHaveLength(1);
    expect(output[0]).toContain("[MyService]");
    expect(output[0]).toContain("INFO");
    expect(output[0]).toContain("test message");
  });

  it("formats messages with additional args", () => {
    const logger = new Logger("Test");
    logger.info("user", { id: 1 });
    expect(output).toHaveLength(1);
    expect(output[0]).toContain("user");
    expect(output[0]).toContain('"id": 1');
  });
});
