// "SKU-CODE, quantity" per line -> inbound lines. Pure; the schema still validates the result.
export type ParsedLines = {
  readonly lines: readonly { sku: string; qty: number }[];
  readonly errors: readonly string[];
};

export const parseLines = (text: string): ParsedLines => {
  const lines: { sku: string; qty: number }[] = [];
  const errors: string[] = [];
  text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '')
    .forEach((l, i) => {
      const m = /^([A-Za-z0-9._-]{1,64})\s*[,; \t]\s*(\d+)$/.exec(l);
      if (m === null) errors.push(`line ${i + 1}: use "SKU, quantity"`);
      else lines.push({ sku: m[1] ?? '', qty: Number(m[2]) });
    });
  return { lines, errors };
};
