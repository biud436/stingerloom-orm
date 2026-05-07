/**
 * Minimal RFC 4180 CSV parser. We do not pull in `papaparse` or
 * `csv-parse` because the example's value is in showcasing the ORM's
 * `insertMany` chunked-transaction path, not in re-implementing well-trodden
 * CSV libraries.
 *
 * Supports:
 *   - quoted fields (with embedded "" → ")
 *   - quoted newlines (multi-line cells)
 *   - CRLF / LF line endings
 *
 * Does NOT support:
 *   - alternative delimiters (always `,`)
 *   - leading/trailing whitespace stripping (preserved as-is)
 */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  let inQuotes = false;
  const len = input.length;

  while (i < len) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < len && input[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      cell += ch;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      i++;
      continue;
    }
    if (ch === "\r") {
      // Treat \r or \r\n as line terminator.
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
      i++;
      if (i < len && input[i] === "\n") i++;
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      cell = "";
      rows.push(row);
      row = [];
      i++;
      continue;
    }
    cell += ch;
    i++;
  }

  // Trailing cell / row (file may not end with a newline).
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export interface CsvIssueRow {
  title: string;
  status?: string;
  priority?: number;
  estimate?: number;
}

/**
 * Parse a CSV string into typed issue rows. The first row is treated as the
 * header. Required column: `title`. Optional: `status`, `priority`,
 * `estimate`. Unknown columns are ignored, missing optional columns default
 * to undefined.
 */
export function parseIssueCsv(input: string): CsvIssueRow[] {
  const rows = parseCsv(input.trim());
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (name: string): number => header.indexOf(name);
  const titleI = idx("title");
  if (titleI < 0) {
    throw new Error("CSV header must include 'title'");
  }
  const statusI = idx("status");
  const priorityI = idx("priority");
  const estimateI = idx("estimate");
  const out: CsvIssueRow[] = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length === 1 && row[0] === "") continue; // skip blank trailing line
    const title = (row[titleI] ?? "").trim();
    if (!title) continue;
    const issue: CsvIssueRow = { title };
    if (statusI >= 0 && row[statusI]?.trim()) {
      issue.status = row[statusI].trim().toUpperCase();
    }
    if (priorityI >= 0 && row[priorityI]?.trim()) {
      const n = Number(row[priorityI]);
      if (Number.isFinite(n)) issue.priority = n;
    }
    if (estimateI >= 0 && row[estimateI]?.trim()) {
      const n = Number(row[estimateI]);
      if (Number.isFinite(n)) issue.estimate = n;
    }
    out.push(issue);
  }
  return out;
}
