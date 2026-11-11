# I0032: Claridad de recetas, previews y confirmaciones en la TUI

Type: feature

## J001
- Status: in-progress
- Objective: Rediseñar la presentación de la revisión de recetas, la preview de lotes de actualización y la confirmación para que se distinga qué pertenece a qué.
- Depends on: None
- Blocker: None
- Next step: tras elegir, plan de cambios en las líneas de preview (core devuelve estructura; la TUI renderiza), preservando "leer hasta el final antes de confirmar" y la paridad con la CLI.

### Evidence
- Operador (2026-11-11): «las recetas, las confirmaciones, los preview… son poco claros para un humano, salen todo a batiburrillo… ¿2 propuestas por cada uno?».
- Decisión del operador (2026-11-11): recetas A (cabecera + bloque por paso), preview A (resumen y avisos arriba, grupos por tipo), confirmación A (barra fija con progreso de lectura y efecto de y).
- Nota (2026-11-11): el artifact de propuestas ya no existe; las decisiones A/A/A siguen registradas arriba. El HTML local está en /tmp/claude-1000/-home-iseoane-Work-agent-depot/df8c75c0-e3d3-4391-a0d8-709e868bce70/scratchpad/tui-previews.html (temporal).
