# I0031 J001 — Sesión de refresco de Sources, marcas y refresco al arrancar (r1)

Autorización: operador inició I0031 (orden pedido) y decidió D1/D2 (2026-11-11). Rama `feat/source-refresh-session`; commits en la rama; sin push/PR.

## Decisiones
- D1: un refresco correcto hecho por este proceso TUI vale 1 hora para previews/Updates. `r` manual siempre fuerza.
- D2: refrescos en segundo plano con `GIT_TERMINAL_PROMPT=0` y timeout de 60 s; al vencer → estado failed con mensaje claro. Refrescos explícitos del usuario conservan el comportamiento actual.
- D3: el arranque refresca solo Sources Git registradas (no builtin ni las solo de manifiesto).
- D4: el Catalog no recarga automáticamente al terminar un refresco.
- CLI sin cambios de comportamiento.

## Diseño (planner; verificar en código)
Fase A (core):
1. `src/source-refresh-session.ts` en memoria, registrado en zona de `.fallowrc.json`: clave `sourceIdForUrl(url canónica)`; estado `not-refreshed|refreshing|refreshed|failed` + startedAt/finishedAt/error; `refresh(source,{force, background})` deduplica concurrentes (segundo llamante espera el mismo promise), reutiliza éxito dentro de 1 h salvo force, nunca reutiliza failed; cola background concurrencia 2, el usuario no espera la cola; `subscribe`/`snapshot`; reloj inyectable. No escribe archivos.
2. Soporte en `src/git-source.ts` para env `GIT_TERMINAL_PROMPT=0` y timeout solo en refrescos background (vía opción, sin afectar CLI).
3. Wrapper TUI `withRefreshSession(operations, session)` que enruta `refreshSource` y `refreshProjectSource` (misma clave).
4. Enmienda de `docs/adr/0004-*`: reutilización de un refresco del mismo proceso dentro de 1 h; failed/no refrescado siempre refresca; `r` fuerza; un fallo sigue impidiendo escribir.
Fase B (TUI):
5. `renderTui` crea la sesión; `App` la recibe y arranca el refresco background solo con prop opt-in (renderTui la activa; tests no). No bloquea arranque.
6. Sources view: marca textual por fila (`· not refreshed`, `… refreshing 12s`, `✓ refreshed 2m ago`, `✗ refresh failed`), color como apoyo; detalle de error en la fila seleccionada; `r` va por la sesión con force y conserva su preview y/n. El estado vive sobre las vistas (se remontan al cambiar de pestaña).
7. Updates/instalación/Packages usan las operaciones envueltas; pasar las mismas en `packageOperationsOf` (src/tui/environment.ts:29). Abrir Updates con un refresco en curso espera ese mismo refresco.

## Aceptación
plan.md + decisiones. Un solo refresco por Source ante llamadas concurrentes; reutilización dentro de 1 h; force y failed refrescan; marcas cambian en vivo; arranque no bloquea; previews siguen fallando antes de escribir si el refresco falla.

## Metodología (obligatoria)
isswf-tdd con RED real por comportamiento (commits RED/GREEN separados; cada commit GREEN debe pasar `pnpm test` completo). Fakes diferidos, reloj inyectado, sin red. E2E solo si el harness ya monta Sources Git locales; si no, justificarlo.

## Checks
test:single de tests tocados; typecheck; lint; pnpm test; pnpm test:e2e; pnpm audit:all; tests/package-boundaries.test.ts.

## Budget
Un worker, un intento (fase A y luego B). Reportar recursos consumidos, RED/GREEN, checks, SHAs, desviaciones y riesgos (incl. lock huérfano, fuera de alcance salvo hallazgo).
