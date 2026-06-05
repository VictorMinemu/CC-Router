export interface ParsedSse {
  events: unknown[];
  remainder: string;
}

export function parseSseLines(input: string): ParsedSse {
  const lines = input.split("\n");
  const remainder = lines.pop() ?? "";
  const events: unknown[] = [];

  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const payload = line.slice(6).trim();
    if (!payload || payload === "[DONE]") continue;
    events.push(JSON.parse(payload));
  }

  return { events, remainder };
}

export function encodeSseEvent(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
