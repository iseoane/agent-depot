# I0035 J002a — Textos de las previews (r1)

Autorización: operador (cerrar seguimientos; integrar sin preguntar salvo algo grave). Rama `fix/preview-texts`; commits en la rama; sin push/PR.
Tamaño: S — tres textos en dos pantallas; sin geometría.

## Objetivo
1. Lote de Updates sin nada aplicable: la cabecera no debe decir «Apply 0 updates» mientras el pie dice «Nothing can be applied»; usar una cabecera coherente (p. ej. «No updates can be applied») con el recuento por tipo y los fallos visibles (src/tui/updates.ts prepareUpdates / src/tui/updates-preview.ts).
2. Preview vacía: el pie no debe mostrar «Review 1 of 0» ni rango imposible (src/tui/preview-window.ts ~105); mostrar algo coherente (p. ej. sin «Review»), sin romper la compuerta `y`.
3. Package en el lote: la versión de origen de la flecha `from → to` no debe mostrar un hash de commit en crudo cuando hay versión instalada legible; si solo hay commit, mostrarlo identificado (p. ej. `commit 45e0761 → 0.9.69`) (recordedVersionLabel / package-rows.ts).

## Aceptación
- Un test por punto que falla antes del cambio. Compuerta `y` intacta. CLI sin cambios.

## Metodología
isswf-tdd (RED real; RED/GREEN separados; cada GREEN pasa `pnpm test`). Proporcionado: una ejecución completa por GREEN.

## Checks
typecheck; lint; pnpm test; pnpm test:e2e; pnpm audit:all.

## Budget
Un worker, un intento + una ronda de corrección (ampliable con permiso del operador). Resolver en el job todo lo de la revisión.
