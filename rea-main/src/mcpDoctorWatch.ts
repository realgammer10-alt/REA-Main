/** Repeatedly inspect MCP readiness without overlapping requests. */
export const watchProductionMcpDoctor = async (options: {
  readonly intervalMs: number;
  readonly signal: AbortSignal;
  readonly probe: (
    signal: AbortSignal,
  ) => Promise<{ readonly healthy: boolean }>;
  readonly onResult: (result: { readonly healthy: boolean }) => void;
}): Promise<number> => {
  while (!options.signal.aborted) {
    const result = await options.probe(options.signal);
    options.onResult(result);
    if (!options.signal.aborted)
      await delayUntilNextProbe(options.intervalMs, options.signal);
  }
  return options.signal.reason === "SIGTERM" ? 143 : 130;
};

const delayUntilNextProbe = (
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> =>
  new Promise((resolveDelay) => {
    if (signal.aborted) {
      resolveDelay();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      resolveDelay();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveDelay();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
