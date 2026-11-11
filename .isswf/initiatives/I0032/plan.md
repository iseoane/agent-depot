# I0032: Claridad de recetas, previews y confirmaciones en la TUI

Type: feature

## J001
- Status: in-progress
- Objective: Rediseñar la presentación de la revisión de recetas, la preview de lotes de actualización y la confirmación para que se distinga qué pertenece a qué.
- Depends on: None
- Blocker: awaiting-human — formato de argv y alcance del pie en previews sin paginación.
- Next step: J001 pie de confirmación compartido + geometría única; J002 preview de lote; J003 revisión de recetas (secuenciales, un PR cada uno).

### Evidence
- Operador (2026-11-11): «las recetas, las confirmaciones, los preview… son poco claros para un humano, salen todo a batiburrillo… ¿2 propuestas por cada uno?».
- Decisión del operador (2026-11-11): recetas A (cabecera + bloque por paso), preview A (resumen y avisos arriba, grupos por tipo), confirmación A (barra fija con progreso de lectura y efecto de y).
- Nota (2026-11-11): el artifact de propuestas ya no existe; las decisiones A/A/A siguen registradas arriba. El HTML local está en /tmp/claude-1000/-home-iseoane-Work-agent-depot/df8c75c0-e3d3-4391-a0d8-709e868bce70/scratchpad/tui-previews.html (temporal).
- Planner (2026-11-11): previews son líneas planas; el bloqueo de `y` hasta el final lo recalcula cada llamador (riesgo de desincronía); solo la preview de update de Skills es texto compartido con la CLI; ~30 aserciones e2e dependen del texto actual. Diseño: `src/preview-model.ts` (secciones/ítems/filas/comandos/avisos), `src/tui/preview-render.ts` (aplanado, pie), hook de geometría único; `describeUpdatePreview` se reescribe sobre el modelo con test golden (CLI idéntica).
- Defaults del coordinador: CLI sin cambios; se permite cambiar los matchers e2e de «Scroll to end…» manteniendo «Review N of M», el rango y la pregunta.
