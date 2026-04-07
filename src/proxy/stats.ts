export interface LogEntry {
  ts: number;
  accountId: string;
  model: string;
  type: "route" | "refresh" | "error";
  details?: string;
  statusCode?: number;
  durationMs?: number;
  method?: string;
  path?: string;
  // Token usage from Anthropic response (message_start + message_delta events)
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
}

const MAX_LOG_ENTRIES = 100;

class ProxyStats {
  totalRequests = 0;
  totalErrors = 0;
  totalRefreshes = 0;
  totalCacheReadTokens = 0;
  totalCacheCreationTokens = 0;
  totalInputTokens = 0;
  totalOutputTokens = 0;
  readonly startTime = Date.now();
  private logs: LogEntry[] = [];

  addLog(entry: LogEntry): void {
    this.logs.push(entry);
    if (this.logs.length > MAX_LOG_ENTRIES) this.logs.shift();
  }

  getRecentLogs(n = 20): LogEntry[] {
    return [...this.logs].reverse().slice(0, n);
  }

  getUptimeSeconds(): number {
    return Math.round((Date.now() - this.startTime) / 1000);
  }
}

// Singleton — shared across server and health endpoint
export const stats = new ProxyStats();
