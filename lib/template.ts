// {{placeholder}} template tokens shared by the frontend fill-in dialog,
// the CLI, the agent tools, and the unit tests.
//
// `{{branch}}` asks for a value. `{{branch=main}}` asks with `main` already
// filled in — the common case is a token that usually has one answer.

const TOKEN_RE =
  /\{\{\s*([a-zA-Z0-9_][a-zA-Z0-9_ -]*?)\s*(?:=\s*([^}]*?)\s*)?\}\}/g;

export interface TemplateToken {
  name: string;
  /** Value written into the template as `{{name=default}}`; "" when absent. */
  defaultValue: string;
}

/** Unique tokens in first-appearance order, with their inline defaults. */
export function parseTokens(text: string): TemplateToken[] {
  const seen = new Map<string, TemplateToken>();
  for (const match of text.matchAll(TOKEN_RE)) {
    const name = match[1]!.trim();
    const defaultValue = (match[2] ?? "").trim();
    const existing = seen.get(name);
    if (existing === undefined) seen.set(name, { name, defaultValue });
    // First default wins, but a later occurrence may supply one the first lacked.
    else if (!existing.defaultValue && defaultValue)
      existing.defaultValue = defaultValue;
  }
  return [...seen.values()];
}

/** Unique token names in first-appearance order. */
export function extractTokens(text: string): string[] {
  return parseTokens(text).map((token) => token.name);
}

/**
 * Replace every occurrence of each token. A token with no supplied value falls
 * back to its inline default, and only a token with neither keeps its literal
 * `{{…}}` form — a half-filled prompt should still read as one.
 */
export function fillTokens(
  text: string,
  values: Record<string, string>,
): string {
  return text.replace(TOKEN_RE, (whole, rawName: string, rawDefault?: string) => {
    const name = rawName.trim();
    const supplied = Object.hasOwn(values, name) ? values[name]! : undefined;
    if (supplied !== undefined && supplied !== "") return supplied;
    const fallback = (rawDefault ?? "").trim();
    if (fallback) return fallback;
    return supplied !== undefined ? supplied : whole;
  });
}

/** True when the text still carries an unfilled `{{token}}`. */
export function hasTokens(text: string): boolean {
  return parseTokens(text).length > 0;
}
