import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { Formatter } from "incur";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { CATALOG_IDENTITY } from "./catalogIdentity.js";
import { PROMPT_CONTRACTS } from "./contracts/promptContracts.js";
import { TOOL_CONTRACTS } from "./contracts/toolContracts.js";
import { err, ok } from "./domain/result.js";
import { PRODUCT_IDENTITY } from "./identity.js";
import { MCP_STARTUP_POLICY } from "./mcpStartupPolicy.js";
import {
  parseMcpDoctorArguments,
  renderMcpDoctorHelp,
} from "./mcpDoctorArguments.js";
import { watchProductionMcpDoctor } from "./mcpDoctorWatch.js";

interface McpDoctorOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
}

interface InventoryComparison {
  readonly expected: number;
  readonly observed: number;
  readonly missing: readonly string[];
  readonly unexpected: readonly string[];
  readonly duplicates: readonly string[];
}

interface McpDoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** Diagnose the actual production stdio adapter with one startup-bounded SDK session. */
export const runProductionMcpDoctor = async (options: McpDoctorOptions) => {
  const started = performance.now();
  const deadline = doctorDeadline(options.deadlineMs);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Production MCP doctor deadline expired")),
    Math.max(1, deadline - Date.now()),
  );
  const signal = combineAbortSignals(controller.signal, options.signal);
  const stderr = captureStderr();
  const transport = new TrackedStdioClientTransport({
    command: options.command,
    args: [...options.args],
    cwd: options.cwd,
    env: targetFreeEnvironment(options.environment),
    stderr: "pipe",
  });
  transport.stderr?.on("data", stderr.append);
  const client = new Client({ name: "rea-mcp-doctor", version: "1" });
  try {
    await client.connect(transport, requestOptions(deadline, signal));
    return withObservationTiming(
      {
        ...(await inspectProductionMcpSession(client, deadline, signal)),
        diagnostics: stderr.value(),
      },
      started,
    );
  } catch (cause: unknown) {
    return withObservationTiming(
      {
        healthy: false,
        adapter: "production-stdio" as const,
        server: null,
        inventory: null,
        identity: null,
        request_flow: { tool: "binary_session", ok: false },
        checks: [
          {
            name: "transport",
            ok: false,
            detail: errorMessage(cause),
          },
        ],
        diagnostics: stderr.value(),
      },
      started,
    );
  } finally {
    clearTimeout(timer);
    await closeMcpChild(client, transport);
  }
};

const withObservationTiming = <T extends object>(
  report: T,
  started: number,
): T & { readonly checked_at: string; readonly duration_ms: number } => ({
  ...report,
  checked_at: new Date().toISOString(),
  duration_ms: Math.max(0, Math.round(performance.now() - started)),
});

const doctorDeadline = (deadlineMs?: number): number =>
  Date.now() + (deadlineMs ?? MCP_STARTUP_POLICY.doctorDeadlineMs);

const combineAbortSignals = (
  deadlineSignal: AbortSignal,
  requestSignal?: AbortSignal,
): AbortSignal =>
  requestSignal === undefined
    ? deadlineSignal
    : AbortSignal.any([deadlineSignal, requestSignal]);

const inspectProductionMcpSession = async (
  client: Client,
  deadline: number,
  signal: AbortSignal,
) => {
  const request = requestOptions(deadline, signal);
  const [tools, prompts] = await Promise.all([
    client.listTools(undefined, request),
    client.listPrompts(undefined, request),
  ]);
  const sessionTool = tools.tools.find(({ name }) => name === "binary_session");
  const requestFlow = await client
    .callTool(
      { name: "binary_session", arguments: {} },
      {
        ...requestOptions(deadline, signal),
        ...(sessionTool === undefined ? {} : { toolDefinition: sessionTool }),
      },
    )
    .then(ok, (cause: unknown) =>
      err({ kind: "request-flow" as const, detail: errorMessage(cause) }),
    );
  const inventory = {
    tools: compareInventory(
      TOOL_CONTRACTS.map(({ name }) => name),
      tools.tools.map(({ name }) => name),
    ),
    prompts: compareInventory(
      PROMPT_CONTRACTS.map(({ name }) => name),
      prompts.prompts.map(({ name }) => name),
    ),
  };
  const observedIdentity = parseIdentityToolResult(
    requestFlow.ok ? requestFlow.value.structuredContent : undefined,
  );
  const serverVersion = client.getServerVersion();
  const protocolVersion = client.getNegotiatedProtocolVersion();
  const checks: McpDoctorCheck[] = [
    {
      name: "initialize",
      ok:
        serverVersion?.name === PRODUCT_IDENTITY.mcpServerKey &&
        serverVersion.version === PRODUCT_IDENTITY.packageVersion &&
        protocolVersion !== undefined,
      detail: `${serverVersion?.name ?? "unknown"}@${serverVersion?.version ?? "unknown"}; protocol=${protocolVersion ?? "unknown"}`,
    },
    ...Object.entries(inventory).map(([name, comparison]) =>
      inventoryCheck(name, comparison),
    ),
    {
      name: "server-identity",
      ok:
        observedIdentity.packageVersion === PRODUCT_IDENTITY.packageVersion &&
        observedIdentity.catalogDigest ===
          CATALOG_IDENTITY.digests.combined_sha256,
      detail: `package=${observedIdentity.packageVersion ?? "missing"}; catalog=${observedIdentity.catalogDigest ?? "missing"}`,
    },
    {
      name: "request-flow",
      ok: requestFlow.ok && requestFlow.value.isError !== true,
      detail: requestFlow.ok
        ? "binary_session target-free request"
        : requestFlow.error.detail,
    },
  ];
  return {
    healthy: checks.every(({ ok }) => ok),
    adapter: "production-stdio" as const,
    server: {
      name: serverVersion?.name ?? null,
      version: serverVersion?.version ?? null,
      protocol_version: protocolVersion ?? null,
    },
    inventory,
    identity: {
      expected_package_version: PRODUCT_IDENTITY.packageVersion,
      observed_package_version: observedIdentity.packageVersion,
      expected_catalog_digest: CATALOG_IDENTITY.digests.combined_sha256,
      observed_catalog_digest: observedIdentity.catalogDigest,
    },
    request_flow: {
      tool: "binary_session",
      ok: requestFlow.ok && requestFlow.value.isError !== true,
    },
    checks,
  };
};

/**
 * Dispatcher entry for `rea mcp doctor`, kept separate from Incur MCP setup.
 * @public
 */
export const runProductionMcpDoctorCli = async (
  arguments_: readonly string[],
  input: {
    readonly dispatcherPath: string;
    readonly packageRoot: string;
    readonly signal?: AbortSignal;
    readonly writeOutput?: (output: string) => void;
  },
): Promise<{ readonly output: string; readonly exitCode: number }> => {
  const parsed = parseMcpDoctorArguments(arguments_);
  if (!parsed.ok) {
    if (parsed.help)
      return { output: `${renderMcpDoctorHelp()}\n`, exitCode: 0 };
    return {
      output: `${Formatter.format(
        { code: "VALIDATION_ERROR", message: parsed.message },
        parsed.format,
      )}\n`,
      exitCode: 1,
    };
  }
  if (parsed.watch) {
    if (input.signal === undefined || input.writeOutput === undefined)
      return {
        output: `${Formatter.format(
          {
            code: "VALIDATION_ERROR",
            message:
              "The --watch option requires an interrupt signal and output writer.",
          },
          parsed.format,
        )}\n`,
        exitCode: 1,
      };
    const { signal, writeOutput } = input;
    const exitCode = await watchProductionMcpDoctor({
      intervalMs: parsed.intervalMs,
      signal,
      probe: (signal) =>
        runProductionMcpDoctor({
          command: process.execPath,
          args: [resolve(input.dispatcherPath), "mcp"],
          cwd: input.packageRoot,
          environment: process.env,
          signal,
        }),
      onResult: (report) => {
        const separator =
          parsed.format === "json" || parsed.format === "jsonl"
            ? "\n"
            : "\n---\n";
        const output =
          parsed.format === "json"
            ? JSON.stringify(report)
            : Formatter.format(report, parsed.format);
        writeOutput(`${output}${separator}`);
      },
    });
    return { output: "", exitCode };
  }
  const result = await runProductionMcpDoctor({
    command: process.execPath,
    args: [resolve(input.dispatcherPath), "mcp"],
    cwd: input.packageRoot,
    environment: process.env,
  });
  return {
    output: `${Formatter.format(result, parsed.format)}\n`,
    exitCode: result.healthy ? 0 : 1,
  };
};

/** Compare exact names while retaining actionable mismatch locations. */
export const compareInventory = (
  expectedNames: readonly string[],
  observedNames: readonly string[],
): InventoryComparison => {
  const expected = new Set(expectedNames);
  const observed = new Set(observedNames);
  return {
    expected: expectedNames.length,
    observed: observedNames.length,
    missing: [...expected].filter((name) => !observed.has(name)).sort(),
    unexpected: [...observed].filter((name) => !expected.has(name)).sort(),
    duplicates: [...observed]
      .filter(
        (name) =>
          observedNames.filter((candidate) => candidate === name).length > 1,
      )
      .sort(),
  };
};

const inventoryCheck = (
  name: string,
  comparison: InventoryComparison,
): McpDoctorCheck => ({
  name: `inventory:${name}`,
  ok:
    comparison.expected === comparison.observed &&
    comparison.missing.length === 0 &&
    comparison.unexpected.length === 0 &&
    comparison.duplicates.length === 0,
  detail: `expected=${String(comparison.expected)} observed=${String(comparison.observed)} missing=${comparison.missing.join(",") || "none"} unexpected=${comparison.unexpected.join(",") || "none"} duplicates=${comparison.duplicates.join(",") || "none"}`,
});

const parseIdentityToolResult = (
  input: unknown,
): {
  readonly packageVersion: string | null;
  readonly catalogDigest: string | null;
} => {
  if (!isRecord(input) || !isRecord(input.result))
    return { packageVersion: null, catalogDigest: null };
  const identity = input.result.server_identity;
  if (!isRecord(identity)) return { packageVersion: null, catalogDigest: null };
  const packageIdentity = identity.package;
  const catalog = identity.catalog;
  const digests = isRecord(catalog) ? catalog.digests : undefined;
  return {
    packageVersion:
      isRecord(packageIdentity) && typeof packageIdentity.version === "string"
        ? packageIdentity.version
        : null,
    catalogDigest:
      isRecord(digests) && typeof digests.combined_sha256 === "string"
        ? digests.combined_sha256
        : null,
  };
};

const requestOptions = (deadline: number, signal: AbortSignal) => ({
  signal,
  timeout: Math.max(1, deadline - Date.now()),
});

const targetFreeEnvironment = (
  environment: Readonly<Record<string, string | undefined>>,
): Record<string, string> => {
  const result = Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  for (const name of [
    "HOPPER_TARGET_PATH",
    "HOPPER_TARGET_KIND",
    "HOPPER_LOADER_ARGS_JSON",
  ])
    delete result[name];
  return result;
};

const captureStderr = () => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  return {
    append(chunk: unknown) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(String(chunk), "utf8");
      bytes += buffer.byteLength;
      chunks.push(Buffer.from(buffer));
    },
    value: () => ({
      stderr: Buffer.concat(chunks, bytes).toString("utf8"),
      stderr_bytes: bytes,
    }),
  };
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

class TrackedStdioClientTransport extends StdioClientTransport {
  spawnedPid: number | null = null;

  override async start(): Promise<void> {
    await super.start();
    this.spawnedPid = this.pid;
  }
}

const closeMcpChild = async (
  client: Client,
  transport: TrackedStdioClientTransport,
): Promise<void> => {
  const pid = transport.spawnedPid ?? transport.pid;
  await Promise.allSettled([client.close()]);
  await Promise.allSettled([transport.close()]);
  if (pid === null || !(await processExists(pid))) return;
  await terminateProcess(pid, "SIGTERM");
  if (await waitForProcessExit(pid, 1_000)) return;
  await terminateProcess(pid, "SIGKILL");
  await waitForProcessExit(pid, 1_000);
};

const terminateProcess = async (
  pid: number,
  signal: NodeJS.Signals,
): Promise<void> => {
  try {
    process.kill(pid, signal);
  } catch (cause: unknown) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH"))
      throw cause;
  }
};

const waitForProcessExit = async (
  pid: number,
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  do {
    if (!(await processExists(pid))) return true;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  return !(await processExists(pid));
};

const processExists = async (pid: number): Promise<boolean> => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause: unknown) {
    if (cause instanceof Error && "code" in cause && cause.code === "ESRCH")
      return false;
    throw cause;
  }
};
