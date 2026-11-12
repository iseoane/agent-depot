# I0034 J001 — Test de la espera al salir y opt-out inyectado (r1)

Autorización: operador «ok hazlos, coordinador» (2026-11-12). Rama `chore/tui-quit-wait-test`; commits en la rama; sin push/PR.
Tamaño: S — un módulo (src/tui/render.tsx) y su punto de llamada; sin riesgo especial.

## Objetivo
- src/tui/render.tsx:14 lee `process.env.AGENT_DEPOT_NO_BACKGROUND_REFRESH` y :22 espera `refreshSession.settled()` tras salir. Sustituir la lectura del entorno por una opción de `renderTui` (p. ej. `refreshOnStart?: boolean`, por defecto true) que la CLI pasa como hoy y los tests/e2e pueden desactivar (tests/isolated-env.ts y el arranque e2e). Si el e2e lanza el binario real y no puede inyectar opciones, mantener un único punto de lectura del entorno en la capa CLI (no en la TUI) y justificarlo.
- Añadir un test de `renderTui` (o de la función extraída que hace la espera) que demuestre: tras salir, espera a `settled()`; imprime el aviso solo si hay refrescos en curso; no espera si no hay ninguno. Inyectar una sesión falsa con promesa diferida.

## Aceptación
Ver plan. Comportamiento de usuario idéntico. CLI sin cambios visibles.

## Metodología
isswf-tdd (RED real; RED/GREEN separados; cada GREEN pasa `pnpm test`).

## Checks
typecheck; lint; pnpm test; pnpm test:e2e; pnpm audit:all.

## Budget
Un worker, un intento + una ronda de corrección.
