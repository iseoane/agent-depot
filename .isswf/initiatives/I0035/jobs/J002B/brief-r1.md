# I0035 J002b — Geometría de las previews (r1)

Autorización: operador (cerrar seguimientos; integrar sin preguntar salvo algo grave). Rama `fix/preview-geometry`; commits en la rama; sin push/PR.
Tamaño: M — el aplanado/ajuste de líneas compartido (src/tui/preview-window.ts, src/tui/preview-render.ts, PagedPreview en panel-parts.tsx) con impacto en la compuerta `y`; sin concurrencia.

## Objetivo
1. Sangría colgante: cuando una línea de bloque de paso o de sección se parte, las filas de continuación conservan su sangría y el guion del árbol (`│`) en vez de empezar en la columna 0 (revisiones J002/J003a de I0032). La misma geometría para teclas y render.
2. Desbordes: a 40x17 la preview nunca supera la altura de la terminal:
   - un título que se parte en muchas filas (el suelo de `maxFooterRows` de 2 y el cálculo de filas del título en preview-window.ts ~178) se recorta o elide para dejar al menos una fila de contenido;
   - el panel «working» de Updates (updates-view.tsx ~150) que puede convivir con la preview: o no se muestra a la vez o se reserva su altura (`reservedRows`) para teclas y render.

## Aceptación
- Tests: una línea larga de un paso a 40 columnas se parte con la sangría y `│` en cada fila de continuación; un título de >200 caracteres a 40x17 deja el marco ≤17 filas y al menos una fila de contenido; Updates con carga en curso durante la preview no supera la altura. La compuerta `y` (`confirmAtEnd` en los tres tamaños) sigue pasando.
- Tests sin depender del tamaño por defecto ni de rutas largas; CLI sin cambios.

## Metodología
isswf-tdd (RED real; RED/GREEN separados; cada GREEN pasa `pnpm test`). Proporcionado.

## Checks
typecheck; lint; pnpm test; pnpm test:e2e; pnpm audit:all.

## Budget
Un worker, un intento + una ronda de corrección (ampliable con permiso del operador). Resolver en el job todo lo de la revisión.
