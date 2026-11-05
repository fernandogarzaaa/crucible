// node:sqlite prints an ExperimentalWarning on first import. It is stable enough for our use
// (Node >= 22.13) and the warning is noise in CLI output, so filter just that one message.
const original = process.emitWarning.bind(process);
(process as unknown as { emitWarning: typeof process.emitWarning }).emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const msg = typeof warning === "string" ? warning : warning?.message ?? "";
  if (msg.includes("SQLite is an experimental feature")) return;
  return (original as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;
export {};
