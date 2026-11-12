# I0035 J004 — Restos del escapado de texto (r1)

Autorización: operador (cerrar seguimientos; integrar sin preguntar salvo algo grave). Rama `fix/escape-residuals`; commits en la rama; sin push/PR.
Tamaño: M — cuatro puntos acotados del escapado y del manejo de teclas; riesgo de seguridad bajo.

## Puntos (revisiones I0032 J005 y J007)
1. Recortes que fabrican un escape aparente: en `NameField` (src/tui/profile-view.tsx ~215-217) el recorte por la izquierda de texto ya escapado puede convertir un `\\x1b` escrito por el usuario en `…\x1b`; `wrapText`/`clipText` pueden partir entre barras dobladas. Recortar/partir sin separar una secuencia de escape ni una barra doblada.
2. Mayúsculas: `namesEscapedCharacter` (src/tui/preview-window.ts ~54) solo reconoce `x`/`u` en minúscula; un `\X1b` o `\U202E` escrito queda sin doblar. Tratar también las mayúsculas.
3. Espacios no ASCII y caracteres ignorables en rutas entrecomilladas con `quoteText` (src/preview-model.ts; 5 sitios TUI): hoy se ven crudos; marcarlos igual que `commandLine`.
4. Teclas: el contador por turno de `useKeys` (src/tui/keys.ts) es por hook; un componente con confirmación que se monte a mitad de una lectura empieza en 0. Añadir un contador compartido por turno además del de cada hook para que un `y` de ese mismo turno nunca confirme.

## Aceptación
- Un test por punto que falla antes del cambio. Texto normal sin cambios; CLI sin cambios.

## Metodología
isswf-tdd (RED real; RED/GREEN separados; cada GREEN pasa `pnpm test`); isswf-security. Proporcionado.

## Checks
typecheck; lint; pnpm test; pnpm test:e2e; pnpm audit:all.

## Budget
Un worker, un intento + una ronda de corrección (ampliable con permiso del operador). Resolver en el job todo lo de la revisión.
