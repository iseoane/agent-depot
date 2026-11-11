# I0032 J002 — Preview de lote de actualizaciones (opción A) (r1)

Autorización: operador eligió preview A y autorizó integrar (2026-11-11). Rama `feat/update-batch-preview`; commits en la rama; sin push/PR.

## Objetivo
La preview del lote de Updates muestra: cabecera `Apply N updates` con recuento por tipo (`1 Skill · 1 App · 1 Package`); avisos recogidos arriba (y repetidos en su elemento); secciones `SKILLS`, `APPS`, `PACKAGES` con un bloque por elemento (nombre en negrita, Source/scope en gris, flecha de versión `from → to` cuando se conozca, comando como `$ cmd args`); fallos visibles en su propia sección. Mockup aprobado: /tmp/claude-1000/-home-iseoane-Work-agent-depot/df8c75c0-e3d3-4391-a0d8-709e868bce70/scratchpad/tui-previews.html (sección 2, Propuesta A).

## Diseño (planner; verificar)
- `src/preview-model.ts` sin dependencias (registrar zona en `.fallowrc.json`, sin imports de `package-*` ni motor de instalación): `PreviewDocument { header?, warnings, sections[{heading?, style, items[{title spans, rows, warnings}]}], failures }`, filas `field|text|command|warning|version`.
- `src/tui/preview-render.ts`: aplanar el documento a filas físicas con sangrías/encabezados, envolviendo al ancho y conservando colores; alimenta el `previewViewport`/pie de PR #106 (una sola geometría para teclas y render).
- Core: `skillUpdatePreviewItem(plan, scope, projectRoot, wording)` en `src/update-flow.ts`; `describeUpdatePreview` pasa a renderizar ese ítem como texto y su salida debe ser byte-idéntica (test golden para ambas redacciones; `cli.test.ts` y `skill-update.test.ts` sin cambios).
- `prepareUpdates` (src/tui/updates.ts) devuelve un `PreviewDocument` (mantener lo que dependa de `lines` o adaptarlo); adaptadores TUI para Apps y Packages; la flecha de Package usa la versión instalada (`row.check.installed`).
- Comandos (decisión del operador): `$ cmd arg …`, entrecomillando (estilo JSON) cualquier argumento con espacios, comillas o metacaracteres de shell; ejecutable resuelto y cwd en gris debajo; `not found in PATH` en color de aviso.
- Pie: `action` = `Apply N updates`; `consequence` = p. ej. "replaces tdd's local changes · runs 2 commands".

## Aceptación
- Recuento de la cabecera = `applicable.length`; cada aviso aparece arriba y en su elemento; fallos visibles; la línea de Package "needs approval"/"This apply approves the declaration above." se conserva.
- CLI byte-idéntica (test golden).
- Compuerta `y` intacta (harness `confirmAtEnd` de tests/preview-footer.ts a 40x17, 80x24, 110x40).
- e2e del flujo de Updates y `scrollPreviewToEnd` pasan (ajustar matchers de texto deliberadamente si cambia el contenido).

## Metodología
isswf-tdd (RED real; RED/GREEN separados; cada GREEN pasa `pnpm test`). isswf-e2e para ajustes e2e.

## Checks
typecheck; lint; pnpm test; pnpm test:e2e; pnpm audit:all; tests/package-boundaries.test.ts.

## Budget
Un worker, un intento + una ronda de corrección.
