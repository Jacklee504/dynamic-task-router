import { spawn } from "node:child_process";

import type { Command, ProcessResult, ProcessRunner } from "./types.js";

/** Grace period before a SIGTERM that the child ignored is escalated to SIGKILL. */
const KILL_GRACE_MS = 5_000;

export class NodeProcessRunner implements ProcessRunner {
  async run(command: Command, options: { cwd: string; timeoutMs?: number | undefined; signal?: AbortSignal | undefined }): Promise<ProcessResult> {
    return new Promise((resolve) => {
      const child = spawn(command.command, command.args, {
        cwd: options.cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const stopKillTimer = () => { if (killTimer) { clearTimeout(killTimer); killTimer = undefined; } };
      const kill = (signal: "SIGTERM" | "SIGKILL") => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        child.kill(signal);
        if (signal === "SIGTERM") {
          stopKillTimer();
          killTimer = setTimeout(() => { killTimer = undefined; kill("SIGKILL"); }, KILL_GRACE_MS);
        }
      };
      const timer = options.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            kill("SIGTERM");
          }, options.timeoutMs)
        : undefined;
      const abort = () => kill("SIGTERM");
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener("abort", abort, { once: true });

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error: Error) => {
        if (timer) clearTimeout(timer);
        stopKillTimer();
        options.signal?.removeEventListener("abort", abort);
        resolve({ stdout, stderr, exitCode: null, timedOut, error: error.message });
      });
      child.on("close", (exitCode) => {
        if (timer) clearTimeout(timer);
        stopKillTimer();
        options.signal?.removeEventListener("abort", abort);
        resolve({ stdout, stderr, exitCode, timedOut });
      });
    });
  }
}
