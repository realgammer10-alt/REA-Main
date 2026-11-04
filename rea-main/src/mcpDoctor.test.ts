import { describe, expect, it } from "vitest";

import { watchProductionMcpDoctor } from "./mcpDoctorWatch.js";

describe("production MCP doctor watch", () => {
  it("repeats probes without overlap until interrupted", async () => {
    const controller = new AbortController();
    const reports: boolean[] = [];
    let activeProbes = 0;
    let maximumActiveProbes = 0;
    let probeCount = 0;

    const exitCode = await watchProductionMcpDoctor({
      intervalMs: 1,
      signal: controller.signal,
      async probe() {
        activeProbes += 1;
        maximumActiveProbes = Math.max(maximumActiveProbes, activeProbes);
        probeCount += 1;
        await Promise.resolve();
        activeProbes -= 1;
        return { healthy: probeCount !== 2 };
      },
      onResult(result) {
        reports.push(result.healthy);
        if (reports.length === 3) controller.abort("SIGINT");
      },
    });

    expect(exitCode).toBe(130);
    expect(reports).toEqual([true, false, true]);
    expect(maximumActiveProbes).toBe(1);
  });

  it("uses the conventional termination exit code for SIGTERM", async () => {
    const controller = new AbortController();
    controller.abort("SIGTERM");

    await expect(
      watchProductionMcpDoctor({
        intervalMs: 1,
        signal: controller.signal,
        probe: async () => ({ healthy: true }),
        onResult: () => {
          throw new Error("An aborted watch must not run a probe");
        },
      }),
    ).resolves.toBe(143);
  });
});
