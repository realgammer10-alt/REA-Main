import { describe, expect, it } from "vitest";

import { parseMcpDoctorArguments } from "./mcpDoctorArguments.js";

describe("MCP doctor argument validation", () => {
  it("accepts bounded watch intervals and output formats", () => {
    expect(
      parseMcpDoctorArguments([
        "--watch",
        "--interval",
        "10",
        "--format=jsonl",
      ]),
    ).toEqual({
      ok: true,
      format: "jsonl",
      watch: true,
      intervalMs: 10_000,
    });
  });

  it.each(["", "0", "301", "1.5", "-1", "1e2"])(
    "rejects invalid watch interval %s",
    (interval) => {
      expect(
        parseMcpDoctorArguments(["--watch", `--interval=${interval}`]),
      ).toMatchObject({
        ok: false,
        help: false,
        message: expect.stringContaining("Invalid watch interval"),
      });
    },
  );

  it("requires watch mode when an interval is supplied", () => {
    expect(parseMcpDoctorArguments(["--interval", "5"])).toMatchObject({
      ok: false,
      help: false,
      message: "The --interval option requires --watch",
    });
  });

  it("does not interpret an option value as a help request", () => {
    expect(parseMcpDoctorArguments(["--format", "--help"])).toMatchObject({
      ok: false,
      help: false,
      message: "Invalid output format: --help",
    });
    expect(parseMcpDoctorArguments(["--interval", "--help"])).toMatchObject({
      ok: false,
      help: false,
      message: expect.stringContaining("Invalid watch interval"),
    });
  });
});
