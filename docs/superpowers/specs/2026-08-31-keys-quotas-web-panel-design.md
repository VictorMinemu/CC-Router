# Sistema de API keys con cuotas y panel web de administración

Fecha: 2026-08-31
Estado: aprobado (pendiente de plan de implementación)
Rama base: `develop`

## Problema

CC-Router autentica a todos sus clientes con un único secreto compartido
(`proxySecret`, `src/proxy/server.ts:301`). No existe noción de identidad: no se
puede saber quién consume qué, ni limitar a un cliente sin cortar a todos. Las
métricas viven en un buffer en memoria de 100 entradas (`src/proxy/stats.ts`) y
se pierden en cada reinicio. La única interfaz de gestión es un TUI de Ink que
exige acceso al terminal de la máquina.

Se quiere: (1) keys individuales con cuota de consumo por cliente, y (2) un panel
web autenticado para gestionar keys, cuentas y métricas, accesible desde internet.

## Decisiones tomadas

| Eje | Decisión |
|---|---|
| Modelo de identidad | Un único administrador. Las keys llevan etiqueta y dueño; el "límite por usuario" es límite por key. Sin roles, registro ni multi-tenancy. |
| Métrica de cuota | Tokens (entrada + salida + caché) por ventana de 5 h, 7 d y 30 d. |
| Persistencia | `node:sqlite` integrado en Node. Requiere subir `engines` a `>=22.5`. |
| Topología | Dos procesos: proxy (3456) y panel (3457), ambos en el mismo paquete npm. |
| Propiedad del estado | El proxy es el único dueño de la base. El panel es cliente HTTP de `/cc-router/admin`. |
| Auth del panel | Contraseña scrypt + TOTP **opcional**, cookie de sesión, expuesto a internet. |
| Rebase de cuota | `429` con `retry-after` y cabeceras de diagnóstico. |
| Contabilidad | Híbrida: eventos crudos con retención de 35 días + buckets horarios permanentes. |
| Auth panel→proxy | Panel como BFF con token de máquina; la API de administración nunca se expone. |

## Arquitectura

### Procesos

```
navegador --cookie sesión--> panel :3457 --token máquina--> proxy :3456 --> SQLite
Claude Code / SDK --API key--> proxy :3456 --OAuth--> api.anthropic.com
```

**Proceso proxy** (puerto 3456). Único dueño de `~/.cc-router/router.db`. Valida
key y cuota antes de rutear, contabiliza el `usage` al terminar la respuesta, y
expone `/cc-router/admin/*` restringido a loopback + token de máquina.

**Proceso panel** (puerto 3457). Arranca con `cc-router panel start`, o junto al
proxy si está habilitado en la config. Sirve el build estático de React y actúa
de BFF: valida la cookie de sesión del navegador y reenvía al proxy firmando con
el token de máquina. Es la única superficie de administración expuesta a internet:
el proxy puede escuchar en 0.0.0.0 para atender clientes de API, pero su
`/cc-router/admin` sigue siendo accesible solo desde loopback.

La dependencia es unidireccional: si el panel cae, el proxy sigue ruteando.

### Reestructuración de `src/proxy/server.ts`

El fichero tiene 944 líneas e incluye el router de cuentas, el middleware de auth
y la captura de `usage`. Se extrae, sin cambiar comportamiento:

- `src/storage/` — apertura de SQLite, migraciones, repositorios.
- `src/keys/` — registro de keys en memoria, cálculo de ventanas, política de cuota.
- `src/proxy/admin/` — routers de administración. El router de cuentas actual se
  mueve a `src/proxy/admin/accounts-router.ts` **conservando la ruta
  `/cc-router/accounts`**, que consume el TUI de Ink.
- `src/panel/` — proceso del panel, sesiones, TOTP, BFF.
- `web/` — aplicación React con su propio `package.json`.

`src/proxy/server.ts` queda con el arranque y el camino de proxy.

## Modelo de datos

Base única `~/.cc-router/router.db`, `node:sqlite` en modo WAL, con
`schema_migrations` y migraciones secuenciales en `src/storage/migrations/`.

**`api_keys`** — `id`, `name`, `owner`, `key_hash`, `key_prefix`, `key_last4`,
`enabled`, `created_at`, `last_used_at`, `expires_at`, `revoked_at`,
`limit_5h`, `limit_7d`, `limit_month` (nulo = sin límite).

La key se genera como `ccr_` + 32 bytes aleatorios en base64url. Se persiste su
SHA-256, nunca el valor en claro. Con 256 bits de entropía real un hash rápido es
suficiente y permite búsqueda indexada en el camino crítico; scrypt aquí sería un
coste injustificado. `key_prefix` y `key_last4` permiten mostrarla como
`ccr_a1b2…f9x3`.

**`usage_events`** — `ts`, `key_id`, `account_id`, `model`, `input_tokens`,
`output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `status_code`,
`duration_ms`, `path`, `source`, `error`. Retención por defecto **35 días**: el
margen sobre la ventana de 30 días garantiza que la cuota mensual siempre se
calcula de forma exacta desde eventos crudos, sin depender de agregados.

**`usage_hourly`** — clave `(hour_start, key_id, account_id, model)`, con sumas de
tokens, peticiones y errores. Se conserva indefinidamente y alimenta las gráficas
históricas más allá de la retención. Es un resumen, nunca la fuente de verdad de
una cuota.

**`panel_admin`** (fila única) — `password_hash` scrypt con su salt y parámetros,
`totp_secret` cifrado, `totp_enabled`, códigos de recuperación hasheados.
Aquí sí scrypt: una contraseña humana tiene poca entropía.

**`panel_sessions`** — hash del token de sesión, `created_at`, `expires_at`,
`last_seen`, IP y user-agent, para poder cerrar sesiones desde el panel.

**`login_attempts`** — persistida, para que el bloqueo por intentos fallidos
sobreviva a un reinicio del proceso. Si viviera en memoria, reiniciar sería un
bypass trivial del throttling.

### El camino crítico no toca SQLite

El proxy mantiene en memoria, por key, un anillo de contadores horarios (840
valores para 35 días). Validar una cuota es sumar buckets en RAM. Los eventos se
vuelcan a disco en lotes cada pocos segundos, fuera de la petición. Al arrancar,
los contadores se reconstruyen desde la base.

### Compatibilidad hacia atrás

El `proxySecret` existente **sigue siendo válido**, tratado como key heredada sin
cuota. Ninguna instalación se rompe al actualizar. El panel ofrece convertirlo en
una key normal; solo cuando el administrador lo acepta deja de aceptarse.

## Camino crítico: validar, bloquear, contabilizar

Sustituye al middleware de `src/proxy/server.ts:301`. Todo en memoria.

**1. Identificar.** Se lee de `Authorization: Bearer` o `x-api-key`, igual que hoy.
SHA-256 y búsqueda en el mapa en memoria, con comparación en tiempo constante.
Key inexistente, revocada, deshabilitada o caducada → `401` en formato de error
Anthropic. Coincidencia con el `proxySecret` heredado → pasa sin cuota.

**2. Comprobar cuota.** Suma de buckets de las tres ventanas contra los límites de
la key. Si alguna está agotada → `429` con `retry-after` en segundos y cabeceras
`x-ccrouter-quota-*` indicando ventana, consumo y momento de reapertura. Claude
Code y los SDK de Anthropic ya saben esperar ante un 429.

*Limitación aceptada:* la cuota se comprueba antes de la petición pero el consumo
solo se conoce al terminarla, así que una petición puede rebasar el límite. Evitarlo
exigiría estimar tokens por adelantado y rechazar por predicción, con falsos
positivos. Se acepta el desbordamiento de una petición; la siguiente ya se bloquea.

**3. Contabilizar.** El punto que ya captura el `usage`
(`src/proxy/server.ts:710-763`) pasa a atribuir los tokens a la key además de a
los contadores globales. Incrementa el bucket horario en memoria y encola el
evento. Si la escritura falla se registra el error, pero la petición ya se sirvió:
la contabilidad nunca puede tumbar el proxy. El mismo buffer alimenta el SSE del
log en vivo.

La key **no** determina qué cuenta del pool atiende la petición. El round-robin y
los topes por cuenta existentes siguen mandando. Son dos capas independientes: la
key limita cuánto consume un cliente, la cuenta limita cuánto se exprime cada
suscripción.

## API y sesiones

### API de administración (proxy)

Bajo `/cc-router/admin/*`, con doble verificación: origen loopback **y**
`x-ccrouter-admin-token`. El token se genera en el primer arranque y vive en
`config.json` con permisos `0600`. Para ejecutar el panel en otra máquina se
requiere una lista explícita de orígenes permitidos en la config; por defecto no
se permite.

- CRUD de `/keys`
- `POST /keys/:id/rotate` — emite secreto nuevo y revoca el viejo atómicamente
- `GET /usage` — parámetros de ventana y agrupación, para las gráficas
- `GET /events` — stream SSE del log en vivo
- `/cc-router/accounts` **permanece en su ruta actual**, sin cambios (TUI de Ink)

### API del panel

`/api/auth/*` (login, logout, estado de sesión, alta de TOTP) y `/api/*` como
espejo de la API de administración. El navegador nunca ve el token de máquina.

### Sesiones

Cookie `ccr_session` de 32 bytes aleatorios, `HttpOnly`, `SameSite=Lax`, y
`Secure` automático bajo HTTPS. En base solo vive su hash. Caducidad deslizante de
7 días de inactividad con techo duro de 30 días. Las mutaciones exigen además una
cabecera CSRF propia: `SameSite=Lax` no basta si el panel acaba tras un dominio
compartido.

### Login

Contraseña con scrypt y comparación en tiempo constante; TOTP después si está
activado; bloqueo progresivo por IP y global, persistido. El mensaje de error es
siempre idéntico: nunca revela si la contraseña era correcta pero falló el segundo
factor.

**TOTP:** RFC 6238 con los parámetros que Google Authenticator soporta de forma
fiable — HMAC-SHA1, 6 dígitos, periodo de 30 s, tolerancia de ±1 intervalo por
desfase de reloj. Compatible además con Authy, 1Password, Bitwarden y Microsoft
Authenticator. El alta emite un URI
`otpauth://totp/CC-Router:<cuenta>?secret=…` y **el QR se dibuja en el navegador**,
no en el servidor: el backend no gana dependencias y el secreto no viaja como
imagen. Se generan 10 códigos de recuperación de un solo uso, mostrados una vez y
guardados hasheados.

**Recuperación de acceso:** `cc-router panel passwd --reset`, que exige acceso a la
máquina (local o SSH). No hay recuperación por email ni ninguna otra vía remota,
deliberadamente.

### Exposición a internet

El panel se niega a escuchar en `0.0.0.0` sobre HTTP plano: requiere `--insecure`
explícito, o detectar `X-Forwarded-Proto: https` de un proxy inverso. HTTPS lo
aporta Caddy, nginx o Cloudflare; CC-Router no gestiona certificados. Se envían
cabeceras de seguridad y CSP.

## Frontend

`web/` con **su propio `package.json`**. No es cosmético: el repo usa React 18 para
el TUI de Ink y beui exige Tailwind 4 y React 19. El aislamiento evita la colisión
de dependencias y, sobre todo, evita que quien instala `ai-cc-router` globalmente
se descargue React, Vite y Tailwind. **Al paquete npm solo viaja `web/dist`.**

Stack: Vite + React 19 + TypeScript + Tailwind 4, **shadcn/ui** como base (Radix
por debajo: accesibilidad y foco de teclado resueltos), TanStack Query para datos,
Motion para animación, Recharts para gráficas.

### Registros de UI — verificados el 2026-08-31

| Fuente | Estado | Uso |
|---|---|---|
| ui.shadcn.com | Registro base | Fundamento del sistema de componentes |
| beui.dev | Registro shadcn (`shadcn add @beui/…`), React + Motion + Tailwind 4, 112 componentes | Componentes animados |
| rareui.com | Registro shadcn (`shadcn add swamimalode07/rare-ui/…`), 17+ componentes | Componentes animados puntuales |
| transitions.dev | Colección copy-paste CSS/React | Transiciones de estado |
| beautifului.dev | **No instalable.** Escaparate de Turbo Design Studio con lista de espera por email; sin paquete ni registro | Solo referencia visual |

beautifului.dev queda descartado como dependencia: además de no ser instalable,
sus primitivas son para interfaces de chat y trazas de razonamiento, no para un
panel de administración.

Los componentes de registros externos se instalan **copiando código al repo**, no
como dependencia: se revisan antes de aceptarlos y ninguno puede introducir código
después de la instalación.

### Dirección visual

Oscuro por defecto y emparentado con el TUI: el cian, verde, ámbar y rojo que ya
usa `logStartup` y el dashboard de Ink pasan a ser los colores de estado del panel,
para que TUI y web se lean como el mismo producto. Monoespaciada para tokens, IDs
y keys; proporcional para el resto. La animación se reserva para lo que comunica
algo — llegada de una petición, barra de cuota acercándose al tope — y no para
decorar la navegación, que cansa en una herramienta de uso diario.

Vistas: **Keys**, **Cuentas**, **Métricas**, **Log**, más login y ajustes.

## Alta de cuentas y fidelidad al flujo de Claude Code

### Estado actual, asimétrico

**OpenAI/Codex ya está resuelto y es portable a web.**
`src/providers/openai/device-oauth.ts` implementa el device-code flow completo
contra `auth.openai.com` con el `client_id` de Codex
(`app_EMoamEEZ73f0CkXaXp7hrann`), pidiendo el user code en
`/api/accounts/deviceauth/usercode` y dirigiendo al usuario a
`https://auth.openai.com/codex/device`. Es headless por naturaleza: se muestra un
código, el usuario lo aprueba y el servidor hace polling. Funciona en remoto sin
cambios.

**Claude Max no tiene flujo de login en el repo.** Solo hay refresco
(`src/proxy/token-refresher.ts:11-17`: `client_id` de Claude Code
`9d1c250a-e61b-44d9-88ed-5944d1962f5e` contra `https://claude.ai/v1/oauth/token`) y
extracción de credenciales ya presentes en la máquina: Keychain de macOS bajo
`Claude Code-credentials`, o `~/.claude/.credentials.json`
(`src/utils/token-extractor.ts`). Las tres vías actuales son **locales**.

### Principio: no replicar la identidad, reutilizarla

El panel **no implementa OAuth**. Invoca por la API de administración los mismos
módulos que usa el CLI, de modo que `client_id`, scopes y endpoints son idénticos
por construcción y panel y CLI no pueden desincronizarse.

- **Codex:** device code. El panel muestra código y enlace y hace polling contra el
  proxy. Funciona en remoto tal cual.
- **Claude Max**, tres vías:
  - (a) **PKCE con código manual** — el proxy genera verifier y challenge, el panel
    abre la URL de autorización de Claude Code y el usuario pega el código. Mismo
    patrón que usa Claude Code sin navegador. **Única vía que funciona desde un
    navegador remoto.** Sujeta al spike descrito abajo.
  - (b) **Importar del host** — ejecuta la extracción de Keychain o
    `.credentials.json` en la máquina del router.
  - (c) **Pegado manual** de tokens (lo actual).

### Facturación por suscripción como invariante comprobable

`extractRateLimits` (`src/proxy/server.ts:222`) devuelve `null` si la respuesta no
trae `anthropic-ratelimit-unified-status`. Esas cabeceras unificadas de ventana de
5 h y 7 d **solo aparecen cuando la petición se imputa a la suscripción**. Su
ausencia es el síntoma de facturación como API de pago por uso.

**Verificación obligatoria al dar de alta.** Toda cuenta nueva —por PKCE, por
importación o pegada— dispara una petición de sondeo mínima antes de entrar al
pool. Con cabeceras unificadas: cuenta verificada, y el panel muestra plan
detectado y consumo de sus ventanas. Sin ellas: **la cuenta se guarda
deshabilitada y marcada "sin verificar — riesgo de facturación por API", y no entra
en el round-robin.** Un riesgo de cobro invisible se convierte en un bloqueo
visible.

**Criterio de aceptación del spike de PKCE:** el token obtenido por el panel debe
producir cabeceras unificadas, igual que uno extraído del Keychain. Si no, la vía
(a) se descarta y quedan (b) y (c), que obligan a dar de alta las cuentas de Claude
desde la máquina del router. La URL de autorización y el `redirect_uri` de Claude
Code **no están en el repo** y deben verificarse contra una cuenta real; nada en
esta spec asume que la vía (a) funciona.

### Riesgo introducido por esta feature

Hoy el cliente es siempre Claude Code, así que su `user-agent`, `anthropic-version`
y `X-Claude-Code-Session-Id` se reenvían tal cual y la identidad cuadra. Pero **el
sistema de keys existe para dejar entrar a otros clientes**, que enviarán su propia
identidad; `http-proxy-middleware` la reenvía sin tocarla. La feature puede, sin
querer, empujar peticiones fuera del carril de la suscripción.

**Mitigación:** normalizar la identidad de Claude Code en el tramo hacia Anthropic
para **toda** petición autenticada con una key, no solo añadir el beta
`oauth-2025-04-20` como ahora. Y hacerlo observable: una respuesta sin cabeceras
unificadas se registra como incidencia, se muestra en el panel y marca la key.

## Manejo de errores

Principio: **nada de lo nuevo puede tumbar el proxy.**

- SQLite no abre o falla una migración → el proxy arranca **degradado**: sirve
  peticiones, acepta el `proxySecret` heredado, deja cuotas y panel fuera con aviso
  en el log.
- Falla el volcado por lotes → reintento; antes de crecer sin límite en memoria se
  descarta el lote más antiguo.
- El panel no alcanza al proxy → muestra estado de desconexión, no datos rancios.
- El SSE del log reconecta con retroceso exponencial.

## Pruebas

Vitest, con TDD, siguiendo el estilo de `src/__tests__/`:

- Aritmética de ventanas y buckets, incluido el rebase de una petición sobre el límite
- Hash y validación de keys, con comparación en tiempo constante
- Caducidad, revocación y rotación
- Migraciones desde base vacía y desde base existente
- **TOTP contra los vectores de prueba del RFC 6238** — así se garantiza de verdad
  la compatibilidad con Google Authenticator
- Ciclo de vida de sesiones y bloqueo por intentos
- `/cc-router/admin` rechaza peticiones no loopback y sin token
- **Regresión explícita: el `proxySecret` antiguo sigue funcionando**
- Verificación de cuenta: sin cabeceras unificadas, la cuenta no entra al pool

Playwright solo para los caminos felices de login y alta de key. El valor está en
el backend.

## Fases

Cada fase es una rama sobre `develop`, con PR y commits convencionales al estilo
del repo (`feat(scope):`, `fix(scope):`, `chore:`).

1. `feat/keys-quota-store` — almacenamiento, migraciones, registro de keys,
   validación en caliente, 429 y contabilidad. **Aporta valor sin panel:** ya se
   pueden repartir keys con cuota desde el CLI.
2. `feat/panel-auth` — proceso del panel, BFF, login scrypt, TOTP opcional,
   sesiones, esqueleto de UI.
3. `feat/panel-keys-ui` — gestión de keys en web.
4. `feat/panel-metrics` — métricas y gráficas.
5. `feat/panel-accounts` — alta de cuentas, precedida del **spike de PKCE**, con la
   verificación de cabeceras unificadas.
6. `feat/panel-live-log` — stream en vivo.
7. `chore/release` — `engines` a Node `>=22.5`, README, CHANGELOG y aviso destacado
   de la ruptura.

El spike de la fase 5 es el único riesgo que no se puede cerrar leyendo el código;
puede adelantarse si se quiere saber pronto si el alta remota de Claude Max es
viable.

## Riesgos conocidos

| Riesgo | Mitigación |
|---|---|
| `node:sqlite` obliga a Node >=22.5 y rompe a usuarios en Node 20 | Comprobación de versión al arrancar con mensaje claro; aviso destacado en README y CHANGELOG |
| `node:sqlite` sigue marcada como API experimental | Acceso encapsulado en `src/storage/`, sustituible sin tocar el resto |
| Las consultas del panel pasan por el proceso del proxy | Métricas pre-agregadas y baratas; el proxy es asíncrono y no bloquea el streaming |
| La vía PKCE para Claude Max puede no ser viable | Spike con criterio de aceptación explícito; existen (b) y (c) como alternativas |
| Clientes que no son Claude Code pueden salirse del carril de suscripción | Normalización de identidad + detección de respuestas sin cabeceras unificadas |
| Una petición puede rebasar la cuota | Aceptado y documentado; la siguiente se bloquea |
| Panel expuesto a internet | TOTP disponible, bloqueo por intentos persistido, cookies endurecidas, CSP, negativa a servir en claro fuera de localhost |

## Fuera de alcance

- Usuarios reales con login propio, roles y multi-tenancy (posible fase futura; el
  esquema no lo impide)
- Cuotas por coste en dólares o por número de peticiones
- Límites de concurrencia o por minuto
- Gestión de certificados TLS (ACME) dentro de CC-Router
- Recuperación de acceso al panel por email
