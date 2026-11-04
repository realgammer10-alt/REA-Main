import { Help, z } from "incur";

const OUTPUT_FORMATS = ["toon", "json", "yaml", "md", "jsonl"] as const;
export type McpDoctorOutputFormat = (typeof OUTPUT_FORMATS)[number];

const MCP_DOCTOR_OPTIONS = z.object({
  format: z.enum(OUTPUT_FORMATS).optional().describe("Output format"),
  json: z.boolean().optional().describe("Emit the report as JSON"),
  fullOutput: z.boolean().optional().describe("Show the full output envelope"),
  watch: z.boolean().optional().describe("Repeat checks until interrupted"),
  interval: z
    .number()
    .int()
    .min(1)
    .max(300)
    .optional()
    .describe("Watch interval in seconds (1-300; requires --watch)"),
  help: z.boolean().optional().describe("Show help"),
});

const MCP_DOCTOR_ALIAS = { help: "h" } as const;
const MCP_DOCTOR_COMMAND = "rea mcp doctor";
const MCP_DOCTOR_DESCRIPTION =
  "Validate MCP server startup, tool listing, and request flow";
const HELP_FLAGS: ReadonlySet<string> = new Set(["--help", "-h"]);

export const renderMcpDoctorHelp = (): string =>
  Help.formatCommand(MCP_DOCTOR_COMMAND, {
    description: MCP_DOCTOR_DESCRIPTION,
    hideGlobalOptions: true,
    options: MCP_DOCTOR_OPTIONS,
    alias: MCP_DOCTOR_ALIAS,
    hint: "This entry accepts only the options above.",
  });

export type McpDoctorArguments =
  | {
      readonly ok: true;
      readonly format: McpDoctorOutputFormat;
      readonly watch: boolean;
      readonly intervalMs: number;
    }
  | { readonly ok: false; readonly help: true }
  | {
      readonly ok: false;
      readonly help: false;
      readonly format: McpDoctorOutputFormat;
      readonly message: string;
    };

export const parseMcpDoctorArguments = (
  arguments_: readonly string[],
): McpDoctorArguments => {
  if (hasHelpInOptionPosition(arguments_)) return { ok: false, help: true };
  let format: McpDoctorOutputFormat = "toon";
  let watch = false;
  let intervalSeconds: number | undefined;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--json") {
      format = "json";
      continue;
    }
    if (argument === "--watch") {
      watch = true;
      continue;
    }
    const parsedFormat = parseFormatOption(argument, arguments_[index + 1]);
    if (parsedFormat !== undefined) {
      if (!parsedFormat.ok)
        return {
          ok: false,
          help: false,
          format,
          message: parsedFormat.message,
        };
      format = parsedFormat.value;
      if (parsedFormat.consumedNext) index += 1;
      continue;
    }
    const parsedInterval = parseIntervalOption(argument, arguments_[index + 1]);
    if (parsedInterval !== undefined) {
      if (!parsedInterval.ok)
        return {
          ok: false,
          help: false,
          format,
          message: parsedInterval.message,
        };
      intervalSeconds = parsedInterval.value;
      if (parsedInterval.consumedNext) index += 1;
      continue;
    }
    if (argument === "--full-output") continue;
    return {
      ok: false,
      help: false,
      format,
      message: `Unknown mcp doctor option: ${argument ?? "missing"}`,
    };
  }
  if (intervalSeconds !== undefined && !watch)
    return {
      ok: false,
      help: false,
      format,
      message: "The --interval option requires --watch",
    };
  return {
    ok: true,
    format,
    watch,
    intervalMs: (intervalSeconds ?? 5) * 1_000,
  };
};

const parseFormatOption = (
  argument: string | undefined,
  next: string | undefined,
):
  | {
      readonly ok: true;
      readonly value: McpDoctorOutputFormat;
      readonly consumedNext: boolean;
    }
  | { readonly ok: false; readonly message: string }
  | undefined => {
  const inline = argument?.startsWith("--format=")
    ? argument.slice("--format=".length)
    : undefined;
  if (argument !== "--format" && inline === undefined) return undefined;
  const value = inline ?? next;
  return isOutputFormat(value)
    ? { ok: true, value, consumedNext: inline === undefined }
    : {
        ok: false,
        message: `Invalid output format: ${value ?? "missing"}`,
      };
};

const parseIntervalOption = (
  argument: string | undefined,
  next: string | undefined,
):
  | {
      readonly ok: true;
      readonly value: number;
      readonly consumedNext: boolean;
    }
  | { readonly ok: false; readonly message: string }
  | undefined => {
  const inline = argument?.startsWith("--interval=")
    ? argument.slice("--interval=".length)
    : undefined;
  if (argument !== "--interval" && inline === undefined) return undefined;
  const candidate = inline ?? next;
  const value =
    candidate !== undefined && /^\d+$/u.test(candidate)
      ? Number(candidate)
      : Number.NaN;
  return Number.isSafeInteger(value) && value >= 1 && value <= 300
    ? { ok: true, value, consumedNext: inline === undefined }
    : {
        ok: false,
        message: `Invalid watch interval: ${candidate ?? "missing"} (expected an integer from 1 to 300 seconds)`,
      };
};

const hasHelpInOptionPosition = (arguments_: readonly string[]): boolean => {
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--format" || argument === "--interval") {
      index += 1;
      continue;
    }
    if (HELP_FLAGS.has(argument ?? "")) return true;
  }
  return false;
};

const isOutputFormat = (
  value: string | undefined,
): value is McpDoctorOutputFormat =>
  OUTPUT_FORMATS.some((candidate) => candidate === value);
