# I0032 J006 — Escapar caracteres de control en el texto mostrado por la TUI (r1)

Autorización: operador (integrar sin preguntar). Rama `fix/tui-escape-control-text`; commits en la rama; sin push/PR.
Tamaño: M — un punto de saneado compartido con riesgo de seguridad acotado; sin concurrencia.

## Problema (preexistente, confirmado en f762165)
Texto libre de recetas, Sources, Packages y salida de Hosts (nombre, homepage, fichero, texto manual, declaraciones, patrón de versión, ejecutable resuelto, cwd, líneas de preview) llega a Ink sin escapar. Un ESC, `\r`, `\b` u otros caracteres de control pueden redibujar la pantalla por encima de las líneas `$ …` y engañar en la revisión, y alteran el ancho que usa la geometría de la compuerta `y`. Además (revisión J003a) `commandLine` (src/preview-model.ts) no escapa espacios no ASCII (`\p{Zs}`, p. ej. U+00A0) ni caracteres que se ven en blanco (`\p{Default_Ignorable_Code_Point}`).

## Objetivo
1. Escapar una sola vez, en el punto común donde la TUI convierte líneas de preview (texto plano y `StyledLine`) en filas: caracteres de control C0/C1 (incluido ESC, `\r`, `\b`, DEL) y de formato/bidi (`\p{Cc}`, `\p{Cf}`, U+2028/2029) se muestran escapados de forma visible (p. ej. `\x1b`, `‮`), antes de calcular el ajuste de línea, para que teclas y render sigan usando la misma geometría. Conservar `\t` solo si se expande de forma determinista; si no, escaparlo también.
2. `commandLine`: escapar también espacios no ASCII y caracteres ignorables por defecto dentro de argumentos.
3. Cubrir también títulos/cabeceras de preview construidos con texto de receta (nombre de App en título y acción del pie).

## Aceptación
- Tests: una receta cuyo nombre, homepage y texto manual contienen ESC[2J, `\r`, `\b` y U+202E se muestra con esos caracteres escapados y sin alterar el resto del marco; la compuerta `y` sigue funcionando (`confirmAtEnd`).
- `commandLine(["x","a b"])` difiere visiblemente de `commandLine(["x","a b"])`.
- Texto normal (ASCII, acentos, CJK, emoji) sin cambios.
- CLI sin cambios (el saneado de la CLI queda fuera; anotarlo si se detecta).

## Metodología
isswf-tdd (RED real; RED/GREEN separados; cada GREEN pasa `pnpm test`); isswf-security (frontera de confianza: contenido de recetas y Sources no confiable).

## Checks
typecheck; lint; pnpm test; pnpm test:e2e; pnpm audit:all.

## Budget
Un worker, un intento + una ronda de corrección.
