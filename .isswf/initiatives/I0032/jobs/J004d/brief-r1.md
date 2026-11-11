# I0032 J004d — Pie en quitar unmanaged y confirmaciones en lote (r1)

Autorización: operador (extender el pie; integrar sin preguntar). Rama `feat/footer-unmanaged-bulk`; commits en la rama; sin push/PR.
Tamaño: M — dos caminos de Installations (unmanaged-actions.ts y bulk-actions.ts / confirm-bulk-*) ya identificados en J004a, más un ajuste acotado en recetas; sin concurrencia.

## Objetivo
1. Quitar unmanaged (`confirm-unmanaged`, src/tui/unmanaged-actions.ts, panel en manage-panel.tsx ~115 con `warnFirst`) y las confirmaciones en lote (`confirm-bulk-*`, src/tui/bulk-actions.ts) pasan al pie compartido como J004a–c: progreso de lectura, `[y] <acción>` ignorado hasta `read ✓`, una sola geometría para teclas y render, preview mostrada sola. Conservar los colores de aviso (el primer aviso de unmanaged debe seguir destacado).
2. Seguimiento de la revisión de J004c: en recetas, ocultar también las filas de mensaje en `approve`, `uninstall-confirm` y `uninstall-manual` mientras se muestran (o limpiar `notice` al iniciar la retirada), con un test de App completa.

## Aceptación
- Cada confirmación: `confirmAtEnd` a 40x17, 80x24, 110x40; un caso de paginación forzada donde `y` se ignora a mitad de lectura y `n`/Esc cancelan; ninguna fila extra encima (App completa en al menos un test).
- Contenido sin pérdida; colores de aviso conservados (test de color). CLI sin cambios.

## Metodología
isswf-tdd (RED real; RED/GREEN separados; cada GREEN pasa `pnpm test`).

## Checks
typecheck; lint; pnpm test; pnpm test:e2e; pnpm audit:all.

## Budget
Un worker, un intento + una ronda de corrección.
