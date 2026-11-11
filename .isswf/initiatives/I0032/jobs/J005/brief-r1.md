# I0032 J005 — Ráfagas de teclas y limpieza del pie (r1)

Autorización: operador (integrar sin preguntar). Rama `feat/preview-key-bursts`; commits en la rama; sin push/PR.
Tamaño: M — un cambio de seguridad acotado en el manejo de teclas más una limpieza pequeña; sin concurrencia de procesos.

## Objetivo
1. Seguridad (revisión J001, preexistente): `useKeys` (src/tui/keys.ts:28-30) parte un bloque imprimible (pegado o repetición de tecla) en pulsaciones por carácter; con refs síncronas, `jjj…y` en el mismo bloque puede llevar el cursor al final y ejecutar `y` antes de dibujar `read ✓`. Hacer que una `y` (o cualquier tecla de confirmación) que llega en el mismo bloque que un movimiento del cursor, o en un bloque pegado, no confirme mientras hay una preview paginada abierta; la confirmación requiere una pulsación propia después de que el pie muestre `read ✓`. No romper la navegación normal ni la escritura en campos de texto (nombres, rutas).
2. Limpieza (revisión J004d): borrar `PreviewConfirm` y la prop `warnFirst` de `PagedPreview` si ya no tienen uso en producción (adaptar o retirar el test que solo existe por ellos); devolver el color de grupo (`theme.group`) a las etiquetas de cada elemento en las previews en lote usando líneas `styled`.

## Aceptación
- Test: un bloque `"jjjjjjjjy"` (o equivalente hasta el final) no ejecuta la acción; una `y` posterior en su propio bloque sí. Se prueba en al menos dos superficies (p. ej. Updates y Package o desinstalación).
- Teclas sueltas y pegado en campos de texto siguen funcionando (tests existentes en verde).
- Etiquetas de lote con color de grupo (test de color). Sin código muerto del pie antiguo.
- Tests sin depender del tamaño de página (lección de PR #109/#114). CLI sin cambios.

## Metodología
isswf-tdd (RED real; RED/GREEN separados; cada GREEN pasa `pnpm test`).

## Checks
typecheck; lint; pnpm test; pnpm test:e2e; pnpm audit:all.

## Budget
Un worker, un intento + una ronda de corrección.
