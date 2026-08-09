// {{placeholder}} template tokens shared by the frontend fill-in dialog,
// the CLI, and the unit tests.

const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_][a-zA-Z0-9_ -]*?)\s*\}\}/g;

/** Unique tokens in first-appearance order. */
export function extractTokens(text: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const match of text.matchAll(TOKEN_RE)) {
    const token = match[1]!.trim();
    if (!seen.has(token)) {
      seen.add(token);
      tokens.push(token);
    }
  }
  return tokens;
}

/** Replace every occurrence of each token; missing values keep the literal. */
export function fillTokens(
  text: string,
  values: Record<string, string>,
): string {
  return text.replace(TOKEN_RE, (whole, raw: string) => {
    const token = raw.trim();
    return Object.hasOwn(values, token) ? values[token]! : whole;
  });
}
