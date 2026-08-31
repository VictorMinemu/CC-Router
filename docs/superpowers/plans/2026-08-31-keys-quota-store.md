# Fase 1 — Almacenamiento de keys y cuotas (`feat/keys-quota-store`)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sustituir el secreto compartido único por API keys individuales con cuota de tokens por ventana, persistidas en SQLite y aplicadas en el camino crítico del proxy sin tocar disco.

**Architecture:** Una capa `src/storage/` posee SQLite (`node:sqlite`, WAL, migraciones versionadas). Una capa `src/keys/` mantiene en memoria el registro de keys y anillos de contadores horarios por key: validar y comprobar cuota es RAM pura. El middleware de auth del proxy resuelve la key, comprueba la cuota y responde `401`/`429`; la contabilidad se encola y se vuelca a disco en lotes fuera de la petición.

**Tech Stack:** TypeScript ESM (NodeNext), `node:sqlite` (`DatabaseSync`), Express 4, Vitest, `node:crypto`.

**Spec:** `docs/superpowers/specs/2026-08-31-keys-quotas-web-panel-design.md`

## Global Constraints

- Node `>=22.5` (`node:sqlite`). `package.json` → `engines.node: ">=22.5.0"`.
- `@types/node` debe subir a `^22.5.0`: la v20 instalada **no declara `node:sqlite`** y `tsc --noEmit` fallará sin ello.
- Cero dependencias de runtime nuevas. Todo con `node:crypto`, `node:sqlite` y lo ya presente.
- ESM con `moduleResolution: NodeNext`: **todos los imports relativos llevan extensión `.js`**, también en tests.
- Tests en `src/__tests__/**/*.test.ts` (es el único `include` de `vitest.config.ts`). Estilo: `describe`/`it`/`expect` importados de `vitest`, factorías `makeX()` locales, como en `src/__tests__/token-pool.test.ts`.
- Cobertura mínima configurada: 80% líneas y funciones, 70% ramas sobre `src/proxy/**`, `src/config/**`, `src/utils/**`.
- **El `proxySecret` existente debe seguir funcionando** como key heredada sin cuota. Hay un test de regresión dedicado (Tarea 9).
- **Nada de lo nuevo puede tumbar el proxy:** si SQLite no abre o una migración falla, el proxy arranca degradado (sirve peticiones, acepta el `proxySecret`, sin cuotas).
- Ventana de cuota **conservadora**: el sumatorio por buckets horarios cubre entre N y N+1 horas. Se bloquea antes, nunca después.
- `node:sqlite` devuelve filas con prototipo nulo: no uses métodos de `Object.prototype` sobre ellas; mapea siempre a objetos propios.

---

## Estructura de ficheros

**Crear:**

| Fichero | Responsabilidad |
|---|---|
| `src/storage/migrations.ts` | Array ordenado de migraciones SQL |
| `src/storage/db.ts` | Apertura de la base, WAL, aplicación de migraciones |
| `src/storage/keys-repo.ts` | CRUD de `api_keys` |
| `src/storage/usage-repo.ts` | Inserción por lotes de eventos, agregados horarios, purga |
| `src/keys/key-secret.ts` | Generación, hash y formato de presentación de secretos |
| `src/keys/windows.ts` | Aritmética de buckets y ventanas |
| `src/keys/usage-ring.ts` | Contadores horarios en memoria por key |
| `src/keys/quota.ts` | Política de cuota: veredicto permitido/bloqueado |
| `src/keys/registry.ts` | Registro en memoria: resolución de key + cuota + contabilidad |
| `src/keys/usage-writer.ts` | Buffer y volcado por lotes |
| `src/proxy/auth-middleware.ts` | Middleware Express de auth por key |
| `src/cli/cmd-keys.ts` | Comando `cc-router keys` |

**Modificar:** `src/config/paths.ts` (ruta de la base), `src/proxy/server.ts` (cableado y contabilidad), `src/cli/index.ts` (registro del comando), `package.json` (`engines`, `@types/node`).

---

### Task 1: Base de datos y migraciones

**Files:**
- Create: `src/storage/migrations.ts`
- Create: `src/storage/db.ts`
- Modify: `src/config/paths.ts`
- Modify: `package.json`
- Test: `src/__tests__/storage-db.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `openDatabase(path: string): DatabaseSync`, `runMigrations(db: DatabaseSync): number`, `currentSchemaVersion(db: DatabaseSync): number`, `closeDatabase(db: DatabaseSync): void`, `MIGRATIONS: Migration[]`, y `DB_PATH` desde `src/config/paths.ts`.

- [ ] **Step 1: Subir `engines` y `@types/node`**

En `package.json`, cambiar `engines.node` a `">=22.5.0"` y `devDependencies["@types/node"]` a `"^22.5.0"`. Después:

```bash
npm install
node -e "const {DatabaseSync}=require('node:sqlite');console.log('ok')"
```

Esperado: imprime `ok` (junto a un `ExperimentalWarning`, que se silencia en la Tarea 12).

- [ ] **Step 2: Escribir el test que falla**

```typescript
// src/__tests__/storage-db.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openDatabase, runMigrations, currentSchemaVersion, closeDatabase } from "../storage/db.js";
import { MIGRATIONS } from "../storage/migrations.js";

const dirs: string[] = [];
function tmpDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "ccr-db-"));
  dirs.push(dir);
  return join(dir, "router.db");
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("openDatabase", () => {
  it("creates the file and enables WAL", () => {
    const db = openDatabase(tmpDb());
    const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(row.journal_mode).toBe("wal");
    closeDatabase(db);
  });
});

describe("runMigrations", () => {
  it("applies every migration on a fresh database", () => {
    const db = openDatabase(tmpDb());
    const applied = runMigrations(db);
    expect(applied).toBe(MIGRATIONS.length);
    expect(currentSchemaVersion(db)).toBe(MIGRATIONS.length);
    closeDatabase(db);
  });

  it("is idempotent — a second run applies nothing", () => {
    const path = tmpDb();
    const first = openDatabase(path);
    runMigrations(first);
    closeDatabase(first);

    const second = openDatabase(path);
    expect(runMigrations(second)).toBe(0);
    expect(currentSchemaVersion(second)).toBe(MIGRATIONS.length);
    closeDatabase(second);
  });

  it("creates every expected table", () => {
    const db = openDatabase(tmpDb());
    runMigrations(db);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[])
      .map(r => r.name);
    for (const t of ["schema_migrations", "api_keys", "usage_events", "usage_hourly"]) {
      expect(names).toContain(t);
    }
    closeDatabase(db);
  });

  it("reports the version as 0 before migrating", () => {
    const db = openDatabase(tmpDb());
    expect(currentSchemaVersion(db)).toBe(0);
    closeDatabase(db);
  });
});
```

- [ ] **Step 3: Ejecutar el test y comprobar que falla**

Run: `npx vitest run src/__tests__/storage-db.test.ts`
Expected: FAIL — `Cannot find module '../storage/db.js'`.

- [ ] **Step 4: Escribir las migraciones**

```typescript
// src/storage/migrations.ts
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Ordered, append-only. Never edit an applied migration — add a new one. */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "keys_and_usage",
    sql: `
      CREATE TABLE api_keys (
        id            TEXT PRIMARY KEY,
        name          TEXT NOT NULL,
        owner         TEXT NOT NULL DEFAULT '',
        key_hash      TEXT NOT NULL UNIQUE,
        key_prefix    TEXT NOT NULL,
        key_last4     TEXT NOT NULL,
        enabled       INTEGER NOT NULL DEFAULT 1,
        created_at    INTEGER NOT NULL,
        last_used_at  INTEGER,
        expires_at    INTEGER,
        revoked_at    INTEGER,
        limit_5h      INTEGER,
        limit_7d      INTEGER,
        limit_month   INTEGER
      );
      CREATE INDEX idx_api_keys_hash ON api_keys(key_hash);

      CREATE TABLE usage_events (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        ts                     INTEGER NOT NULL,
        key_id                 TEXT,
        account_id             TEXT NOT NULL DEFAULT '',
        model                  TEXT NOT NULL DEFAULT '',
        input_tokens           INTEGER NOT NULL DEFAULT 0,
        output_tokens          INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens      INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens  INTEGER NOT NULL DEFAULT 0,
        status_code            INTEGER NOT NULL DEFAULT 0,
        duration_ms            INTEGER NOT NULL DEFAULT 0,
        path                   TEXT NOT NULL DEFAULT '',
        source                 TEXT NOT NULL DEFAULT '',
        error                  TEXT
      );
      CREATE INDEX idx_usage_events_ts ON usage_events(ts);
      CREATE INDEX idx_usage_events_key_ts ON usage_events(key_id, ts);

      CREATE TABLE usage_hourly (
        hour_start   INTEGER NOT NULL,
        key_id       TEXT NOT NULL DEFAULT '',
        account_id   TEXT NOT NULL DEFAULT '',
        model        TEXT NOT NULL DEFAULT '',
        tokens       INTEGER NOT NULL DEFAULT 0,
        requests     INTEGER NOT NULL DEFAULT 0,
        errors       INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (hour_start, key_id, account_id, model)
      );
      CREATE INDEX idx_usage_hourly_key ON usage_hourly(key_id, hour_start);
    `,
  },
];
```

- [ ] **Step 5: Escribir `db.ts`**

```typescript
// src/storage/db.ts
import { DatabaseSync } from "node:sqlite";
import { dirname } from "path";
import { mkdirSync } from "fs";
import { MIGRATIONS } from "./migrations.js";

/**
 * Open (creating if needed) the router database in WAL mode.
 * WAL matters here: the proxy writes usage batches while readers query
 * metrics, and WAL lets those not block each other.
 */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

function ensureMigrationTable(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);
}

export function currentSchemaVersion(db: DatabaseSync): number {
  ensureMigrationTable(db);
  const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null };
  return row?.v ?? 0;
}

/** Apply every pending migration in order. Returns how many were applied. */
export function runMigrations(db: DatabaseSync): number {
  ensureMigrationTable(db);
  const from = currentSchemaVersion(db);
  const pending = MIGRATIONS.filter(m => m.version > from).sort((a, b) => a.version - b.version);
  if (pending.length === 0) return 0;

  const record = db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)");
  for (const m of pending) {
    // node:sqlite has no nested-transaction helper; each migration is its own unit
    // so a failure halfway leaves earlier migrations durably applied.
    db.exec("BEGIN");
    try {
      db.exec(m.sql);
      record.run(m.version, m.name, Date.now());
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${m.version} (${m.name}) failed: ${(err as Error).message}`);
    }
  }
  return pending.length;
}

export function closeDatabase(db: DatabaseSync): void {
  db.close();
}
```

- [ ] **Step 6: Añadir `DB_PATH` a `paths.ts`**

En `src/config/paths.ts`, tras la definición de `CONFIG_PATH`:

```typescript
// Keys, usage events and hourly rollups — SQLite, owned by the proxy process
export const DB_PATH =
  process.env["DB_PATH"] ??
  path.join(CONFIG_DIR, "router.db");
```

- [ ] **Step 7: Ejecutar el test y comprobar que pasa**

Run: `npx vitest run src/__tests__/storage-db.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json src/storage/ src/config/paths.ts src/__tests__/storage-db.test.ts
git commit -m "feat(storage): add SQLite database with versioned migrations"
```

---

### Task 2: Generación y hash de secretos

**Files:**
- Create: `src/keys/key-secret.ts`
- Test: `src/__tests__/key-secret.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `KEY_PREFIX`, `generateKeySecret(): GeneratedKeySecret`, `hashKeySecret(secret: string): string`, `formatKeyDisplay(prefix: string, last4: string): string`, y el tipo `GeneratedKeySecret { secret, hash, prefix, last4 }`.

- [ ] **Step 1: Escribir el test que falla**

```typescript
// src/__tests__/key-secret.test.ts
import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import { KEY_PREFIX, generateKeySecret, hashKeySecret, formatKeyDisplay } from "../keys/key-secret.js";

describe("generateKeySecret", () => {
  it("produces a secret with the ccr_ prefix", () => {
    expect(generateKeySecret().secret.startsWith(KEY_PREFIX)).toBe(true);
  });

  it("produces distinct secrets on every call", () => {
    const seen = new Set(Array.from({ length: 200 }, () => generateKeySecret().secret));
    expect(seen.size).toBe(200);
  });

  it("carries 32 bytes of entropy encoded as base64url", () => {
    const body = generateKeySecret().secret.slice(KEY_PREFIX.length);
    expect(body).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(body, "base64url").length).toBe(32);
  });

  it("returns a hash matching hashKeySecret", () => {
    const g = generateKeySecret();
    expect(g.hash).toBe(hashKeySecret(g.secret));
  });

  it("returns the first 8 characters as prefix and the last 4 as last4", () => {
    const g = generateKeySecret();
    expect(g.prefix).toBe(g.secret.slice(0, 8));
    expect(g.last4).toBe(g.secret.slice(-4));
  });
});

describe("hashKeySecret", () => {
  it("is SHA-256 in lowercase hex", () => {
    expect(hashKeySecret("ccr_test")).toBe(
      createHash("sha256").update("ccr_test", "utf-8").digest("hex"),
    );
  });

  it("is stable across calls", () => {
    expect(hashKeySecret("ccr_abc")).toBe(hashKeySecret("ccr_abc"));
  });

  it("differs for different inputs", () => {
    expect(hashKeySecret("ccr_a")).not.toBe(hashKeySecret("ccr_b"));
  });
});

describe("formatKeyDisplay", () => {
  it("joins prefix and last4 with an ellipsis", () => {
    expect(formatKeyDisplay("ccr_a1b2", "f9x3")).toBe("ccr_a1b2…f9x3");
  });
});
```

- [ ] **Step 2: Ejecutar el test y comprobar que falla**

Run: `npx vitest run src/__tests__/key-secret.test.ts`
Expected: FAIL — `Cannot find module '../keys/key-secret.js'`.

- [ ] **Step 3: Implementar**

```typescript
// src/keys/key-secret.ts
import { createHash, randomBytes } from "crypto";

export const KEY_PREFIX = "ccr_";
const SECRET_BYTES = 32;

export interface GeneratedKeySecret {
  /** Full plaintext secret — shown to the user exactly once, never persisted. */
  secret: string;
  /** SHA-256 hex of the secret — this is what goes in the database. */
  hash: string;
  /** First 8 characters, for display. */
  prefix: string;
  /** Last 4 characters, for display. */
  last4: string;
}

/**
 * SHA-256 rather than scrypt on purpose: the secret carries 256 bits of real
 * entropy, so there is nothing to brute-force, and the hot path needs an
 * indexed lookup on every request.
 */
export function hashKeySecret(secret: string): string {
  return createHash("sha256").update(secret, "utf-8").digest("hex");
}

export function generateKeySecret(): GeneratedKeySecret {
  const secret = KEY_PREFIX + randomBytes(SECRET_BYTES).toString("base64url");
  return {
    secret,
    hash: hashKeySecret(secret),
    prefix: secret.slice(0, 8),
    last4: secret.slice(-4),
  };
}

export function formatKeyDisplay(prefix: string, last4: string): string {
  return `${prefix}…${last4}`;
}
```

- [ ] **Step 4: Ejecutar el test y comprobar que pasa**

Run: `npx vitest run src/__tests__/key-secret.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/keys/key-secret.ts src/__tests__/key-secret.test.ts
git commit -m "feat(keys): add key secret generation and hashing"
```

---

### Task 3: Aritmética de ventanas

**Files:**
- Create: `src/keys/windows.ts`
- Test: `src/__tests__/key-windows.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `HOUR_MS`, `RETENTION_HOURS`, `WINDOW_HOURS: Record<WindowName, number>`, `WINDOW_NAMES: WindowName[]`, `hourStart(ts: number): number`, `windowStart(now: number, hours: number): number`, y el tipo `WindowName = "5h" | "7d" | "month"`.

- [ ] **Step 1: Escribir el test que falla**

```typescript
// src/__tests__/key-windows.test.ts
import { describe, it, expect } from "vitest";
import {
  HOUR_MS, RETENTION_HOURS, WINDOW_HOURS, WINDOW_NAMES, hourStart, windowStart,
} from "../keys/windows.js";

const T = Date.UTC(2026, 7, 31, 14, 37, 12, 500); // 2026-08-31T14:37:12.500Z

describe("hourStart", () => {
  it("truncates to the top of the hour", () => {
    expect(hourStart(T)).toBe(Date.UTC(2026, 7, 31, 14, 0, 0, 0));
  });

  it("is a fixed point on an exact hour boundary", () => {
    const exact = Date.UTC(2026, 7, 31, 14, 0, 0, 0);
    expect(hourStart(exact)).toBe(exact);
  });

  it("is idempotent", () => {
    expect(hourStart(hourStart(T))).toBe(hourStart(T));
  });
});

describe("windowStart", () => {
  it("goes back N whole hours from the current hour, inclusive", () => {
    // Conservative by design: including the Nth bucket back means the window
    // spans between N and N+1 hours of real time, so we block early, never late.
    expect(windowStart(T, 5)).toBe(hourStart(T) - 5 * HOUR_MS);
  });

  it("covers at least the nominal window length", () => {
    expect(T - windowStart(T, 5)).toBeGreaterThanOrEqual(5 * HOUR_MS);
  });

  it("never covers more than one extra hour", () => {
    expect(T - windowStart(T, 5)).toBeLessThan(6 * HOUR_MS);
  });
});

describe("window constants", () => {
  it("defines 5h, 7d and month in hours", () => {
    expect(WINDOW_HOURS["5h"]).toBe(5);
    expect(WINDOW_HOURS["7d"]).toBe(7 * 24);
    expect(WINDOW_HOURS.month).toBe(30 * 24);
  });

  it("lists every window name", () => {
    expect(WINDOW_NAMES).toEqual(["5h", "7d", "month"]);
  });

  it("retains 35 days of buckets, five days beyond the longest window", () => {
    expect(RETENTION_HOURS).toBe(35 * 24);
    expect(RETENTION_HOURS).toBeGreaterThan(WINDOW_HOURS.month);
  });
});
```

- [ ] **Step 2: Ejecutar el test y comprobar que falla**

Run: `npx vitest run src/__tests__/key-windows.test.ts`
Expected: FAIL — `Cannot find module '../keys/windows.js'`.

- [ ] **Step 3: Implementar**

```typescript
// src/keys/windows.ts
export const HOUR_MS = 3_600_000;

export type WindowName = "5h" | "7d" | "month";

export const WINDOW_NAMES: WindowName[] = ["5h", "7d", "month"];

export const WINDOW_HOURS: Record<WindowName, number> = {
  "5h": 5,
  "7d": 7 * 24,
  month: 30 * 24,
};

/**
 * Raw events are kept 35 days — five beyond the longest window — so the
 * monthly quota can always be rebuilt exactly from raw data.
 */
export const RETENTION_HOURS = 35 * 24;

/** Timestamp of the top of the hour containing `ts`. */
export function hourStart(ts: number): number {
  return Math.floor(ts / HOUR_MS) * HOUR_MS;
}

/**
 * Oldest bucket included in an `hours`-long window ending now.
 *
 * Going back `hours` whole buckets (not `hours - 1`) makes the window span
 * between `hours` and `hours + 1` hours of wall time. That is deliberate: an
 * over-inclusive window blocks slightly early, which is the safe direction for
 * a quota. An under-inclusive one would silently let usage through.
 */
export function windowStart(now: number, hours: number): number {
  return hourStart(now) - hours * HOUR_MS;
}
```

- [ ] **Step 4: Ejecutar el test y comprobar que pasa**

Run: `npx vitest run src/__tests__/key-windows.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/keys/windows.ts src/__tests__/key-windows.test.ts
git commit -m "feat(keys): add hourly bucket and window arithmetic"
```

---

### Task 4: Anillo de contadores en memoria

**Files:**
- Create: `src/keys/usage-ring.ts`
- Test: `src/__tests__/usage-ring.test.ts`

**Interfaces:**
- Consumes: `HOUR_MS`, `RETENTION_HOURS`, `hourStart`, `windowStart` de `src/keys/windows.js`.
- Produces: la clase `UsageRing` con `add(ts, tokens)`, `seed(hourStartTs, tokens)`, `sum(now, hours)`, `resetAt(now, hours, limit)`, `size()`, `prune(now)`.

- [ ] **Step 1: Escribir el test que falla**

```typescript
// src/__tests__/usage-ring.test.ts
import { describe, it, expect } from "vitest";
import { UsageRing } from "../keys/usage-ring.js";
import { HOUR_MS, hourStart } from "../keys/windows.js";

const NOW = Date.UTC(2026, 7, 31, 14, 30, 0, 0);
const H = hourStart(NOW);

describe("UsageRing.add / sum", () => {
  it("starts empty", () => {
    expect(new UsageRing().sum(NOW, 5)).toBe(0);
  });

  it("accumulates tokens inside the current hour", () => {
    const ring = new UsageRing();
    ring.add(NOW, 100);
    ring.add(NOW + 60_000, 50);
    expect(ring.sum(NOW, 5)).toBe(150);
  });

  it("includes tokens from earlier hours inside the window", () => {
    const ring = new UsageRing();
    ring.add(H - 3 * HOUR_MS, 10);
    ring.add(H, 5);
    expect(ring.sum(NOW, 5)).toBe(15);
  });

  it("excludes tokens older than the window", () => {
    const ring = new UsageRing();
    ring.add(H - 9 * HOUR_MS, 999);
    ring.add(H, 7);
    expect(ring.sum(NOW, 5)).toBe(7);
  });

  it("keeps windows independent", () => {
    const ring = new UsageRing();
    ring.add(H - 20 * HOUR_MS, 40);
    ring.add(H, 2);
    expect(ring.sum(NOW, 5)).toBe(2);
    expect(ring.sum(NOW, 7 * 24)).toBe(42);
  });
});

describe("UsageRing.seed", () => {
  it("loads a pre-aggregated bucket", () => {
    const ring = new UsageRing();
    ring.seed(H - HOUR_MS, 500);
    expect(ring.sum(NOW, 5)).toBe(500);
  });

  it("adds to an existing bucket rather than replacing it", () => {
    const ring = new UsageRing();
    ring.seed(H, 100);
    ring.seed(H, 25);
    expect(ring.sum(NOW, 5)).toBe(125);
  });
});

describe("UsageRing.prune", () => {
  it("drops buckets beyond the retention horizon", () => {
    const ring = new UsageRing();
    ring.seed(hourStart(NOW - 40 * 24 * HOUR_MS), 1);
    ring.seed(H, 1);
    ring.prune(NOW);
    expect(ring.size()).toBe(1);
  });

  it("keeps buckets inside the retention horizon", () => {
    const ring = new UsageRing();
    ring.seed(hourStart(NOW - 10 * 24 * HOUR_MS), 1);
    ring.prune(NOW);
    expect(ring.size()).toBe(1);
  });

  it("prunes automatically as entries are added", () => {
    const ring = new UsageRing();
    ring.seed(hourStart(NOW - 40 * 24 * HOUR_MS), 1);
    ring.add(NOW, 1);
    expect(ring.size()).toBe(1);
  });
});

describe("UsageRing.resetAt", () => {
  it("returns the moment the window drops back under the limit", () => {
    const ring = new UsageRing();
    ring.add(H - 4 * HOUR_MS, 80);
    ring.add(H, 40);
    // Limit 100: the window only falls below it once the 80-token bucket
    // ages out, which happens one hour after it leaves a 5-bucket window.
    expect(ring.resetAt(NOW, 5, 100)).toBe(H - 4 * HOUR_MS + 6 * HOUR_MS);
  });

  it("returns the next hour boundary when a single bucket already clears it", () => {
    const ring = new UsageRing();
    ring.add(H - 5 * HOUR_MS, 200);
    expect(ring.resetAt(NOW, 5, 100)).toBe(H + HOUR_MS);
  });

  it("returns now when already under the limit", () => {
    const ring = new UsageRing();
    ring.add(H, 1);
    expect(ring.resetAt(NOW, 5, 100)).toBe(NOW);
  });
});
```

- [ ] **Step 2: Ejecutar el test y comprobar que falla**

Run: `npx vitest run src/__tests__/usage-ring.test.ts`
Expected: FAIL — `Cannot find module '../keys/usage-ring.js'`.

- [ ] **Step 3: Implementar**

```typescript
// src/keys/usage-ring.ts
import { HOUR_MS, RETENTION_HOURS, hourStart, windowStart } from "./windows.js";

/**
 * Per-key hourly token counters held in memory.
 *
 * The hot path never reads SQLite: quota checks are sums over at most
 * RETENTION_HOURS (840) numbers. Contents are rebuilt from raw usage events
 * at startup, so losing this on restart costs nothing.
 */
export class UsageRing {
  private readonly buckets = new Map<number, number>();

  constructor(private readonly retentionHours: number = RETENTION_HOURS) {}

  /** Record `tokens` consumed at wall-clock time `ts`. */
  add(ts: number, tokens: number): void {
    this.seed(hourStart(ts), tokens);
    this.prune(ts);
  }

  /** Add to the bucket starting exactly at `bucketStart` without pruning. */
  seed(bucketStart: number, tokens: number): void {
    this.buckets.set(bucketStart, (this.buckets.get(bucketStart) ?? 0) + tokens);
  }

  /** Total tokens in the `hours`-long window ending at `now`. */
  sum(now: number, hours: number): number {
    const from = windowStart(now, hours);
    let total = 0;
    for (const [start, tokens] of this.buckets) {
      if (start >= from) total += tokens;
    }
    return total;
  }

  /**
   * Earliest moment the window sum drops back below `limit`.
   *
   * Buckets leave the window one hour after `windowStart` passes them, so we
   * walk the buckets oldest-first, dropping them until the remainder fits.
   */
  resetAt(now: number, hours: number, limit: number): number {
    if (this.sum(now, hours) < limit) return now;

    const from = windowStart(now, hours);
    const live = [...this.buckets.entries()]
      .filter(([start]) => start >= from)
      .sort((a, b) => a[0] - b[0]);

    let remaining = live.reduce((acc, [, tokens]) => acc + tokens, 0);
    for (const [start, tokens] of live) {
      remaining -= tokens;
      // `start` leaves an `hours`-long window once windowStart moves past it,
      // i.e. one hour after the window's oldest slot advances beyond `start`.
      const leavesAt = start + (hours + 1) * HOUR_MS;
      if (remaining < limit) return leavesAt;
    }
    return hourStart(now) + HOUR_MS;
  }

  /** Drop buckets older than the retention horizon. */
  prune(now: number): void {
    const cutoff = hourStart(now) - this.retentionHours * HOUR_MS;
    for (const start of this.buckets.keys()) {
      if (start < cutoff) this.buckets.delete(start);
    }
  }

  size(): number {
    return this.buckets.size;
  }
}
```

- [ ] **Step 4: Ejecutar el test y comprobar que pasa**

Run: `npx vitest run src/__tests__/usage-ring.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/keys/usage-ring.ts src/__tests__/usage-ring.test.ts
git commit -m "feat(keys): add in-memory hourly usage ring"
```

---
### Task 5: Repositorio de keys

**Files:**
- Create: `src/storage/keys-repo.ts`
- Test: `src/__tests__/keys-repo.test.ts`

**Interfaces:**
- Consumes: `openDatabase`, `runMigrations` de `src/storage/db.js`; `GeneratedKeySecret` de `src/keys/key-secret.js`.
- Produces: el tipo `ApiKeyRow`, el tipo `CreateApiKeyInput`, el tipo `UpdateApiKeyInput`, y la clase `KeysRepo` con `create`, `listAll`, `findById`, `findByHash`, `update`, `revoke`, `touchLastUsed`.

- [ ] **Step 1: Escribir el test que falla**

```typescript
// src/__tests__/keys-repo.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { openDatabase, runMigrations } from "../storage/db.js";
import { KeysRepo, type ApiKeyRow } from "../storage/keys-repo.js";
import { generateKeySecret } from "../keys/key-secret.js";

const NOW = Date.UTC(2026, 7, 31, 12, 0, 0, 0);

function makeRepo(): KeysRepo {
  const db = openDatabase(":memory:");
  runMigrations(db);
  return new KeysRepo(db);
}

function add(repo: KeysRepo, name = "laptop", limit5h: number | null = null): ApiKeyRow {
  return repo.create({ name, owner: "victor", limit5h }, generateKeySecret(), NOW);
}

describe("KeysRepo.create", () => {
  it("persists the key and returns it", () => {
    const repo = makeRepo();
    const row = add(repo);
    expect(row.name).toBe("laptop");
    expect(row.owner).toBe("victor");
    expect(row.enabled).toBe(true);
    expect(row.createdAt).toBe(NOW);
    expect(repo.listAll()).toHaveLength(1);
  });

  it("never stores the plaintext secret", () => {
    const repo = makeRepo();
    const secret = generateKeySecret();
    const row = repo.create({ name: "x", owner: "" }, secret, NOW);
    expect(JSON.stringify(row)).not.toContain(secret.secret);
    expect(row.keyHash).toBe(secret.hash);
  });

  it("defaults limits to null, meaning unlimited", () => {
    const repo = makeRepo();
    const row = add(repo);
    expect(row.limit5h).toBeNull();
    expect(row.limit7d).toBeNull();
    expect(row.limitMonth).toBeNull();
  });

  it("assigns a distinct id to every key", () => {
    const repo = makeRepo();
    expect(add(repo, "a").id).not.toBe(add(repo, "b").id);
  });
});

describe("KeysRepo.findByHash", () => {
  it("finds a key by its hash", () => {
    const repo = makeRepo();
    const secret = generateKeySecret();
    const row = repo.create({ name: "x", owner: "" }, secret, NOW);
    expect(repo.findByHash(secret.hash)?.id).toBe(row.id);
  });

  it("returns null for an unknown hash", () => {
    expect(makeRepo().findByHash("deadbeef")).toBeNull();
  });
});

describe("KeysRepo.update", () => {
  it("changes the quota limits", () => {
    const repo = makeRepo();
    const row = add(repo);
    const updated = repo.update(row.id, { limit5h: 1000, limitMonth: 50_000 });
    expect(updated?.limit5h).toBe(1000);
    expect(updated?.limitMonth).toBe(50_000);
    expect(updated?.limit7d).toBeNull();
  });

  it("clears a limit when set to null", () => {
    const repo = makeRepo();
    const row = add(repo, "laptop", 500);
    expect(repo.update(row.id, { limit5h: null })?.limit5h).toBeNull();
  });

  it("leaves untouched fields alone", () => {
    const repo = makeRepo();
    const row = add(repo);
    expect(repo.update(row.id, { enabled: false })?.name).toBe("laptop");
  });

  it("returns null for an unknown id", () => {
    expect(makeRepo().update("nope", { enabled: false })).toBeNull();
  });
});

describe("KeysRepo.revoke", () => {
  it("stamps revokedAt", () => {
    const repo = makeRepo();
    const row = add(repo);
    expect(repo.revoke(row.id, NOW)).toBe(true);
    expect(repo.findById(row.id)?.revokedAt).toBe(NOW);
  });

  it("returns false for an unknown id", () => {
    expect(makeRepo().revoke("nope", NOW)).toBe(false);
  });
});

describe("KeysRepo.touchLastUsed", () => {
  it("records the last use timestamp", () => {
    const repo = makeRepo();
    const row = add(repo);
    expect(row.lastUsedAt).toBeNull();
    repo.touchLastUsed(row.id, NOW + 5);
    expect(repo.findById(row.id)?.lastUsedAt).toBe(NOW + 5);
  });
});
```

- [ ] **Step 2: Ejecutar el test y comprobar que falla**

Run: `npx vitest run src/__tests__/keys-repo.test.ts`
Expected: FAIL — `Cannot find module '../storage/keys-repo.js'`.

- [ ] **Step 3: Implementar**

```typescript
// src/storage/keys-repo.ts
import { randomUUID } from "crypto";
import type { DatabaseSync } from "node:sqlite";
import type { GeneratedKeySecret } from "../keys/key-secret.js";

export interface ApiKeyRow {
  id: string;
  name: string;
  owner: string;
  keyHash: string;
  keyPrefix: string;
  keyLast4: string;
  enabled: boolean;
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
  /** Token ceiling for the window. null means unlimited. */
  limit5h: number | null;
  limit7d: number | null;
  limitMonth: number | null;
}

export interface CreateApiKeyInput {
  name: string;
  owner: string;
  expiresAt?: number | null;
  limit5h?: number | null;
  limit7d?: number | null;
  limitMonth?: number | null;
}

export interface UpdateApiKeyInput {
  name?: string;
  owner?: string;
  enabled?: boolean;
  expiresAt?: number | null;
  limit5h?: number | null;
  limit7d?: number | null;
  limitMonth?: number | null;
}

/** node:sqlite returns null-prototype rows; map them into owned objects. */
interface RawRow {
  id: string; name: string; owner: string;
  key_hash: string; key_prefix: string; key_last4: string;
  enabled: number; created_at: number;
  last_used_at: number | null; expires_at: number | null; revoked_at: number | null;
  limit_5h: number | null; limit_7d: number | null; limit_month: number | null;
}

function toRow(r: RawRow): ApiKeyRow {
  return {
    id: r.id,
    name: r.name,
    owner: r.owner,
    keyHash: r.key_hash,
    keyPrefix: r.key_prefix,
    keyLast4: r.key_last4,
    enabled: r.enabled === 1,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
    revokedAt: r.revoked_at,
    limit5h: r.limit_5h,
    limit7d: r.limit_7d,
    limitMonth: r.limit_month,
  };
}

const SELECT_ALL = `
  SELECT id, name, owner, key_hash, key_prefix, key_last4, enabled, created_at,
         last_used_at, expires_at, revoked_at, limit_5h, limit_7d, limit_month
  FROM api_keys
`;

export class KeysRepo {
  constructor(private readonly db: DatabaseSync) {}

  create(input: CreateApiKeyInput, secret: GeneratedKeySecret, now: number): ApiKeyRow {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO api_keys
        (id, name, owner, key_hash, key_prefix, key_last4, enabled, created_at,
         expires_at, limit_5h, limit_7d, limit_month)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).run(
      id, input.name, input.owner,
      secret.hash, secret.prefix, secret.last4,
      now,
      input.expiresAt ?? null,
      input.limit5h ?? null,
      input.limit7d ?? null,
      input.limitMonth ?? null,
    );
    // Non-null: we just inserted this id.
    return this.findById(id)!;
  }

  listAll(): ApiKeyRow[] {
    return (this.db.prepare(`${SELECT_ALL} ORDER BY created_at ASC`).all() as RawRow[]).map(toRow);
  }

  findById(id: string): ApiKeyRow | null {
    const r = this.db.prepare(`${SELECT_ALL} WHERE id = ?`).get(id) as RawRow | undefined;
    return r ? toRow(r) : null;
  }

  findByHash(hash: string): ApiKeyRow | null {
    const r = this.db.prepare(`${SELECT_ALL} WHERE key_hash = ?`).get(hash) as RawRow | undefined;
    return r ? toRow(r) : null;
  }

  update(id: string, patch: UpdateApiKeyInput): ApiKeyRow | null {
    const current = this.findById(id);
    if (!current) return null;

    const next = {
      name: patch.name ?? current.name,
      owner: patch.owner ?? current.owner,
      enabled: patch.enabled ?? current.enabled,
      expiresAt: patch.expiresAt !== undefined ? patch.expiresAt : current.expiresAt,
      limit5h: patch.limit5h !== undefined ? patch.limit5h : current.limit5h,
      limit7d: patch.limit7d !== undefined ? patch.limit7d : current.limit7d,
      limitMonth: patch.limitMonth !== undefined ? patch.limitMonth : current.limitMonth,
    };

    this.db.prepare(`
      UPDATE api_keys
      SET name = ?, owner = ?, enabled = ?, expires_at = ?,
          limit_5h = ?, limit_7d = ?, limit_month = ?
      WHERE id = ?
    `).run(
      next.name, next.owner, next.enabled ? 1 : 0, next.expiresAt,
      next.limit5h, next.limit7d, next.limitMonth, id,
    );
    return this.findById(id);
  }

  revoke(id: string, now: number): boolean {
    if (!this.findById(id)) return false;
    this.db.prepare("UPDATE api_keys SET revoked_at = ?, enabled = 0 WHERE id = ?").run(now, id);
    return true;
  }

  touchLastUsed(id: string, now: number): void {
    this.db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now, id);
  }
}
```

- [ ] **Step 4: Ejecutar el test y comprobar que pasa**

Run: `npx vitest run src/__tests__/keys-repo.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Commit**

```bash
git add src/storage/keys-repo.ts src/__tests__/keys-repo.test.ts
git commit -m "feat(storage): add api_keys repository"
```

---

### Task 6: Política de cuota

**Files:**
- Create: `src/keys/quota.ts`
- Test: `src/__tests__/quota.test.ts`

**Interfaces:**
- Consumes: `WindowName`, `WINDOW_NAMES` de `src/keys/windows.js`.
- Produces: los tipos `QuotaLimits`, `QuotaUsage`, `QuotaVerdict`, y `checkQuota(limits: QuotaLimits, usage: QuotaUsage): QuotaVerdict`, `limitsOf(key): QuotaLimits`.

- [ ] **Step 1: Escribir el test que falla**

```typescript
// src/__tests__/quota.test.ts
import { describe, it, expect } from "vitest";
import { checkQuota, limitsOf, type QuotaLimits, type QuotaUsage } from "../keys/quota.js";
import type { ApiKeyRow } from "../storage/keys-repo.js";

const NONE: QuotaLimits = { "5h": null, "7d": null, month: null };
const ZERO: QuotaUsage = { "5h": 0, "7d": 0, month: 0 };

describe("checkQuota", () => {
  it("allows when every limit is unset", () => {
    expect(checkQuota(NONE, { "5h": 9e9, "7d": 9e9, month: 9e9 })).toEqual({ allowed: true });
  });

  it("allows when usage is below the limit", () => {
    expect(checkQuota({ ...NONE, "5h": 100 }, { ...ZERO, "5h": 99 })).toEqual({ allowed: true });
  });

  it("blocks when usage reaches the limit exactly", () => {
    expect(checkQuota({ ...NONE, "5h": 100 }, { ...ZERO, "5h": 100 })).toEqual({
      allowed: false, window: "5h", used: 100, limit: 100,
    });
  });

  it("blocks when usage overshoots the limit", () => {
    // A request that started under the limit can finish over it — the spec
    // accepts that overshoot, and the next request is what gets blocked.
    expect(checkQuota({ ...NONE, "5h": 100 }, { ...ZERO, "5h": 250 })).toEqual({
      allowed: false, window: "5h", used: 250, limit: 100,
    });
  });

  it("reports the 7d window when that is the one exhausted", () => {
    expect(checkQuota({ ...NONE, "7d": 10 }, { ...ZERO, "7d": 10 })).toEqual({
      allowed: false, window: "7d", used: 10, limit: 10,
    });
  });

  it("reports the month window when that is the one exhausted", () => {
    expect(checkQuota({ ...NONE, month: 10 }, { ...ZERO, month: 10 })).toEqual({
      allowed: false, window: "month", used: 10, limit: 10,
    });
  });

  it("reports the shortest exhausted window first", () => {
    const limits: QuotaLimits = { "5h": 10, "7d": 10, month: 10 };
    const usage: QuotaUsage = { "5h": 10, "7d": 10, month: 10 };
    expect(checkQuota(limits, usage)).toMatchObject({ window: "5h" });
  });

  it("treats a limit of zero as blocking everything", () => {
    expect(checkQuota({ ...NONE, "5h": 0 }, ZERO)).toEqual({
      allowed: false, window: "5h", used: 0, limit: 0,
    });
  });
});

describe("limitsOf", () => {
  it("projects a key row onto the window-keyed shape", () => {
    const key = { limit5h: 1, limit7d: 2, limitMonth: 3 } as ApiKeyRow;
    expect(limitsOf(key)).toEqual({ "5h": 1, "7d": 2, month: 3 });
  });
});
```

- [ ] **Step 2: Ejecutar el test y comprobar que falla**

Run: `npx vitest run src/__tests__/quota.test.ts`
Expected: FAIL — `Cannot find module '../keys/quota.js'`.

- [ ] **Step 3: Implementar**

```typescript
// src/keys/quota.ts
import { WINDOW_NAMES, type WindowName } from "./windows.js";
import type { ApiKeyRow } from "../storage/keys-repo.js";

/** Token ceiling per window. null means unlimited. */
export type QuotaLimits = Record<WindowName, number | null>;

/** Tokens already consumed per window. */
export type QuotaUsage = Record<WindowName, number>;

export type QuotaVerdict =
  | { allowed: true }
  | { allowed: false; window: WindowName; used: number; limit: number };

export function limitsOf(key: ApiKeyRow): QuotaLimits {
  return { "5h": key.limit5h, "7d": key.limit7d, month: key.limitMonth };
}

/**
 * WINDOW_NAMES is ordered shortest-first, so the reported window is the
 * tightest one that is exhausted — which is also the one that reopens soonest.
 */
export function checkQuota(limits: QuotaLimits, usage: QuotaUsage): QuotaVerdict {
  for (const window of WINDOW_NAMES) {
    const limit = limits[window];
    if (limit === null) continue;
    const used = usage[window];
    if (used >= limit) return { allowed: false, window, used, limit };
  }
  return { allowed: true };
}
```

- [ ] **Step 4: Ejecutar el test y comprobar que pasa**

Run: `npx vitest run src/__tests__/quota.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/keys/quota.ts src/__tests__/quota.test.ts
git commit -m "feat(keys): add quota policy evaluation"
```

---

### Task 7: Registro de keys en memoria

**Files:**
- Create: `src/keys/registry.ts`
- Test: `src/__tests__/key-registry.test.ts`

**Interfaces:**
- Consumes: `KeysRepo`, `ApiKeyRow` de `src/storage/keys-repo.js`; `hashKeySecret` de `src/keys/key-secret.js`; `UsageRing` de `src/keys/usage-ring.js`; `checkQuota`, `limitsOf` de `src/keys/quota.js`; `WINDOW_HOURS`, `WINDOW_NAMES` de `src/keys/windows.js`.
- Produces: los tipos `ResolveResult` y `QuotaCheck`, el tipo `SeedBucket`, y la clase `KeyRegistry` con `reload`, `seed`, `resolve`, `quotaFor`, `usageFor`, `recordUsage`.

- [ ] **Step 1: Escribir el test que falla**

```typescript
// src/__tests__/key-registry.test.ts
import { describe, it, expect } from "vitest";
import { openDatabase, runMigrations } from "../storage/db.js";
import { KeysRepo } from "../storage/keys-repo.js";
import { KeyRegistry } from "../keys/registry.js";
import { generateKeySecret } from "../keys/key-secret.js";
import { HOUR_MS, hourStart } from "../keys/windows.js";

const NOW = Date.UTC(2026, 7, 31, 12, 30, 0, 0);
const H = hourStart(NOW);

function setup(legacySecret?: string) {
  const db = openDatabase(":memory:");
  runMigrations(db);
  const repo = new KeysRepo(db);
  const registry = new KeyRegistry({ repo, legacySecret });
  return { repo, registry };
}

function addKey(repo: KeysRepo, limits: { limit5h?: number | null } = {}) {
  const secret = generateKeySecret();
  const row = repo.create({ name: "k", owner: "v", ...limits }, secret, NOW);
  return { secret: secret.secret, row };
}

describe("KeyRegistry.resolve", () => {
  it("resolves a known key", () => {
    const { repo, registry } = setup();
    const { secret, row } = addKey(repo);
    registry.reload();
    expect(registry.resolve(secret)).toEqual({ kind: "ok", key: expect.objectContaining({ id: row.id }) });
  });

  it("reports an unknown secret", () => {
    const { registry } = setup();
    registry.reload();
    expect(registry.resolve("ccr_nope")).toEqual({ kind: "unknown" });
  });

  it("accepts the legacy proxySecret", () => {
    const { registry } = setup("cc-rtr-legacy");
    registry.reload();
    expect(registry.resolve("cc-rtr-legacy")).toEqual({ kind: "legacy" });
  });

  it("does not accept the legacy secret when none is configured", () => {
    const { registry } = setup();
    registry.reload();
    expect(registry.resolve("cc-rtr-legacy")).toEqual({ kind: "unknown" });
  });

  it("rejects a revoked key", () => {
    const { repo, registry } = setup();
    const { secret, row } = addKey(repo);
    repo.revoke(row.id, NOW);
    registry.reload();
    expect(registry.resolve(secret)).toMatchObject({ kind: "rejected", reason: "revoked" });
  });

  it("rejects a disabled key", () => {
    const { repo, registry } = setup();
    const { secret, row } = addKey(repo);
    repo.update(row.id, { enabled: false });
    registry.reload();
    expect(registry.resolve(secret)).toMatchObject({ kind: "rejected", reason: "disabled" });
  });

  it("rejects an expired key", () => {
    const { repo, registry } = setup();
    const { secret, row } = addKey(repo);
    repo.update(row.id, { expiresAt: NOW - 1 });
    registry.reload();
    expect(registry.resolve(secret, NOW)).toMatchObject({ kind: "rejected", reason: "expired" });
  });

  it("accepts a key whose expiry is still in the future", () => {
    const { repo, registry } = setup();
    const { secret, row } = addKey(repo);
    repo.update(row.id, { expiresAt: NOW + HOUR_MS });
    registry.reload();
    expect(registry.resolve(secret, NOW)).toMatchObject({ kind: "ok" });
  });

  it("only sees keys created before the last reload", () => {
    const { repo, registry } = setup();
    registry.reload();
    const { secret } = addKey(repo);
    expect(registry.resolve(secret)).toEqual({ kind: "unknown" });
    registry.reload();
    expect(registry.resolve(secret)).toMatchObject({ kind: "ok" });
  });
});

describe("KeyRegistry quota accounting", () => {
  it("allows a key with no limits", () => {
    const { repo, registry } = setup();
    const { row } = addKey(repo);
    registry.reload();
    registry.recordUsage(row.id, NOW, 1_000_000);
    expect(registry.quotaFor(row.id, NOW)).toEqual({ allowed: true });
  });

  it("blocks once recorded usage reaches the limit", () => {
    const { repo, registry } = setup();
    const { row } = addKey(repo, { limit5h: 100 });
    registry.reload();
    registry.recordUsage(row.id, NOW, 100);
    expect(registry.quotaFor(row.id, NOW)).toMatchObject({
      allowed: false, window: "5h", used: 100, limit: 100,
    });
  });

  it("includes a resetAt in the future when blocked", () => {
    const { repo, registry } = setup();
    const { row } = addKey(repo, { limit5h: 100 });
    registry.reload();
    registry.recordUsage(row.id, NOW, 100);
    const verdict = registry.quotaFor(row.id, NOW);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.resetAt).toBeGreaterThan(NOW);
  });

  it("stops blocking once the window has rolled past the usage", () => {
    const { repo, registry } = setup();
    const { row } = addKey(repo, { limit5h: 100 });
    registry.reload();
    registry.recordUsage(row.id, NOW, 100);
    expect(registry.quotaFor(row.id, NOW + 10 * HOUR_MS)).toEqual({ allowed: true });
  });

  it("keeps usage separate per key", () => {
    const { repo, registry } = setup();
    const a = addKey(repo, { limit5h: 100 });
    const b = addKey(repo, { limit5h: 100 });
    registry.reload();
    registry.recordUsage(a.row.id, NOW, 100);
    expect(registry.quotaFor(a.row.id, NOW).allowed).toBe(false);
    expect(registry.quotaFor(b.row.id, NOW).allowed).toBe(true);
  });

  it("reports usage per window", () => {
    const { repo, registry } = setup();
    const { row } = addKey(repo);
    registry.reload();
    registry.recordUsage(row.id, H - 20 * HOUR_MS, 40);
    registry.recordUsage(row.id, NOW, 2);
    expect(registry.usageFor(row.id, NOW)).toEqual({ "5h": 2, "7d": 42, month: 42 });
  });

  it("allows an unknown key id rather than throwing", () => {
    const { registry } = setup();
    registry.reload();
    expect(registry.quotaFor("ghost", NOW)).toEqual({ allowed: true });
  });
});

describe("KeyRegistry.seed", () => {
  it("rebuilds rings from persisted buckets", () => {
    const { repo, registry } = setup();
    const { row } = addKey(repo, { limit5h: 100 });
    registry.reload();
    registry.seed([{ keyId: row.id, hourStart: H, tokens: 150 }]);
    expect(registry.quotaFor(row.id, NOW).allowed).toBe(false);
  });

  it("ignores buckets for keys that no longer exist", () => {
    const { registry } = setup();
    registry.reload();
    expect(() => registry.seed([{ keyId: "ghost", hourStart: H, tokens: 1 }])).not.toThrow();
  });
});
```

- [ ] **Step 2: Ejecutar el test y comprobar que falla**

Run: `npx vitest run src/__tests__/key-registry.test.ts`
Expected: FAIL — `Cannot find module '../keys/registry.js'`.

- [ ] **Step 3: Implementar**

```typescript
// src/keys/registry.ts
import { timingSafeEqual } from "crypto";
import type { ApiKeyRow, KeysRepo } from "../storage/keys-repo.js";
import { hashKeySecret } from "./key-secret.js";
import { UsageRing } from "./usage-ring.js";
import { checkQuota, limitsOf, type QuotaUsage } from "./quota.js";
import { WINDOW_HOURS, WINDOW_NAMES, type WindowName } from "./windows.js";

export type ResolveResult =
  | { kind: "ok"; key: ApiKeyRow }
  | { kind: "legacy" }
  | { kind: "unknown" }
  | { kind: "rejected"; key: ApiKeyRow; reason: "revoked" | "disabled" | "expired" };

export type QuotaCheck =
  | { allowed: true }
  | { allowed: false; window: WindowName; used: number; limit: number; resetAt: number };

export interface SeedBucket {
  keyId: string;
  hourStart: number;
  tokens: number;
}

export interface KeyRegistryOptions {
  repo: KeysRepo;
  /** The pre-existing shared proxySecret, still honoured as an unlimited key. */
  legacySecret?: string;
}

/**
 * In-memory view of the key table plus per-key usage rings.
 *
 * Every hot-path operation (resolve, quota check, record) is RAM-only. The
 * database is read on reload() and on nothing else.
 */
export class KeyRegistry {
  private byHash = new Map<string, ApiKeyRow>();
  private byId = new Map<string, ApiKeyRow>();
  private readonly rings = new Map<string, UsageRing>();
  private readonly legacyBuf: Buffer | null;

  constructor(private readonly opts: KeyRegistryOptions) {
    this.legacyBuf = opts.legacySecret ? Buffer.from(opts.legacySecret, "utf-8") : null;
  }

  /** Re-read every key from the database. Rings are preserved. */
  reload(): void {
    const rows = this.opts.repo.listAll();
    this.byHash = new Map(rows.map(r => [r.keyHash, r]));
    this.byId = new Map(rows.map(r => [r.id, r]));
  }

  /** Load pre-aggregated buckets, e.g. rebuilt from usage_events at startup. */
  seed(buckets: SeedBucket[]): void {
    for (const b of buckets) {
      if (!this.byId.has(b.keyId)) continue;
      this.ringFor(b.keyId).seed(b.hourStart, b.tokens);
    }
  }

  resolve(presented: string, now: number = Date.now()): ResolveResult {
    if (this.legacyBuf) {
      const buf = Buffer.from(presented, "utf-8");
      if (buf.length === this.legacyBuf.length && timingSafeEqual(buf, this.legacyBuf)) {
        return { kind: "legacy" };
      }
    }

    // Hashing first means lookup time does not depend on how much of a real
    // key the caller guessed right.
    const key = this.byHash.get(hashKeySecret(presented));
    if (!key) return { kind: "unknown" };

    if (key.revokedAt !== null) return { kind: "rejected", key, reason: "revoked" };
    if (!key.enabled) return { kind: "rejected", key, reason: "disabled" };
    if (key.expiresAt !== null && key.expiresAt <= now) {
      return { kind: "rejected", key, reason: "expired" };
    }
    return { kind: "ok", key };
  }

  usageFor(keyId: string, now: number): QuotaUsage {
    const ring = this.rings.get(keyId);
    const usage = {} as QuotaUsage;
    for (const w of WINDOW_NAMES) {
      usage[w] = ring ? ring.sum(now, WINDOW_HOURS[w]) : 0;
    }
    return usage;
  }

  quotaFor(keyId: string, now: number): QuotaCheck {
    const key = this.byId.get(keyId);
    if (!key) return { allowed: true };

    const limits = limitsOf(key);
    const verdict = checkQuota(limits, this.usageFor(keyId, now));
    if (verdict.allowed) return verdict;

    const limit = limits[verdict.window] ?? 0;
    const resetAt = this.ringFor(keyId).resetAt(now, WINDOW_HOURS[verdict.window], limit);
    return { ...verdict, resetAt };
  }

  recordUsage(keyId: string, ts: number, tokens: number): void {
    if (tokens <= 0) return;
    this.ringFor(keyId).add(ts, tokens);
  }

  private ringFor(keyId: string): UsageRing {
    let ring = this.rings.get(keyId);
    if (!ring) {
      ring = new UsageRing();
      this.rings.set(keyId, ring);
    }
    return ring;
  }
}
```

- [ ] **Step 4: Ejecutar el test y comprobar que pasa**

Run: `npx vitest run src/__tests__/key-registry.test.ts`
Expected: PASS, 18 tests.

- [ ] **Step 5: Commit**

```bash
git add src/keys/registry.ts src/__tests__/key-registry.test.ts
git commit -m "feat(keys): add in-memory key registry with quota checks"
```

---

### Task 8: Persistencia de uso y volcado por lotes

**Files:**
- Create: `src/storage/usage-repo.ts`
- Create: `src/keys/usage-writer.ts`
- Test: `src/__tests__/usage-repo.test.ts`
- Test: `src/__tests__/usage-writer.test.ts`

**Interfaces:**
- Consumes: `openDatabase`, `runMigrations` de `src/storage/db.js`; `hourStart`, `HOUR_MS` de `src/keys/windows.js`.
- Produces: el tipo `UsageEventInput`, `billableTokens(e: UsageEventInput): number`, la clase `UsageRepo` con `insertBatch`, `bucketsSince`, `pruneBefore`, `countEvents`; y la clase `UsageWriter` con `enqueue`, `flush`, `start`, `stop`, `buffered`, `dropped`.

- [ ] **Step 1: Escribir el test que falla para `UsageRepo`**

```typescript
// src/__tests__/usage-repo.test.ts
import { describe, it, expect } from "vitest";
import { openDatabase, runMigrations } from "../storage/db.js";
import { UsageRepo, billableTokens, type UsageEventInput } from "../storage/usage-repo.js";
import { HOUR_MS, hourStart } from "../keys/windows.js";

const NOW = Date.UTC(2026, 7, 31, 12, 30, 0, 0);
const H = hourStart(NOW);

function makeRepo(): UsageRepo {
  const db = openDatabase(":memory:");
  runMigrations(db);
  return new UsageRepo(db);
}

function evt(over: Partial<UsageEventInput> = {}): UsageEventInput {
  return {
    ts: NOW,
    keyId: "k1",
    accountId: "acc1",
    model: "claude-sonnet-5",
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 2,
    cacheCreationTokens: 3,
    statusCode: 200,
    durationMs: 1234,
    path: "/v1/messages",
    source: "cli",
    error: null,
    ...over,
  };
}

describe("billableTokens", () => {
  it("sums input, output and both cache counters", () => {
    expect(billableTokens(evt())).toBe(20);
  });

  it("is zero for an event with no tokens", () => {
    expect(billableTokens(evt({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    }))).toBe(0);
  });
});

describe("UsageRepo.insertBatch", () => {
  it("persists every event", () => {
    const repo = makeRepo();
    repo.insertBatch([evt(), evt(), evt()]);
    expect(repo.countEvents()).toBe(3);
  });

  it("accepts an empty batch without touching the database", () => {
    const repo = makeRepo();
    repo.insertBatch([]);
    expect(repo.countEvents()).toBe(0);
  });

  it("rolls up into hourly buckets", () => {
    const repo = makeRepo();
    repo.insertBatch([evt(), evt()]);
    const buckets = repo.bucketsSince(H - HOUR_MS);
    expect(buckets).toEqual([{ keyId: "k1", hourStart: H, tokens: 40 }]);
  });

  it("accumulates into an existing bucket across batches", () => {
    const repo = makeRepo();
    repo.insertBatch([evt()]);
    repo.insertBatch([evt()]);
    expect(repo.bucketsSince(H - HOUR_MS)).toEqual([{ keyId: "k1", hourStart: H, tokens: 40 }]);
  });

  it("separates buckets by hour", () => {
    const repo = makeRepo();
    repo.insertBatch([evt(), evt({ ts: NOW - 2 * HOUR_MS })]);
    expect(repo.bucketsSince(H - 3 * HOUR_MS)).toHaveLength(2);
  });

  it("accepts events with no key, such as the legacy secret", () => {
    const repo = makeRepo();
    repo.insertBatch([evt({ keyId: null })]);
    expect(repo.countEvents()).toBe(1);
    expect(repo.bucketsSince(H - HOUR_MS)).toEqual([]);
  });
});

describe("UsageRepo.bucketsSince", () => {
  it("excludes buckets before the cutoff", () => {
    const repo = makeRepo();
    repo.insertBatch([evt({ ts: NOW - 10 * HOUR_MS })]);
    expect(repo.bucketsSince(H)).toEqual([]);
  });

  it("rebuilds totals from raw events, not from the rollup table", () => {
    const repo = makeRepo();
    repo.insertBatch([evt()]);
    // Corrupt the rollup on purpose; the rebuild path must ignore it.
    repo.rawDb().exec("UPDATE usage_hourly SET tokens = 999999");
    expect(repo.bucketsSince(H - HOUR_MS)).toEqual([{ keyId: "k1", hourStart: H, tokens: 20 }]);
  });
});

describe("UsageRepo.pruneBefore", () => {
  it("deletes events older than the cutoff and reports the count", () => {
    const repo = makeRepo();
    repo.insertBatch([evt({ ts: NOW - 40 * 24 * HOUR_MS }), evt()]);
    expect(repo.pruneBefore(NOW - 35 * 24 * HOUR_MS)).toBe(1);
    expect(repo.countEvents()).toBe(1);
  });

  it("leaves hourly rollups untouched", () => {
    const repo = makeRepo();
    repo.insertBatch([evt({ ts: NOW - 40 * 24 * HOUR_MS })]);
    repo.pruneBefore(NOW);
    const rows = repo.rawDb().prepare("SELECT COUNT(*) AS n FROM usage_hourly").get() as { n: number };
    expect(rows.n).toBe(1);
  });
});
```

- [ ] **Step 2: Ejecutar el test y comprobar que falla**

Run: `npx vitest run src/__tests__/usage-repo.test.ts`
Expected: FAIL — `Cannot find module '../storage/usage-repo.js'`.

- [ ] **Step 3: Implementar `UsageRepo`**

```typescript
// src/storage/usage-repo.ts
import type { DatabaseSync } from "node:sqlite";
import { HOUR_MS } from "../keys/windows.js";

export interface UsageEventInput {
  ts: number;
  /** null for the legacy shared secret, which has no key row. */
  keyId: string | null;
  accountId: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  statusCode: number;
  durationMs: number;
  path: string;
  source: string;
  error?: string | null;
}

export interface UsageBucket {
  keyId: string;
  hourStart: number;
  tokens: number;
}

/** Every token type counts against a quota, cache reads included. */
export function billableTokens(e: UsageEventInput): number {
  return e.inputTokens + e.outputTokens + e.cacheReadTokens + e.cacheCreationTokens;
}

export class UsageRepo {
  constructor(private readonly db: DatabaseSync) {}

  /** Escape hatch for tests and maintenance queries. */
  rawDb(): DatabaseSync {
    return this.db;
  }

  insertBatch(events: UsageEventInput[]): void {
    if (events.length === 0) return;

    const insertEvent = this.db.prepare(`
      INSERT INTO usage_events
        (ts, key_id, account_id, model, input_tokens, output_tokens,
         cache_read_tokens, cache_creation_tokens, status_code, duration_ms,
         path, source, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const upsertHourly = this.db.prepare(`
      INSERT INTO usage_hourly (hour_start, key_id, account_id, model, tokens, requests, errors)
      VALUES (?, ?, ?, ?, ?, 1, ?)
      ON CONFLICT (hour_start, key_id, account_id, model) DO UPDATE SET
        tokens   = tokens + excluded.tokens,
        requests = requests + 1,
        errors   = errors + excluded.errors
    `);

    this.db.exec("BEGIN");
    try {
      for (const e of events) {
        insertEvent.run(
          e.ts, e.keyId, e.accountId, e.model,
          e.inputTokens, e.outputTokens, e.cacheReadTokens, e.cacheCreationTokens,
          e.statusCode, e.durationMs, e.path, e.source, e.error ?? null,
        );
        upsertHourly.run(
          Math.floor(e.ts / HOUR_MS) * HOUR_MS,
          e.keyId ?? "",
          e.accountId,
          e.model,
          billableTokens(e),
          e.statusCode >= 400 ? 1 : 0,
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Per-key hourly totals rebuilt from raw events — the exact source of truth
   * used to repopulate in-memory rings at startup. Deliberately does NOT read
   * usage_hourly, which is a reporting rollup.
   */
  bucketsSince(sinceTs: number): UsageBucket[] {
    const rows = this.db.prepare(`
      SELECT key_id AS keyId,
             (ts / ${HOUR_MS}) * ${HOUR_MS} AS hourStart,
             SUM(input_tokens + output_tokens + cache_read_tokens + cache_creation_tokens) AS tokens
      FROM usage_events
      WHERE ts >= ? AND key_id IS NOT NULL
      GROUP BY key_id, hourStart
      ORDER BY hourStart ASC
    `).all(sinceTs) as { keyId: string; hourStart: number; tokens: number }[];

    return rows.map(r => ({ keyId: r.keyId, hourStart: r.hourStart, tokens: r.tokens }));
  }

  /** Delete raw events older than `beforeTs`. Rollups are kept forever. */
  pruneBefore(beforeTs: number): number {
    const before = this.countEvents();
    this.db.prepare("DELETE FROM usage_events WHERE ts < ?").run(beforeTs);
    return before - this.countEvents();
  }

  countEvents(): number {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM usage_events").get() as { n: number };
    return row.n;
  }
}
```

- [ ] **Step 4: Ejecutar el test y comprobar que pasa**

Run: `npx vitest run src/__tests__/usage-repo.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Escribir el test que falla para `UsageWriter`**

```typescript
// src/__tests__/usage-writer.test.ts
import { describe, it, expect, vi } from "vitest";
import { UsageWriter } from "../keys/usage-writer.js";
import type { UsageEventInput } from "../storage/usage-repo.js";

function evt(ts = 1): UsageEventInput {
  return {
    ts, keyId: "k1", accountId: "a", model: "m",
    inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0,
    statusCode: 200, durationMs: 1, path: "/v1/messages", source: "cli", error: null,
  };
}

function fakeRepo() {
  const batches: UsageEventInput[][] = [];
  return {
    batches,
    insertBatch: (events: UsageEventInput[]) => { batches.push(events); },
  };
}

describe("UsageWriter.enqueue / flush", () => {
  it("buffers without writing", () => {
    const repo = fakeRepo();
    const w = new UsageWriter(repo);
    w.enqueue(evt());
    expect(repo.batches).toHaveLength(0);
    expect(w.buffered()).toBe(1);
  });

  it("writes the whole buffer on flush", () => {
    const repo = fakeRepo();
    const w = new UsageWriter(repo);
    w.enqueue(evt(1));
    w.enqueue(evt(2));
    w.flush();
    expect(repo.batches).toEqual([[evt(1), evt(2)]]);
    expect(w.buffered()).toBe(0);
  });

  it("does not call the repo when the buffer is empty", () => {
    const repo = fakeRepo();
    new UsageWriter(repo).flush();
    expect(repo.batches).toHaveLength(0);
  });
});

describe("UsageWriter overflow", () => {
  it("drops the oldest events past the cap", () => {
    const repo = fakeRepo();
    const w = new UsageWriter(repo, { maxBuffered: 2 });
    w.enqueue(evt(1));
    w.enqueue(evt(2));
    w.enqueue(evt(3));
    w.flush();
    expect(repo.batches[0]).toEqual([evt(2), evt(3)]);
    expect(w.dropped()).toBe(1);
  });
});

describe("UsageWriter failure handling", () => {
  it("keeps events buffered when the write fails", () => {
    const w = new UsageWriter({ insertBatch: () => { throw new Error("disk full"); } });
    w.enqueue(evt());
    w.flush();
    expect(w.buffered()).toBe(1);
  });

  it("reports the failure without throwing", () => {
    const onError = vi.fn();
    const w = new UsageWriter({ insertBatch: () => { throw new Error("disk full"); } }, { onError });
    w.enqueue(evt());
    expect(() => w.flush()).not.toThrow();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("retries the same events on the next flush", () => {
    let fail = true;
    const batches: UsageEventInput[][] = [];
    const w = new UsageWriter({
      insertBatch: (e: UsageEventInput[]) => {
        if (fail) throw new Error("transient");
        batches.push(e);
      },
    }, { onError: () => {} });
    w.enqueue(evt(7));
    w.flush();
    fail = false;
    w.flush();
    expect(batches).toEqual([[evt(7)]]);
  });
});

describe("UsageWriter timer", () => {
  it("flushes on the interval and stops cleanly", () => {
    vi.useFakeTimers();
    const repo = fakeRepo();
    const w = new UsageWriter(repo, { flushIntervalMs: 1000 });
    w.start();
    w.enqueue(evt());
    vi.advanceTimersByTime(1000);
    expect(repo.batches).toHaveLength(1);
    w.stop();
    w.enqueue(evt());
    vi.advanceTimersByTime(5000);
    expect(repo.batches).toHaveLength(1);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 6: Ejecutar el test y comprobar que falla**

Run: `npx vitest run src/__tests__/usage-writer.test.ts`
Expected: FAIL — `Cannot find module '../keys/usage-writer.js'`.

- [ ] **Step 7: Implementar `UsageWriter`**

```typescript
// src/keys/usage-writer.ts
import type { UsageEventInput } from "../storage/usage-repo.js";

/** Minimal surface the writer needs, so tests can pass a fake. */
export interface UsageSink {
  insertBatch(events: UsageEventInput[]): void;
}

export interface UsageWriterOptions {
  flushIntervalMs?: number;
  maxBuffered?: number;
  onError?: (err: Error) => void;
}

const DEFAULT_FLUSH_MS = 5_000;
const DEFAULT_MAX_BUFFERED = 5_000;

/**
 * Batches usage events off the request path.
 *
 * Accounting must never take the proxy down: a failed write keeps its events
 * buffered for the next attempt, and the buffer is capped — past the cap the
 * oldest events are dropped rather than growing memory without bound.
 */
export class UsageWriter {
  private buffer: UsageEventInput[] = [];
  private timer: NodeJS.Timeout | null = null;
  private droppedCount = 0;

  private readonly flushIntervalMs: number;
  private readonly maxBuffered: number;
  private readonly onError: (err: Error) => void;

  constructor(private readonly sink: UsageSink, opts: UsageWriterOptions = {}) {
    this.flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_MS;
    this.maxBuffered = opts.maxBuffered ?? DEFAULT_MAX_BUFFERED;
    this.onError = opts.onError ?? (() => {});
  }

  enqueue(event: UsageEventInput): void {
    this.buffer.push(event);
    this.trim();
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      this.sink.insertBatch(batch);
    } catch (err) {
      // Put them back at the front and let the cap decide what survives.
      this.buffer = [...batch, ...this.buffer];
      this.trim();
      this.onError(err as Error);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), this.flushIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  buffered(): number {
    return this.buffer.length;
  }

  dropped(): number {
    return this.droppedCount;
  }

  private trim(): void {
    const overflow = this.buffer.length - this.maxBuffered;
    if (overflow > 0) {
      this.buffer.splice(0, overflow);
      this.droppedCount += overflow;
    }
  }
}
```

- [ ] **Step 8: Ejecutar los dos tests y comprobar que pasan**

Run: `npx vitest run src/__tests__/usage-repo.test.ts src/__tests__/usage-writer.test.ts`
Expected: PASS, 20 tests en total.

- [ ] **Step 9: Commit**

```bash
git add src/storage/usage-repo.ts src/keys/usage-writer.ts src/__tests__/usage-repo.test.ts src/__tests__/usage-writer.test.ts
git commit -m "feat(storage): add usage event persistence and batched writer"
```

---
### Task 9: Middleware de autenticación por key

**Files:**
- Create: `src/proxy/auth-middleware.ts`
- Test: `src/__tests__/key-auth-middleware.test.ts`

**Interfaces:**
- Consumes: `KeyRegistry`, `QuotaCheck` de `src/keys/registry.js`.
- Produces: `extractPresentedSecret(headers): string`, `createKeyAuthMiddleware(opts: KeyAuthOptions): RequestHandler`, y el tipo `KeyAuthOptions`.

Este es el único punto donde se decide si una petición entra. Los tests son unitarios con `req`/`res` falsos: el repo no usa supertest y no vamos a añadir dependencias.

- [ ] **Step 1: Escribir el test que falla**

```typescript
// src/__tests__/key-auth-middleware.test.ts
import { describe, it, expect, vi } from "vitest";
import { openDatabase, runMigrations } from "../storage/db.js";
import { KeysRepo } from "../storage/keys-repo.js";
import { KeyRegistry } from "../keys/registry.js";
import { generateKeySecret } from "../keys/key-secret.js";
import { createKeyAuthMiddleware, extractPresentedSecret } from "../proxy/auth-middleware.js";

const NOW = Date.UTC(2026, 7, 31, 12, 30, 0, 0);

function fakeRes() {
  const res: any = {
    statusCode: 0,
    body: undefined as unknown,
    headers: {} as Record<string, string | number>,
    status(code: number) { res.statusCode = code; return res; },
    json(payload: unknown) { res.body = payload; return res; },
    set(name: string, value: string | number) { res.headers[name.toLowerCase()] = value; return res; },
  };
  return res;
}

function fakeReq(headers: Record<string, string>, path = "/v1/messages") {
  return { headers, path } as any;
}

function setup(opts: { legacySecret?: string; limit5h?: number | null } = {}) {
  const db = openDatabase(":memory:");
  runMigrations(db);
  const repo = new KeysRepo(db);
  const secret = generateKeySecret();
  const row = repo.create({ name: "k", owner: "v", limit5h: opts.limit5h ?? null }, secret, NOW);
  const registry = new KeyRegistry({ repo, legacySecret: opts.legacySecret });
  registry.reload();
  const mw = createKeyAuthMiddleware({ registry, now: () => NOW });
  return { repo, registry, mw, secret: secret.secret, row };
}

describe("extractPresentedSecret", () => {
  it("reads a Bearer token", () => {
    expect(extractPresentedSecret({ authorization: "Bearer abc" })).toBe("abc");
  });

  it("reads x-api-key", () => {
    expect(extractPresentedSecret({ "x-api-key": "abc" })).toBe("abc");
  });

  it("prefers the Bearer token when both are present", () => {
    expect(extractPresentedSecret({ authorization: "Bearer a", "x-api-key": "b" })).toBe("a");
  });

  it("returns an empty string when neither is present", () => {
    expect(extractPresentedSecret({})).toBe("");
  });

  it("ignores a non-Bearer Authorization scheme", () => {
    expect(extractPresentedSecret({ authorization: "Basic abc" })).toBe("");
  });
});

describe("key auth middleware — accepting", () => {
  it("calls next for a valid key", () => {
    const { mw, secret } = setup();
    const next = vi.fn();
    mw(fakeReq({ authorization: `Bearer ${secret}` }), fakeRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("attaches the key id to the request", () => {
    const { mw, secret, row } = setup();
    const req = fakeReq({ authorization: `Bearer ${secret}` });
    mw(req, fakeRes(), vi.fn());
    expect(req._ccKeyId).toBe(row.id);
  });

  it("accepts the key via x-api-key too", () => {
    const { mw, secret } = setup();
    const next = vi.fn();
    mw(fakeReq({ "x-api-key": secret }), fakeRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("exempts the health endpoint", () => {
    const { mw } = setup();
    const next = vi.fn();
    mw(fakeReq({}, "/cc-router/health"), fakeRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("key auth middleware — legacy proxySecret regression", () => {
  // The shared secret predates keys. Users have it in their Claude Code config;
  // an upgrade that silently stops honouring it would lock them out.
  it("still accepts the pre-existing proxySecret", () => {
    const { mw } = setup({ legacySecret: "cc-rtr-old" });
    const next = vi.fn();
    mw(fakeReq({ authorization: "Bearer cc-rtr-old" }), fakeRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("leaves the key id unset for legacy requests", () => {
    const { mw } = setup({ legacySecret: "cc-rtr-old" });
    const req = fakeReq({ authorization: "Bearer cc-rtr-old" });
    mw(req, fakeRes(), vi.fn());
    expect(req._ccKeyId).toBeNull();
  });

  it("never applies a quota to the legacy secret", () => {
    const { mw } = setup({ legacySecret: "cc-rtr-old", limit5h: 0 });
    const next = vi.fn();
    mw(fakeReq({ authorization: "Bearer cc-rtr-old" }), fakeRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });
});

describe("key auth middleware — rejecting with 401", () => {
  it("rejects an unknown secret", () => {
    const { mw } = setup();
    const res = fakeRes();
    const next = vi.fn();
    mw(fakeReq({ authorization: "Bearer nope" }), res, next);
    expect(res.statusCode).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects a missing secret", () => {
    const { mw } = setup();
    const res = fakeRes();
    mw(fakeReq({}), res, vi.fn());
    expect(res.statusCode).toBe(401);
  });

  it("uses the Anthropic error envelope", () => {
    const { mw } = setup();
    const res = fakeRes();
    mw(fakeReq({ authorization: "Bearer nope" }), res, vi.fn());
    expect(res.body).toMatchObject({ type: "error", error: { type: "authentication_error" } });
  });

  it("rejects a revoked key", () => {
    const { repo, registry, mw, secret, row } = setup();
    repo.revoke(row.id, NOW);
    registry.reload();
    const res = fakeRes();
    mw(fakeReq({ authorization: `Bearer ${secret}` }), res, vi.fn());
    expect(res.statusCode).toBe(401);
  });
});

describe("key auth middleware — rejecting with 429", () => {
  it("blocks a key whose quota is exhausted", () => {
    const { registry, mw, secret, row } = setup({ limit5h: 100 });
    registry.recordUsage(row.id, NOW, 100);
    const res = fakeRes();
    const next = vi.fn();
    mw(fakeReq({ authorization: `Bearer ${secret}` }), res, next);
    expect(res.statusCode).toBe(429);
    expect(next).not.toHaveBeenCalled();
  });

  it("uses the Anthropic rate-limit error envelope", () => {
    const { registry, mw, secret, row } = setup({ limit5h: 100 });
    registry.recordUsage(row.id, NOW, 100);
    const res = fakeRes();
    mw(fakeReq({ authorization: `Bearer ${secret}` }), res, vi.fn());
    expect(res.body).toMatchObject({ type: "error", error: { type: "rate_limit_error" } });
  });

  it("sets retry-after to at least one second", () => {
    const { registry, mw, secret, row } = setup({ limit5h: 100 });
    registry.recordUsage(row.id, NOW, 100);
    const res = fakeRes();
    mw(fakeReq({ authorization: `Bearer ${secret}` }), res, vi.fn());
    expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
  });

  it("reports which window, how much was used and the ceiling", () => {
    const { registry, mw, secret, row } = setup({ limit5h: 100 });
    registry.recordUsage(row.id, NOW, 120);
    const res = fakeRes();
    mw(fakeReq({ authorization: `Bearer ${secret}` }), res, vi.fn());
    expect(res.headers["x-ccrouter-quota-window"]).toBe("5h");
    expect(res.headers["x-ccrouter-quota-used"]).toBe(120);
    expect(res.headers["x-ccrouter-quota-limit"]).toBe(100);
    expect(Number(res.headers["x-ccrouter-quota-reset"])).toBeGreaterThan(NOW / 1000);
  });
});

describe("key auth middleware — degraded mode", () => {
  it("falls back to the legacy secret when there is no registry", () => {
    const mw = createKeyAuthMiddleware({ registry: null, legacySecret: "cc-rtr-old", now: () => NOW });
    const next = vi.fn();
    mw(fakeReq({ authorization: "Bearer cc-rtr-old" }), fakeRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("rejects a wrong secret when there is no registry", () => {
    const mw = createKeyAuthMiddleware({ registry: null, legacySecret: "cc-rtr-old", now: () => NOW });
    const res = fakeRes();
    mw(fakeReq({ authorization: "Bearer wrong" }), res, vi.fn());
    expect(res.statusCode).toBe(401);
  });

  it("allows everything when there is neither registry nor secret, as today", () => {
    const mw = createKeyAuthMiddleware({ registry: null, now: () => NOW });
    const next = vi.fn();
    mw(fakeReq({}), fakeRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Ejecutar el test y comprobar que falla**

Run: `npx vitest run src/__tests__/key-auth-middleware.test.ts`
Expected: FAIL — `Cannot find module '../proxy/auth-middleware.js'`.

- [ ] **Step 3: Implementar**

```typescript
// src/proxy/auth-middleware.ts
import { timingSafeEqual } from "crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";
import type { KeyRegistry } from "../keys/registry.js";

declare module "express-serve-static-core" {
  interface Request {
    /** Id of the API key that authenticated this request; null for the legacy secret. */
    _ccKeyId?: string | null;
  }
}

export interface KeyAuthOptions {
  /** null puts the middleware in degraded mode: legacy secret only, no quotas. */
  registry: KeyRegistry | null;
  legacySecret?: string;
  /** Paths that never require authentication. Defaults to the health endpoint. */
  exemptPaths?: string[];
  now?: () => number;
}

const DEFAULT_EXEMPT = ["/cc-router/health"];

/** Accepts both shapes Claude Code and the Anthropic SDKs send. */
export function extractPresentedSecret(headers: Record<string, unknown>): string {
  const auth = String(headers["authorization"] ?? "");
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  const apiKey = headers["x-api-key"];
  return typeof apiKey === "string" ? apiKey : "";
}

function unauthorized(res: Response, message: string): void {
  res.status(401).json({
    type: "error",
    error: { type: "authentication_error", message },
  });
}

function secretMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf-8");
  const b = Buffer.from(expected, "utf-8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createKeyAuthMiddleware(opts: KeyAuthOptions): RequestHandler {
  const exempt = new Set(opts.exemptPaths ?? DEFAULT_EXEMPT);
  const now = opts.now ?? (() => Date.now());

  return (req: Request, res: Response, next: NextFunction): void => {
    if (exempt.has(req.path)) return next();

    const presented = extractPresentedSecret(req.headers as Record<string, unknown>);

    // Degraded mode — SQLite unavailable. Behave exactly like the pre-keys proxy
    // so a storage failure never locks anyone out of a working router.
    if (!opts.registry) {
      if (!opts.legacySecret) return next();
      if (secretMatches(presented, opts.legacySecret)) {
        req._ccKeyId = null;
        return next();
      }
      return unauthorized(res, "Invalid or missing proxy authentication token");
    }

    const resolved = opts.registry.resolve(presented, now());

    if (resolved.kind === "legacy") {
      req._ccKeyId = null;
      return next();
    }
    if (resolved.kind === "unknown") {
      return unauthorized(res, "Invalid or missing proxy authentication token");
    }
    if (resolved.kind === "rejected") {
      return unauthorized(res, `API key ${resolved.reason}`);
    }

    const quota = opts.registry.quotaFor(resolved.key.id, now());
    if (!quota.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil((quota.resetAt - now()) / 1000));
      res.set("retry-after", String(retryAfterSec));
      res.set("x-ccrouter-quota-window", quota.window);
      res.set("x-ccrouter-quota-used", quota.used);
      res.set("x-ccrouter-quota-limit", quota.limit);
      res.set("x-ccrouter-quota-reset", Math.ceil(quota.resetAt / 1000));
      res.status(429).json({
        type: "error",
        error: {
          type: "rate_limit_error",
          message:
            `Key quota exhausted for the ${quota.window} window ` +
            `(${quota.used}/${quota.limit} tokens). Retry in ${retryAfterSec}s.`,
        },
      });
      return;
    }

    req._ccKeyId = resolved.key.id;
    next();
  };
}
```

Nota sobre los tests: `res.set` recibe números en algunas cabeceras y el objeto falso los guarda tal cual, por eso las aserciones comparan contra números. Express los serializa a string en producción.

- [ ] **Step 4: Ejecutar el test y comprobar que pasa**

Run: `npx vitest run src/__tests__/key-auth-middleware.test.ts`
Expected: PASS, 23 tests.

- [ ] **Step 5: Commit**

```bash
git add src/proxy/auth-middleware.ts src/__tests__/key-auth-middleware.test.ts
git commit -m "feat(proxy): add per-key auth middleware with quota enforcement"
```

---

### Task 10: Arranque del subsistema y modo degradado

**Files:**
- Create: `src/keys/bootstrap.ts`
- Test: `src/__tests__/keys-bootstrap.test.ts`

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: el tipo `KeysSubsystem` y `createKeysSubsystem(opts: BootstrapOptions): KeysSubsystem`.

El objetivo de aislar esto en su propio módulo es que **el modo degradado sea testeable**: es la garantía de que un fallo de SQLite no tumba el proxy, y no quiero que dependa de leer `server.ts`.

- [ ] **Step 1: Escribir el test que falla**

```typescript
// src/__tests__/keys-bootstrap.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createKeysSubsystem } from "../keys/bootstrap.js";
import { openDatabase, runMigrations } from "../storage/db.js";
import { KeysRepo } from "../storage/keys-repo.js";
import { UsageRepo } from "../storage/usage-repo.js";
import { generateKeySecret } from "../keys/key-secret.js";
import { HOUR_MS } from "../keys/windows.js";

const NOW = Date.UTC(2026, 7, 31, 12, 30, 0, 0);
const dirs: string[] = [];

function tmpPath(name = "router.db"): string {
  const dir = mkdtempSync(join(tmpdir(), "ccr-boot-"));
  dirs.push(dir);
  return join(dir, name);
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("createKeysSubsystem — healthy", () => {
  it("comes up not degraded", () => {
    const sub = createKeysSubsystem({ dbPath: tmpPath(), now: () => NOW });
    expect(sub.degraded).toBe(false);
    expect(sub.registry).not.toBeNull();
    sub.shutdown();
  });

  it("creates the database file and applies migrations", () => {
    const path = tmpPath();
    const sub = createKeysSubsystem({ dbPath: path, now: () => NOW });
    sub.shutdown();
    const db = openDatabase(path);
    expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get()).toMatchObject({ n: 1 });
    db.close();
  });

  it("loads existing keys into the registry", () => {
    const path = tmpPath();
    const db = openDatabase(path);
    runMigrations(db);
    const secret = generateKeySecret();
    new KeysRepo(db).create({ name: "k", owner: "v" }, secret, NOW);
    db.close();

    const sub = createKeysSubsystem({ dbPath: path, now: () => NOW });
    expect(sub.registry!.resolve(secret.secret, NOW)).toMatchObject({ kind: "ok" });
    sub.shutdown();
  });

  it("rebuilds usage rings from persisted events", () => {
    const path = tmpPath();
    const db = openDatabase(path);
    runMigrations(db);
    const secret = generateKeySecret();
    const row = new KeysRepo(db).create({ name: "k", owner: "v", limit5h: 100 }, secret, NOW);
    new UsageRepo(db).insertBatch([{
      ts: NOW - HOUR_MS, keyId: row.id, accountId: "a", model: "m",
      inputTokens: 150, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      statusCode: 200, durationMs: 1, path: "/v1/messages", source: "cli", error: null,
    }]);
    db.close();

    const sub = createKeysSubsystem({ dbPath: path, now: () => NOW });
    expect(sub.registry!.quotaFor(row.id, NOW).allowed).toBe(false);
    sub.shutdown();
  });

  it("prunes events past the retention horizon on startup", () => {
    const path = tmpPath();
    const db = openDatabase(path);
    runMigrations(db);
    new UsageRepo(db).insertBatch([{
      ts: NOW - 40 * 24 * HOUR_MS, keyId: null, accountId: "a", model: "m",
      inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      statusCode: 200, durationMs: 1, path: "/v1/messages", source: "cli", error: null,
    }]);
    db.close();

    const sub = createKeysSubsystem({ dbPath: path, now: () => NOW });
    expect(sub.usageRepo!.countEvents()).toBe(0);
    sub.shutdown();
  });
});

describe("createKeysSubsystem — degraded", () => {
  it("degrades instead of throwing when the database cannot be opened", () => {
    const path = tmpPath();
    writeFileSync(path, "this is not a sqlite database");
    const sub = createKeysSubsystem({ dbPath: path, now: () => NOW });
    expect(sub.degraded).toBe(true);
    expect(sub.registry).toBeNull();
    sub.shutdown();
  });

  it("explains why it degraded", () => {
    const path = tmpPath();
    writeFileSync(path, "not sqlite");
    const sub = createKeysSubsystem({ dbPath: path, now: () => NOW });
    expect(sub.degradedReason).toBeTruthy();
    sub.shutdown();
  });

  it("reports the failure through onError rather than throwing", () => {
    const onError = vi.fn();
    const path = tmpPath();
    writeFileSync(path, "not sqlite");
    expect(() => createKeysSubsystem({ dbPath: path, now: () => NOW, onError })).not.toThrow();
    expect(onError).toHaveBeenCalled();
  });

  it("shuts down cleanly even when degraded", () => {
    const path = tmpPath();
    writeFileSync(path, "not sqlite");
    const sub = createKeysSubsystem({ dbPath: path, now: () => NOW });
    expect(() => sub.shutdown()).not.toThrow();
  });
});
```

- [ ] **Step 2: Ejecutar el test y comprobar que falla**

Run: `npx vitest run src/__tests__/keys-bootstrap.test.ts`
Expected: FAIL — `Cannot find module '../keys/bootstrap.js'`.

- [ ] **Step 3: Implementar**

```typescript
// src/keys/bootstrap.ts
import type { DatabaseSync } from "node:sqlite";
import { closeDatabase, openDatabase, runMigrations } from "../storage/db.js";
import { KeysRepo } from "../storage/keys-repo.js";
import { UsageRepo } from "../storage/usage-repo.js";
import { KeyRegistry } from "./registry.js";
import { UsageWriter } from "./usage-writer.js";
import { HOUR_MS, RETENTION_HOURS } from "./windows.js";

export interface BootstrapOptions {
  dbPath: string;
  /** Existing shared proxySecret, honoured as an unlimited legacy key. */
  legacySecret?: string;
  now?: () => number;
  onError?: (err: Error) => void;
  flushIntervalMs?: number;
}

export interface KeysSubsystem {
  registry: KeyRegistry | null;
  writer: UsageWriter | null;
  keysRepo: KeysRepo | null;
  usageRepo: UsageRepo | null;
  /** True when storage failed: the proxy still serves, without quotas. */
  degraded: boolean;
  degradedReason?: string;
  shutdown(): void;
}

function degrade(reason: string, onError?: (err: Error) => void): KeysSubsystem {
  onError?.(new Error(reason));
  return {
    registry: null,
    writer: null,
    keysRepo: null,
    usageRepo: null,
    degraded: true,
    degradedReason: reason,
    shutdown() { /* nothing was opened */ },
  };
}

/**
 * Open storage, hydrate the in-memory registry and start the batch writer.
 *
 * Any storage failure degrades instead of throwing: the proxy must keep
 * routing requests even when quota accounting is unavailable.
 */
export function createKeysSubsystem(opts: BootstrapOptions): KeysSubsystem {
  const now = opts.now ?? (() => Date.now());

  let db: DatabaseSync;
  try {
    db = openDatabase(opts.dbPath);
    runMigrations(db);
  } catch (err) {
    return degrade(`keys storage unavailable: ${(err as Error).message}`, opts.onError);
  }

  try {
    const keysRepo = new KeysRepo(db);
    const usageRepo = new UsageRepo(db);

    const retentionMs = RETENTION_HOURS * HOUR_MS;
    usageRepo.pruneBefore(now() - retentionMs);

    const registry = new KeyRegistry({ repo: keysRepo, legacySecret: opts.legacySecret });
    registry.reload();
    registry.seed(usageRepo.bucketsSince(now() - retentionMs));

    const writer = new UsageWriter(usageRepo, {
      flushIntervalMs: opts.flushIntervalMs,
      onError: opts.onError,
    });
    writer.start();

    return {
      registry,
      writer,
      keysRepo,
      usageRepo,
      degraded: false,
      shutdown() {
        writer.stop();
        writer.flush();
        closeDatabase(db);
      },
    };
  } catch (err) {
    try { closeDatabase(db); } catch { /* already failing */ }
    return degrade(`keys subsystem failed to start: ${(err as Error).message}`, opts.onError);
  }
}
```

- [ ] **Step 4: Ejecutar el test y comprobar que pasa**

Run: `npx vitest run src/__tests__/keys-bootstrap.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/keys/bootstrap.ts src/__tests__/keys-bootstrap.test.ts
git commit -m "feat(keys): add subsystem bootstrap with degraded-mode fallback"
```

---

### Task 11: Cableado en el proxy

**Files:**
- Modify: `src/proxy/server.ts:296-320` (sustituir el middleware de `proxySecret`)
- Modify: `src/proxy/server.ts:30-33` (ampliar la augmentación de `Request`)
- Modify: `src/proxy/server.ts:705-770` (atribuir el `usage` a la key)

**Interfaces:**
- Consumes: `createKeysSubsystem` de `src/keys/bootstrap.js`; `createKeyAuthMiddleware` de `src/proxy/auth-middleware.js`.
- Produces: nada nuevo. Es integración.

Sin test propio: las garantías están cubiertas por las tareas 9 y 10. Lo que se verifica aquí es que **la suite existente sigue verde**, es decir, que la integración no ha roto nada.

- [ ] **Step 1: Ampliar la augmentación de `Request`**

En `src/proxy/server.ts`, dentro del bloque `declare module "express-serve-static-core"` que empieza en la línea 30, añadir junto a `_ccAccount`:

```typescript
    _ccKeyId?: string | null;
```

- [ ] **Step 2: Añadir los imports**

Junto al resto de imports de `src/proxy/server.ts`:

```typescript
import { createKeysSubsystem } from "../keys/bootstrap.js";
import { createKeyAuthMiddleware } from "./auth-middleware.js";
import { DB_PATH } from "../config/paths.js";
```

- [ ] **Step 3: Arrancar el subsistema antes de montar middlewares**

En `startServer`, justo después de la línea `const { proxySecret } = initialConfig;` (**no** después de `const app = express();`: `proxySecret` se declara más abajo y referenciarlo antes lanza un `ReferenceError` por zona muerta temporal):

```typescript
  // Keys and quotas. A storage failure degrades to legacy-secret auth rather
  // than taking the proxy down.
  const keys = createKeysSubsystem({
    dbPath: DB_PATH,
    legacySecret: proxySecret,
    onError: (err) => logError("keys", 0, err.message),
  });
  if (keys.degraded) {
    console.warn(chalk.yellow(`⚠ ${keys.degradedReason} — running without key quotas`));
  }
```

- [ ] **Step 4: Sustituir el middleware de auth**

Reemplazar el bloque `if (proxySecret) { app.use(...) }` completo (líneas 296-320) por:

```typescript
  app.use(createKeyAuthMiddleware({
    registry: keys.registry,
    legacySecret: proxySecret,
  }));
```

- [ ] **Step 5: Atribuir el consumo a la key**

En el handler `proxyRes`, inmediatamente después de `stats.addLog(entry);`, añadir:

```typescript
        // Attribute this request to its key. Both calls are in-memory; the
        // writer flushes to SQLite on its own interval, off the request path.
        const keyId = (req as Request)._ccKeyId ?? null;
        if (keys.registry || keys.writer) {
          const inputTokens = entry.inputTokens ?? 0;
          const outputTokens = entry.outputTokens ?? 0;
          const cacheReadTokens = entry.cacheReadTokens ?? 0;
          const cacheCreationTokens = entry.cacheCreationTokens ?? 0;
          const tokens = inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens;
          if (keyId && keys.registry) keys.registry.recordUsage(keyId, entry.ts, tokens);
          keys.writer?.enqueue({
            ts: entry.ts,
            keyId,
            accountId: entry.accountId,
            model: entry.model,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheCreationTokens,
            statusCode: entry.statusCode ?? 0,
            durationMs: entry.durationMs ?? 0,
            path: entry.path ?? "",
            source: entry.source ?? "",
            error: entry.type === "error" ? (entry.details ?? null) : null,
          });
        }
```

**Importante:** los tokens del `usage` se rellenan de forma asíncrona mientras se drena el cuerpo de la respuesta, así que este bloque debe ir en el mismo punto donde ya se hace `stats.addLog(entry)` y **después** de la lógica de parseo del stream, para que `entry` lleve ya los contadores. Si al ejecutarlo ves ceros, muévelo al final del callback que cierra el stream, donde se completa `applyOutputUsage`.

- [ ] **Step 6: Cerrar limpiamente**

Donde el servidor gestione el apagado (o al final de `startServer`, junto al listener), registrar:

```typescript
  process.once("SIGTERM", () => keys.shutdown());
  process.once("SIGINT", () => keys.shutdown());
```

- [ ] **Step 7: Comprobar tipos y suite completa**

Run: `npm run lint && npm test`
Expected: `tsc --noEmit` sin errores y toda la suite en verde, incluidos los tests preexistentes de `server-health-accounts` y `accounts-api`.

- [ ] **Step 8: Commit**

```bash
git add src/proxy/server.ts
git commit -m "feat(proxy): wire key auth and usage accounting into the server"
```

---

### Task 12: Comando `cc-router keys`

**Files:**
- Create: `src/cli/cmd-keys.ts`
- Modify: `src/cli/index.ts`

**Interfaces:**
- Consumes: `createKeysSubsystem`, `KeysRepo`, `generateKeySecret`, `formatKeyDisplay`.
- Produces: `registerKeys(program: Command): void`, siguiendo el patrón de `registerAccounts`.

Sin tests: es una capa de presentación sobre lógica ya cubierta, y `vitest.config.ts` excluye `src/cli/**` de la cobertura por esa misma razón.

- [ ] **Step 1: Implementar el comando**

```typescript
// src/cli/cmd-keys.ts
import type { Command } from "commander";
import chalk from "chalk";
import { openDatabase, runMigrations, closeDatabase } from "../storage/db.js";
import { KeysRepo } from "../storage/keys-repo.js";
import { generateKeySecret, formatKeyDisplay } from "../keys/key-secret.js";
import { DB_PATH } from "../config/paths.js";

function withRepo<T>(fn: (repo: KeysRepo) => T): T {
  const db = openDatabase(DB_PATH);
  runMigrations(db);
  try {
    return fn(new KeysRepo(db));
  } finally {
    closeDatabase(db);
  }
}

function parseLimit(value: string | undefined): number | null {
  if (value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    console.error(chalk.red(`✗ Invalid limit: ${value}`));
    process.exit(1);
  }
  return Math.floor(n);
}

export function registerKeys(program: Command): void {
  const keys = program.command("keys").description("Manage API keys and their token quotas");

  keys
    .command("list")
    .description("List every API key")
    .action(() => {
      withRepo(repo => {
        const rows = repo.listAll();
        if (rows.length === 0) {
          console.log(chalk.yellow("\nNo keys yet. Create one with: cc-router keys create <name>\n"));
          return;
        }
        console.log("");
        for (const k of rows) {
          const state = k.revokedAt ? chalk.red("revoked") : k.enabled ? chalk.green("active") : chalk.yellow("disabled");
          const quota = [
            k.limit5h !== null ? `5h:${k.limit5h}` : null,
            k.limit7d !== null ? `7d:${k.limit7d}` : null,
            k.limitMonth !== null ? `30d:${k.limitMonth}` : null,
          ].filter(Boolean).join(" ") || "unlimited";
          console.log(
            `  ${chalk.cyan(formatKeyDisplay(k.keyPrefix, k.keyLast4).padEnd(16))} ` +
            `${k.name.padEnd(20)} ${chalk.gray(k.owner.padEnd(14))} ${state}  ${chalk.gray(quota)}`,
          );
        }
        console.log("");
      });
    });

  keys
    .command("create <name>")
    .description("Create an API key")
    .option("--owner <owner>", "Who this key belongs to", "")
    .option("--limit-5h <tokens>", "Token ceiling for the 5-hour window")
    .option("--limit-7d <tokens>", "Token ceiling for the 7-day window")
    .option("--limit-month <tokens>", "Token ceiling for the 30-day window")
    .action((name: string, opts: Record<string, string | undefined>) => {
      withRepo(repo => {
        const secret = generateKeySecret();
        const row = repo.create({
          name,
          owner: opts["owner"] ?? "",
          limit5h: parseLimit(opts["limit5h"]),
          limit7d: parseLimit(opts["limit7d"]),
          limitMonth: parseLimit(opts["limitMonth"]),
        }, secret, Date.now());

        console.log(chalk.green(`\n✓ Key "${row.name}" created.\n`));
        console.log(`  ${chalk.bold(secret.secret)}\n`);
        console.log(chalk.yellow("  This is the only time the key is shown. Store it now.\n"));
      });
    });

  keys
    .command("revoke <id>")
    .description("Revoke an API key permanently")
    .action((id: string) => {
      withRepo(repo => {
        if (!repo.revoke(id, Date.now())) {
          console.error(chalk.red(`\n✗ No key with id ${id}\n`));
          process.exit(1);
        }
        console.log(chalk.green(`\n✓ Key ${id} revoked.\n`));
      });
    });

  keys
    .command("limit <id>")
    .description("Change the quotas of an existing key")
    .option("--limit-5h <tokens>", "Token ceiling for the 5-hour window")
    .option("--limit-7d <tokens>", "Token ceiling for the 7-day window")
    .option("--limit-month <tokens>", "Token ceiling for the 30-day window")
    .action((id: string, opts: Record<string, string | undefined>) => {
      withRepo(repo => {
        const patch: Record<string, number | null> = {};
        if (opts["limit5h"] !== undefined) patch["limit5h"] = parseLimit(opts["limit5h"]);
        if (opts["limit7d"] !== undefined) patch["limit7d"] = parseLimit(opts["limit7d"]);
        if (opts["limitMonth"] !== undefined) patch["limitMonth"] = parseLimit(opts["limitMonth"]);

        if (!repo.update(id, patch)) {
          console.error(chalk.red(`\n✗ No key with id ${id}\n`));
          process.exit(1);
        }
        console.log(chalk.green(`\n✓ Quotas updated for ${id}.`));
        console.log(chalk.gray("  Restart the proxy for the change to take effect.\n"));
      });
    });
}
```

**Nota de comportamiento:** el registro del proxy solo relee la base en `reload()`, así que un cambio hecho por CLI con el proxy corriendo no se aplica hasta reiniciar. El mensaje lo dice explícitamente. La recarga en caliente llega en la fase 2, con la API de administración.

- [ ] **Step 2: Registrar el comando**

En `src/cli/index.ts`, añadir el import junto a los demás:

```typescript
import { registerKeys } from "./cmd-keys.js";
```

y la llamada junto a `registerAccounts(program);`:

```typescript
registerKeys(program);
```

- [ ] **Step 3: Comprobar manualmente**

```bash
npm run build
node dist/cli/index.js keys create prueba --owner victor --limit-5h 50000
node dist/cli/index.js keys list
```

Expected: la creación imprime el secreto una única vez; `list` muestra la key enmascarada como `ccr_xxxx…yyyy` con estado `active` y `5h:50000`.

- [ ] **Step 4: Comprobar tipos**

Run: `npm run lint`
Expected: sin errores.

- [ ] **Step 5: Commit**

```bash
git add src/cli/cmd-keys.ts src/cli/index.ts
git commit -m "feat(cli): add cc-router keys command"
```

---

### Task 13: Aviso experimental, documentación y cierre de fase

**Files:**
- Modify: `src/cli/index.ts` (silenciar el aviso de `node:sqlite`)
- Modify: `README.md`
- Create: `CHANGELOG.md` si no existe, o añadir entrada

**Interfaces:**
- Consumes: nada.
- Produces: nada.

- [ ] **Step 1: Comprobar el requisito de versión y silenciar el aviso**

Al principio de `src/cli/index.ts`, antes de cualquier import que cargue `node:sqlite`:

```typescript
// node:sqlite is stable enough for our use but still prints an
// ExperimentalWarning on every invocation, which is noise in a CLI.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
  const text = typeof warning === "string" ? warning : warning.message;
  if (text.includes("SQLite is an experimental feature")) return;
  return (emitWarning as (...args: unknown[]) => void)(warning, ...rest);
}) as typeof process.emitWarning;

const [major, minor] = process.versions.node.split(".").map(Number);
if (major! < 22 || (major === 22 && minor! < 5)) {
  console.error(`CC-Router requires Node >= 22.5 (found ${process.versions.node}).`);
  console.error("Key quotas and the admin panel rely on the built-in node:sqlite module.");
  process.exit(1);
}
```

- [ ] **Step 2: Verificar que el aviso desaparece**

```bash
npm run build
node dist/cli/index.js keys list 2>&1 | grep -c "ExperimentalWarning"
```

Expected: `0`.

- [ ] **Step 3: Documentar en el README**

Añadir una sección "API keys and quotas" tras la sección de configuración, con este contenido:

```markdown
### API keys and quotas

CC-Router can issue individual API keys, each with its own token quota, instead
of sharing a single secret across every client.

```bash
cc-router keys create laptop --owner victor --limit-5h 200000 --limit-month 5000000
cc-router keys list
cc-router keys limit <id> --limit-5h 400000
cc-router keys revoke <id>
```

The plaintext key is shown once, at creation — only its SHA-256 is stored.
Point a client at the router with it exactly as with the shared secret, via
`ANTHROPIC_AUTH_TOKEN` or the `x-api-key` header.

Quotas count every token type, cache reads included, over 5-hour, 7-day and
30-day windows. Exhausting one returns HTTP 429 with `retry-after` and
`x-ccrouter-quota-*` headers describing which window closed and when it reopens.
Windows are measured in hourly buckets, so they are slightly conservative: they
cover between N and N+1 hours and block a little early rather than a little late.

Quota changes made from the CLI take effect when the proxy restarts.

**The existing shared `proxySecret` keeps working**, treated as an unlimited
key, so upgrading breaks nothing.

**Requires Node >= 22.5** for the built-in `node:sqlite` module.
```

- [ ] **Step 4: Anotar el cambio incompatible**

Añadir al principio del `CHANGELOG.md` (creándolo si no existe):

```markdown
## Unreleased

### Breaking

- **Node >= 22.5 is now required.** Key quotas and usage history are stored with
  the built-in `node:sqlite` module. Node 20 is no longer supported.

### Added

- Individual API keys with token quotas over 5-hour, 7-day and 30-day windows,
  managed with `cc-router keys`.
- Usage history persisted to `~/.cc-router/router.db`: raw events for 35 days
  plus hourly rollups kept indefinitely.
- HTTP 429 with `retry-after` and `x-ccrouter-quota-*` headers when a key
  exhausts a window.

### Compatibility

- The shared `proxySecret` keeps working as an unlimited legacy key.
- If the database cannot be opened, the proxy starts in degraded mode: requests
  are still served and the legacy secret still authenticates, without quotas.
```

- [ ] **Step 5: Ejecutar la suite completa**

Run: `npm run lint && npm test`
Expected: `tsc --noEmit` limpio y toda la suite verde.

- [ ] **Step 6: Commit y push de la rama**

```bash
git add src/cli/index.ts README.md CHANGELOG.md
git commit -m "docs: document API keys, quotas and the Node 22.5 requirement"
git push -u origin feat/keys-quota-store
```

- [ ] **Step 7: Abrir el PR contra `develop`**

```bash
gh pr create --base develop --title "feat: API keys with per-key token quotas" \
  --body "Implementa la fase 1 de docs/superpowers/specs/2026-08-31-keys-quotas-web-panel-design.md"
```

---

## Definition of done

- `npm run lint` y `npm test` en verde.
- `cc-router keys create/list/limit/revoke` funcionan sobre una base real.
- Una key con `--limit-5h` pequeño devuelve 429 con `retry-after` tras agotarla.
- El `proxySecret` preexistente sigue autenticando, con test de regresión dedicado.
- Con `~/.cc-router/router.db` corrupto, el proxy arranca, avisa y sigue sirviendo.
- README y CHANGELOG documentan el requisito de Node 22.5.
