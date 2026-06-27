export type OrganizeImportsActionResult<T> =
  { kind: "found"; action: T } | { kind: "unavailable" } | { kind: "ambiguous"; count: number };

/**
 * Selects an organize-import action only when exactly one is available.
 */
export function selectSoleOrganizeImportsAction<T>(
  actions: readonly T[],
): OrganizeImportsActionResult<T> {
  if (actions.length === 0) {
    return { kind: "unavailable" };
  }
  if (actions.length === 1) {
    return { kind: "found", action: actions[0] };
  }
  return { kind: "ambiguous", count: actions.length };
}
