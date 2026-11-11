# I0032 J001 — Pie de confirmación compartido y geometría única (r1)

Autorización: operador inició I0032 en el orden pedido y eligió la opción A de confirmación (2026-11-11). Rama `feat/preview-confirm-footer`; commits en la rama; sin push/PR.

## Objetivo
Todas las superficies que hoy paginan una preview (App approve/confirm/manual, recetas approve/uninstall, Package confirm, Updates preview/manual/confirm-paths, Profile confirm/detalle, Sources refresh) usan un pie común de dos filas y una única geometría compartida por entrada y render. Contenido igual que hoy (sección `plain`); J002/J003 cambiarán el contenido.

## Diseño (planner; verificar)
- `src/preview-model.ts` mínimo (sin dependencias; registrar zona en `.fallowrc.json`): `PreviewDocument` con secciones/ítems/filas; en J001 basta la sección `plain` que envuelve las líneas actuales y conserva el coloreado de Profile.
- `src/tui/preview-render.ts`: `flattenPreview(doc,width)` y el pie.
- `PreviewChrome` con campos con nombre (`title`, `action` p. ej. "Apply 3 updates", `consequences?`) en vez de `questions[]` indexado; altura del pie calculada con `wrapLine`, no `footerRows` fijo.
- Hook único `usePreviewGeometry` usado por el manejador de teclas y el render de cada superficie (elimina las recomputaciones de app-actions.tsx:253/265, sources-recipes.tsx:256/260/284/288, package-actions.tsx:203, updates-view.tsx:109/125, profile-view.tsx:526, sources-view.tsx:121/310).
- Pie (opción A): fila 1 `read ████░░ 68% · Review N of M · X–Y of Z` (al final `read ✓` + consecuencias; en J001 la consecuencia es la acción); fila 2 `[y] <action>  [n] cancel`, `[y]` atenuado e ignorado hasta el final. A 40 columnas la barra se encoge; la fila puede envolver pero su altura se calcula; siempre ≥1 fila de contenido.

## Aceptación
- Todas las superficies listadas muestran el pie; `y` atenuado e ignorado hasta el final.
- Para cada superficie, `reachedEnd` de entrada == de render a 40x17, 80x24, 110x40; a 40x17 la pantalla cabe en 17 filas.
- CLI sin cambios. Superficies sin paginación hoy: fuera de alcance (J004).
- e2e: se pueden cambiar los matchers de «Scroll to end…»; mantener «Review N of M», rango y texto de pregunta y/n donde existan; ajustar deliberadamente los recuentos fijos (tui.e2e.test.ts:1119-1120) si cambia la altura del pie; conservar la comprobación de color (:1121).

## Metodología (obligatoria)
isswf-tdd (RED real por comportamiento; commits RED/GREEN separados; cada GREEN pasa `pnpm test` completo). isswf-e2e para los ajustes e2e y una prueba nueva: en el lote de Updates a 40x17, `y` no hace nada antes del final y `[y]` aplica al final.

## Checks
typecheck; lint; pnpm test; pnpm test:e2e; pnpm audit:all; tests/package-boundaries.test.ts.

## Budget
Un worker, un intento más una ronda de corrección tras revisión. Reportar recursos consumidos, RED/GREEN, checks, SHAs, desviaciones, riesgos.
