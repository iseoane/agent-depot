# I0032 J004a — Pie de confirmación en hosts y desinstalación (r1)

Autorización: operador (extender el pie como trabajo aparte; integrar sin preguntar). Rama `feat/footer-manage-actions`; commits en la rama; sin push/PR.
Tamaño: M — tres confirmaciones de la vista Installations/manage que comparten panel; cambio de comportamiento acotado (exigir leer hasta el final); sin concurrencia.

## Objetivo
Las confirmaciones de añadir hosts, quitar hosts y desinstalar (src/tui/manage-panel.tsx ~88, 96, 98 y su manejo de teclas en src/tui/manage-actions.ts / bulk-actions.ts) pasan del `PreviewConfirm` sin paginación al pie compartido de PR #106 (`PagedPreview`/`previewViewport` con chrome `title`/`action`/`consequence`): progreso de lectura, `[y] <acción>` atenuado e ignorado hasta `read ✓`, una sola geometría para teclas y render.
Quitar unmanaged (manage-panel ~115) solo si comparte exactamente el mismo camino; si no, dejarlo para otro trabajo y decirlo.

## Aceptación
- Las tres confirmaciones muestran el pie; `y` no actúa antes de `read ✓` (harness `confirmAtEnd` a 40x17, 80x24, 110x40).
- Contenido de las previews sin pérdida.
- Tests sin depender de cuánto cabe en una página (lección PR #109). CLI sin cambios.

## Metodología
isswf-tdd (RED real; RED/GREEN separados; cada GREEN pasa `pnpm test`).

## Checks
typecheck; lint; pnpm test; pnpm test:e2e; pnpm audit:all.

## Budget
Un worker, un intento + una ronda de corrección.
