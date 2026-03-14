type LOG_LEVEL =
  | "info"
  | "warn"
  | "error"
  | "debug"
  | "fatal"
  | "trace"
  | "silent";

const LOG_LEVEL_PRIORITY: Record<LOG_LEVEL, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  fatal: 5,
  silent: 6,
};

export interface ILogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
  fatal(message: string, ...args: unknown[]): void;
  trace(message: string, ...args: unknown[]): void;
}

/**
 * Simple logger for ORM operations with level filtering.
 */
export class Logger implements ILogger {
  private static minLevel: LOG_LEVEL = "info";
  private static output: ((msg: string) => void) | null = null;

  public name? = "";

  constructor(name?: string) {
    this.name = name;
  }

  /**
   * Sets the minimum log level. Messages below this level are suppressed.
   */
  static setLevel(level: LOG_LEVEL): void {
    Logger.minLevel = level;
  }

  /**
   * Returns the current minimum log level.
   */
  static getLevel(): LOG_LEVEL {
    return Logger.minLevel;
  }

  /**
   * Sets a custom output function (default: console.log).
   */
  static setOutput(fn: (msg: string) => void): void {
    Logger.output = fn;
  }

  /**
   * Resets to default settings (level: "info", output: console.log).
   */
  static reset(): void {
    Logger.minLevel = "info";
    Logger.output = null;
  }

  private print =
    (level: LOG_LEVEL) =>
    (message: string, ...args: unknown[]) => {
      // Level filtering
      if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[Logger.minLevel]) {
        return;
      }

      const processId = process.pid;

      let formattedMessage = message;
      if (args.length > 0) {
        const additionalArgs = args
          .map((arg) => {
            if (typeof arg === "object") {
              try {
                return JSON.stringify(arg, null, 2);
              } catch {
                return String(arg);
              }
            }
            return String(arg);
          })
          .join(" ");
        formattedMessage = `${message} ${additionalArgs}`;
      }

      const timestamp = new Date().toISOString();
      const logLevel = level.toUpperCase();
      const context = this.name ? `[${this.name}]` : "";

      const out = Logger.output ?? console.log;
      out(
        `${processId} - ${timestamp} ${logLevel} ${context} ${formattedMessage}`,
      );
    };

  info = this.print("info");
  warn = this.print("warn");
  error = this.print("error");
  debug = this.print("debug");
  fatal = this.print("fatal");
  trace = this.print("trace");
}
