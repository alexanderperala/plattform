/** Minimal RFC 4180-parser: citattecken, dubbla citat, radbrytningar i fält, BOM och automatisk separator (komma eller semikolon). */
export function detectDelimiter(text: string): ',' | ';' | '\t' {
  const first = text.split(/\r\n|\n|\r/, 1)[0] ?? '';
  let best: ',' | ';' | '\t' = ',', n = -1, inQ = false;
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0 };
  for (const ch of first) { if (ch === '"') inQ = !inQ; else if (!inQ && ch in counts) counts[ch]!++; }
  for (const d of [',', ';', '\t'] as const) if (counts[d]! > n) { n = counts[d]!; best = d; }
  return best;
}

export function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, '');
  const d = detectDelimiter(text);
  const rows: string[][] = []; let row: string[] = []; let cur = ''; let inQ = false; let i = 0;
  const endRow = () => { row.push(cur); cur = ''; if (row.some((c) => c.trim() !== '')) rows.push(row); row = []; };
  while (i < text.length) {
    const ch = text[i]!;
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i += 2; continue; } inQ = false; i++; continue; }
      cur += ch; i++; continue;
    }
    if (ch === '"' && cur === '') { inQ = true; i++; continue; }
    if (ch === d) { row.push(cur); cur = ''; i++; continue; }
    if (ch === '\r') { if (text[i + 1] === '\n') i++; endRow(); i++; continue; }
    if (ch === '\n') { endRow(); i++; continue; }
    cur += ch; i++;
  }
  if (inQ) throw new Error('Filen innehåller ett citattecken som aldrig stängs.');
  if (cur !== '' || row.length) endRow();
  return rows;
}
