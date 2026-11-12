# I0035 J001 — Marca «refreshed» sin tiempo y un solo formateador de progreso (r1)

Autorización: operador (cerrar seguimientos; integrar sin preguntar salvo algo grave). Rama `chore/refresh-mark-progress-label`; commits en la rama; sin push/PR.
Tamaño: S — dos cambios pequeños de presentación en la TUI; sin riesgo especial.

## Objetivo
1. src/tui/sources-view.tsx (marca de refresco, ~107): `✓ refreshed` sin «N min ago»/«just now». Mantener `… refreshing Ns` y `✗ refresh failed`. Ajustar tests.
2. Unificar `formatProgressLabel` (src/flow-progress.ts), el formateador de src/tui/bulk-actions.ts (~203-204, muestra posición aun con total=1) y `stepLabel` de src/tui/app-actions.tsx (~135-136) en uno solo, conservando el texto visible actual de cada pantalla salvo la diferencia de total=1, que se unifica a «omitir posición si hay un solo elemento». Mantener el `…` final (lo usan las esperas e2e).

## Aceptación
Ver plan. Tests de las tres pantallas en verde; CLI sin cambios.

## Metodología
isswf-tdd (RED real; RED/GREEN separados; cada GREEN pasa `pnpm test`). Proporcionado: una ejecución completa por GREEN, sin variantes de estrés.

## Checks
typecheck; lint; pnpm test; pnpm test:e2e; pnpm audit:all.

## Budget
Un worker, un intento + una ronda de corrección (ampliable con permiso del operador). Resolver dentro del job todo lo que salga en la revisión.
