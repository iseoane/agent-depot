# I0032 J004b — Pie de confirmación en instalar desde el Catalog y adoptar (r1)

Autorización: operador (extender el pie; integrar sin preguntar). Rama `feat/footer-install-adopt`; commits en la rama; sin push/PR.
Tamaño: M — dos confirmaciones (preview de instalación del Catalog y adopción en Installations); cambio de comportamiento acotado; sin concurrencia.

## Objetivo
La preview de instalación del Catalog (src/tui/catalog-panel.tsx ~103, 110; teclas en catalog-flow.ts / catalog-actions.ts) y la adopción (src/tui/installations-panel.tsx ~37; teclas en adoption-actions.ts) pasan al pie compartido como en J004a (PR #111): progreso de lectura, `[y] <acción>` ignorado hasta `read ✓`, una sola geometría para teclas y render (si el panel convive con otras filas, mostrarlo solo o reservar esas filas, como hizo J004a).

## Aceptación
- Ambas confirmaciones muestran el pie; `y` no actúa antes de `read ✓` (harness `confirmAtEnd` a 40x17, 80x24, 110x40), y al menos un caso fuerza paginación (contenido más largo que la página) para probar que `y` se ignora a mitad de lectura sin depender del tamaño por defecto (lección de PR #109 y revisión J004a).
- `n`/Esc a mitad de lectura cancelan.
- Contenido sin pérdida; flujos existentes (selección de hosts, exposición, lotes) sin regresión. CLI sin cambios.

## Metodología
isswf-tdd (RED real; RED/GREEN separados; cada GREEN pasa `pnpm test`).

## Checks
typecheck; lint; pnpm test; pnpm test:e2e; pnpm audit:all.

## Budget
Un worker, un intento + una ronda de corrección.
