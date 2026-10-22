import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

let out = "";
let err = "";
const original = { log: console.log, error: console.error, write: process.stdout.write, errWrite: process.stderr.write };

beforeEach(() => {
  out = "";
  err = "";
  console.log = (message: unknown) => { out += `${String(message)}\n`; };
  console.error = (message: unknown) => { err += `${String(message)}\n`; };
  process.stdout.write = ((chunk: string) => { out += chunk; return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => { err += chunk; return true; }) as typeof process.stderr.write;
});

afterEach(() => {
  console.log = original.log;
  console.error = original.error;
  process.stdout.write = original.write;
  process.stderr.write = original.errWrite;
});

describe("cli entrypoints", () => {
  it("prints the grouped usage to stdout and exits 0 for --help", async () => {
    expect(await main(["--help"])).toBe(0);
    expect(out).toContain("Dynamic Task Router");
    expect(out).toContain("dtr route --task <text>");
    expect(out).toContain("dtr runs [--limit <n>]");
    expect(out).toContain("dtr doctor [--verbose]");
  });
  it("prints the grouped usage to stdout and exits 0 for the help subcommand", async () => {
    expect(await main(["help"])).toBe(0);
    expect(out).toContain("Dynamic Task Router");
    expect(out).toContain("dtr pipeline --template <name> --task <text>");
  });
  it("prints the package version and exits 0 for --version", async () => {
    expect(await main(["--version"])).toBe(0);
    expect(out).toMatch(/^dtr\s+\d+\.\d+\.\d+\s*$/);
  });
  it("names unknown commands and exits 1", async () => {
    expect(await main(["bogus"])).toBe(1);
    expect(err).toContain("dtr: unknown command: bogus");
    expect(err).toContain("Dynamic Task Router");
  });
  it("treats 'refresh' as a models subcommand rather than an unexpected argument", async () => {
    await main(["models", "refresh", "--config-dir", "definitely-not-a-real-dir"]);
    expect(err).not.toContain("Unexpected argument");
    expect(err).toMatch(/dtr: ENOENT|dtr: .*not exist|dtr: .*config/i);
  });
  it("evaluates routing cases against the base config and exits 0", async () => {
    expect(await main(["evaluate"])).toBe(0);
    expect(err).toBe("");
  });
  it("rejects bare --branch without a branch name", async () => {
    expect(await main(["pipeline", "--template", "implement-review", "--prompt", "test", "--write", "--branch"])).toBe(1);
    expect(err).toContain("--branch requires a branch name");
  });
  it("rejects mutually exclusive --isolated and --branch", async () => {
    expect(await main(["pipeline", "--template", "implement-review", "--prompt", "test", "--write", "--isolated", "--branch", "feature/test"])).toBe(1);
    expect(err).toContain("--isolated and --branch are mutually exclusive");
  });
});

describe("cli discoverability", () => {
  it("prints per-command help without running the command", async () => {
    expect(await main(["route", "--help"])).toBe(0);
    expect(out).toContain("Usage: dtr route --task <text>");
    expect(out).toContain("--files <paths>");
    expect(out).toContain("Examples:");
    expect(err).toBe("");
  });
  it("prints per-command help for a command that would otherwise fail", async () => {
    expect(await main(["pipeline", "--help"])).toBe(0);
    expect(out).toContain("Usage: dtr pipeline --template <name> --task <text>");
    expect(out).toContain("--allow-noop");
  });
  it("rejects an unknown option instead of silently ignoring it", async () => {
    expect(await main(["route", "--task", "test", "--typo-flag", "value"])).toBe(1);
    expect(err).toContain("Unknown option --typo-flag for 'dtr route'");
    expect(err).toContain("dtr route --help");
  });
  it("rejects an unknown option on a command that never invokes a model", async () => {
    expect(await main(["models", "--nonsense"])).toBe(1);
    expect(err).toContain("Unknown option --nonsense for 'dtr models'");
  });
  it("accepts the documented global flags on a command", async () => {
    expect(await main(["config", "--config-dir", "."])).toBe(0);
    expect(out).toContain("baseConfigDir");
  });
  it("names the missing option when a required flag is absent", async () => {
    expect(await main(["status"])).toBe(1);
    expect(err).toContain("--run-id is required");
  });
  it("points at the run list when a status id is unknown", async () => {
    expect(await main(["status", "--run-id", "00000000-0000-0000-0000-000000000000"])).toBe(1);
    expect(err).toContain("Run not found");
    expect(err).toContain("dtr runs");
  });
});
