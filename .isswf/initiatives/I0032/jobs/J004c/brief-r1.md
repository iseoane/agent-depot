# I0032 J004c — Pie de confirmación en quitar receta y quitar Source (r1)

Autorización: operador (extender el pie; integrar sin preguntar). Rama `feat/footer-sources-removal`; commits en la rama; sin push/PR.
Tamaño: M — dos confirmaciones de la vista Sources; cambio de comportamiento acotado; sin concurrencia.

## Objetivo
Quitar receta de App (src/tui/sources-recipes.tsx ~392, hoy sin cursor) y quitar Source (src/tui/sources-view.tsx ~458-461) pasan al pie compartido como J004a/J004b (PR #111, #112): progreso de lectura, `[y] <acción>` ignorado hasta `read ✓`, una sola geometría para teclas y render, la preview se muestra sola (sin filas de mensajes ni lista encima) mientras dura la confirmación.
Si la retirada de receta ya encadena con la confirmación de desinstalar la App (que ya pagina), conservar ese encadenamiento.

## Aceptación
- Ambas confirmaciones muestran el pie; `y` no actúa antes de `read ✓` (`confirmAtEnd` a 40x17, 80x24, 110x40) y un caso fuerza paginación (40x12 o contenido largo) donde `y` se ignora a mitad de lectura; `n` y Esc a mitad de lectura cancelan.
- Ningún mensaje queda encima de la preview (montar la App completa en al menos un test, como J004b).
- Contenido sin pérdida; colores de avisos conservados. CLI sin cambios.

## Metodología
isswf-tdd (RED real; RED/GREEN separados; cada GREEN pasa `pnpm test`).

## Checks
typecheck; lint; pnpm test; pnpm test:e2e; pnpm audit:all.

## Budget
Un worker, un intento + una ronda de corrección.
