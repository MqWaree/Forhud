export const MAX_EXTENSION_TARGET_RESULTS = 5_000;
export type ExtensionTargetMode = "LIMIT" | "UNTIL_STOPPED";

export function parseExtensionTarget(selection: string, customValue: string) {
  if (selection === "UNTIL_STOPPED")
    return { mode: "UNTIL_STOPPED" as const, targetResults: 0 };
  const targetResults = Number(
    selection === "CUSTOM" ? customValue : selection,
  );
  if (
    !Number.isInteger(targetResults) ||
    targetResults <= 0 ||
    targetResults > MAX_EXTENSION_TARGET_RESULTS
  )
    throw new Error(
      `Target Results must be a positive whole number up to ${MAX_EXTENSION_TARGET_RESULTS.toLocaleString()}`,
    );
  return { mode: "LIMIT" as const, targetResults };
}

export function hasReachedTarget(
  mode: ExtensionTargetMode | undefined,
  targetResults: number | undefined,
  uniqueResults: number,
) {
  return (
    mode === "LIMIT" &&
    Number.isInteger(targetResults) &&
    Number(targetResults) > 0 &&
    uniqueResults >= Number(targetResults)
  );
}
