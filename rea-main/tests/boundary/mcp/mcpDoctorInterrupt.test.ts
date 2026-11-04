import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { expect, it, vi } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { runProductionMcpDoctor } from "../../../src/mcpDoctor.js";

it("stops a running MCP probe and cleans up its child when interrupted", async () => {
  const root = await createTestTempDirectory("rea-mcp-doctor-interrupt-");
  const pidPath = join(root, "pid");
  const controller = new AbortController();
  const pending = runProductionMcpDoctor({
    command: process.execPath,
    args: [resolve("tests/fixtures/mcpDoctorHang.mjs")],
    cwd: process.cwd(),
    environment: { ...process.env, REA_MCP_DOCTOR_PID_PATH: pidPath },
    signal: controller.signal,
    deadlineMs: 60_000,
  });
  const pid = await waitForPid(pidPath);

  controller.abort("SIGINT");

  const result = await pending;
  expect(result.healthy).toBe(false);
  expect(result.checked_at).toEqual(expect.any(String));
  await expect(waitForExit(pid)).resolves.toBeUndefined();
}, 10_000);

const waitForPid = async (path: string): Promise<number> =>
  vi.waitFor(async () => {
    const value = Number.parseInt(await readFile(path, "utf8"), 10);
    expect(Number.isSafeInteger(value) && value > 0).toBe(true);
    return value;
  }, 10_000);

const waitForExit = async (pid: number): Promise<void> => {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (cause: unknown) {
      if (cause instanceof Error && "code" in cause && cause.code === "ESRCH")
        return;
      throw cause;
    }
    await new Promise<void>((done) => setTimeout(done, 20));
  }
  throw new Error(`MCP doctor fixture process ${String(pid)} remained alive`);
};
