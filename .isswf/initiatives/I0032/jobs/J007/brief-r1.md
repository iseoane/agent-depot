# I0032 J007 — Escapar texto no confiable fuera de las previews (r1)

Autorización: operador (integrar sin preguntar; fallo grave de seguridad preexistente detectado en la revisión de J006). Rama `fix/tui-escape-untrusted-text`; commits en la rama; sin push/PR.
Tamaño: M — un único primitivo aplicado en los puntos de entrada de texto no confiable; riesgo de seguridad acotado; sin concurrencia.

## Problema (preexistente)
Fuera de `PagedPreview`, texto no confiable llega crudo al terminal vía `<Text>`:
- Catalog: `name` y `description` de Skills de Sources remotas (src/tui/catalog-panel.tsx:53, src/tui/catalog-tree.ts:139). `parseScalar` (src/skill-discovery.ts:675-700) aplica `JSON.parse` a valores entrecomillados, así que un `SKILL.md` remoto con `description: "\u001b]52;c;…\u0007"` produce ESC/BEL reales (posible OSC 52 portapapeles, OSC 8 enlaces, título de ventana, dibujo fuera de Ink).
- Preguntas y/n: sources-recipes.tsx:389-390 (`appName`, `installedVersion` de salida de la App), exposición en manage-panel.tsx:62,91, installations-panel.tsx:54, catalog-panel.tsx:110.
- Listas y mensajes: `recipeMemberLine` (sources-recipes.tsx:383), filas de la lista de recetas en Sources, resultados de importación de Profile (profile-view.tsx:664, :76), `ListFooter`, `loadError`, etiquetas `Working`.

## Objetivo
Un único primitivo de texto seguro reutilizando `escapeControlText` (src/tui/preview-window.ts): p. ej. un componente `SafeText` o una función aplicada en los puntos donde datos externos se convierten en cadenas para la vista (filas de árbol/lista, mensajes, etiquetas). Preferir aplicarlo en un punto común (constructores de filas/etiquetas, `Working`, `ListFooter`, `DecisionPrompt`) para que nuevos usos queden cubiertos. Antes de calcular anchos/truncados (catalog-tree trunca descripciones a 60).
Incluir también (revisión J006): S2 — partir el texto manual multilínea (`Manual:` en preview-render.ts:81 y updates.ts:367) en varias líneas antes de escapar, en vez de mostrar `\x0a`; S3 — mostrar una barra invertida literal como `\\` para que un `\x1b` literal no se confunda con un ESC escapado (también en previews, manteniendo la idempotencia o documentando el cambio).

## Aceptación
- Test de extremo a extremo con una Source local cuyo SKILL.md tiene `name`/`description` con ESC, BEL, OSC 52 y U+202E: el Catalog no emite esos bytes al terminal (comprobar la salida cruda, no solo el frame) y los muestra escapados.
- Preguntas y/n, listas de recetas, mensajes y `Working` con texto de receta hostil no emiten bytes de control.
- Texto normal sin cambios; truncado del Catalog sigue funcionando. CLI sin cambios.
- Tests sin depender del tamaño de página.

## Metodología
isswf-tdd (RED real; RED/GREEN separados; cada GREEN pasa `pnpm test`); isswf-security (Sources remotas y recetas no confiables).

## Checks
typecheck; lint; pnpm test; pnpm test:e2e; pnpm audit:all.

## Budget
Un worker, un intento + una ronda de corrección.
