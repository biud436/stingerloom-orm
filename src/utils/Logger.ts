import { EventEmitter } from "events";

type LOG_LEVEL =
  | "info"
  | "warn"
  | "error"
  | "debug"
  | "fatal"
  | "trace"
  | "silent";

class LoggerState {
  private state = "Logger";

  public info() {
    this.state = "INFO";
  }

  public warn() {
    this.state = "WARN";
  }

  public error() {
    this.state = "ERROR";
  }

  public debug() {
    this.state = "DEBUG";
  }

  public fatal() {
    this.state = "FATAL";
  }

  public trace() {
    this.state = "TRACE";
  }

  public silent() {
    this.state = "SILENT";
  }

  public toString() {
    return this.state;
  }
}

/**
 * Simple logger for ORM operations
 */
export class Logger extends EventEmitter {
  private readonly state: LoggerState = new LoggerState();
  public name? = "";

  constructor(name?: string) {
    super();
    this.name = name;
  }

  print =
    (level: string) =>
    (message: string, ...args: unknown[]) => {
      const processId = process.pid;
      this.state[level as LOG_LEVEL]();

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
      const logLevel = this.state.toString();
      const context = this.name ? `[${this.name}]` : "";

      console.log(
        `${processId} - ${timestamp} ${logLevel} ${context} ${formattedMessage}`,
      );
    };

  info = this.print("info");
  warn = this.print("warn");
  error = this.print("error");
  debug = this.print("debug");
  fatal = this.print("fatal");
  trace = this.print("trace");
  silent = this.print("silent");
}
