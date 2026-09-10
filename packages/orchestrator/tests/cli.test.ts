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
  it("prints usage to stdout and exits 0 for --help", async () => {
    expect(await main(["--help"])).toBe(0);
    expect(out).toContain("Usage: dtr");
  });
  it("prints usage to stdout and exits 0 for the help subcommand", async () => {
    expect(await main(["help"])).toBe(0);
    expect(out).toContain("Usage: dtr");
  });
  it("prints the package version and exits 0 for --version", async () => {
    expect(await main(["--version"])).toBe(0);
    expect(out).toMatch(/^dtr\s+\d+\.\d+\.\d+\s*$/);
  });
  it("names unknown commands and exits 1", async () => {
    expect(await main(["bogus"])).toBe(1);
    expect(err).toContain("dtr: unknown command: bogus");
    expect(err).toContain("Usage: dtr");
  });
  it("treats 'refresh' as a models subcommand rather than an unexpected argument", async () => {
    await main(["models", "refresh", "--config-dir", "definitely-not-a-real-dir"]);
    expect(err).not.toContain("Unexpected argument");
    expect(err).toMatch(/dtr: ENOENT|dtr: .*not exist|dtr: .*config/i);
  });
});