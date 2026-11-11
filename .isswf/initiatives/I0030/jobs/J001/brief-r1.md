# I0030 J001 — Línea de progreso por elemento (r1)

Autorización: operador «el orden en el que las he pedido» (2026-11-11). Rama `feat/tui-progress-line`; commits en la rama; sin push/PR.

## Decisiones del coordinador
- Granularidad: elemento + posición («Updating Skill tdd (2/5)…»). Subpasos dentro de App/Package fuera de alcance (job futuro).
- Un solo PR con actualizaciones en lote y la instalación desde el Catalog. CLI sin cambios (stdout/stderr idénticos).

## Diseño (del planner, verificar al implementar)
1. Nuevo módulo neutral `src/flow-progress.ts` (registrar zona en `.fallowrc.json`): tipo `FlowProgress {kind:"skill"|"app"|"package"; name; position; total; verb:"Installing"|"Updating"}` y `formatProgressLabel(event)` puro (termina en `…`; omite posición si total=1). No colocarlo en módulos Skill (tests/package-boundaries.test.ts).
2. `applyUpdateBatch` (src/skill-update.ts:231) y `applyConfirmedUpdates` (src/update-flow.ts:196): `onItem?` opcional por elemento, también si falla.
3. `runUpdates` (src/tui/updates.ts:429): `onProgress?`; total calculado antes (grupos Skill + appPlans + packagePlans; no contar appFailures/packageFailures); un evento antes de cada elemento.
4. `src/tui/updates-flow.ts`: etiqueta por evento conservando `startedAt` (también tras la pausa manual), con guard `mounted.current`.
5. Catalog: `src/tui/catalog-flow.ts:61` pasa `onStart` a `runBatch` como `bulk-actions.ts:201`; `catalog-panel.tsx:128` muestra «N finished» como manage-panel. Opcional: `app-actions.tsx:208` pasar el modo previo para no reiniciar el reloj.

## Aceptación
Ver ../../plan.md. Etiquetas siempre cumplen `isWorkingFrame`; reloj no se reinicia entre elementos; sin parseo de salida CLI.

## Metodología (obligatoria)
isswf-tdd: RED real antes de cada cambio de comportamiento (commits RED y GREEN separados). Tests unitarios: onItem orden/posición/total incl. fallo; runUpdates secuencia mixta y pausa manual; formatProgressLabel; reloj estable; Catalog (1/2)→(2/2) + finished; render ink de paneles. Sin e2e nuevos.

## Checks
pnpm test:single de los tests tocados; pnpm typecheck; pnpm lint; pnpm test; pnpm test:e2e (regresión de etiquetas); pnpm audit:all.

## Budget
Un worker, un intento. Reportar recursos consumidos, RED/GREEN, checks, SHAs y riesgos.
