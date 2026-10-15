export const NEVER_WILDCARD = new Set(["safety.csea.access"]);

export function permissionMatches(granted: string, required: string): boolean {
  if (granted === required) return true;
  if (NEVER_WILDCARD.has(required)) return false;
  if (granted === "*") return true;
  if (granted.endsWith(".*")) return required.startsWith(granted.slice(0, -1));
  return false;
}

export function hasPermission(granted: Iterable<string>, required: string): boolean {
  for (const g of granted) if (permissionMatches(g, required)) return true;
  return false;
}

export function expandPermissions(granted: Iterable<string>, known: Iterable<string>): string[] {
  const out = new Set<string>();
  const list = [...granted];
  for (const k of known) if (hasPermission(list, k)) out.add(k);
  return [...out].sort();
}

export function anyPermissionMatches(granted: Iterable<string>, patterns: string[]): boolean {
  for (const g of granted) {
    for (const p of patterns) {
      if (p === "*" || permissionMatches(p, g) || permissionMatches(g, p)) return true;
    }
  }
  return false;
}
