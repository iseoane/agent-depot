# I0032: Claridad de recetas, previews y confirmaciones en la TUI

Type: feature

## J001
- Status: in-progress
- Objective: Rediseñar la presentación de la revisión de recetas, la preview de lotes de actualización y la confirmación para que se distinga qué pertenece a qué.
- Depends on: None
- Brief: [J001 brief-r1.md](jobs/J001/brief-r1.md)
- Blocker: None
- Next step: J001 terminado por el worker (6aa0402..2055d08); esperar indicación del operador para lanzar la revisión independiente. Decidir si conservar tooling/.local/J001 (sin seguimiento). Luego PR, J002, J003, J004 y release 0.6.14.

### Evidence
- Operador (2026-11-11): «las recetas, las confirmaciones, los preview… son poco claros para un humano, salen todo a batiburrillo… ¿2 propuestas por cada uno?».
- Decisión del operador (2026-11-11): recetas A (cabecera + bloque por paso), preview A (resumen y avisos arriba, grupos por tipo), confirmación A (barra fija con progreso de lectura y efecto de y).
- Nota (2026-11-11): el artifact de propuestas ya no existe; las decisiones A/A/A siguen registradas arriba. El HTML local está en /tmp/claude-1000/-home-iseoane-Work-agent-depot/df8c75c0-e3d3-4391-a0d8-709e868bce70/scratchpad/tui-previews.html (temporal).
- Planner (2026-11-11): previews son líneas planas; el bloqueo de `y` hasta el final lo recalcula cada llamador (riesgo de desincronía); solo la preview de update de Skills es texto compartido con la CLI; ~30 aserciones e2e dependen del texto actual. Diseño: `src/preview-model.ts` (secciones/ítems/filas/comandos/avisos), `src/tui/preview-render.ts` (aplanado, pie), hook de geometría único; `describeUpdatePreview` se reescribe sobre el modelo con test golden (CLI idéntica).
- Defaults del coordinador: CLI sin cambios; se permite cambiar los matchers e2e de «Scroll to end…» manteniendo «Review N of M», el rango y la pregunta.
- Decisiones del operador (2026-11-11): comandos como `$ cmd args` entrecomillando argumentos con espacios, comillas o metacaracteres; extender el pie a las confirmaciones sin paginación como trabajo aparte (J004); release 0.6.14 al terminar I0032.
- Worker J001: RED 6aa0402, GREEN 7fef274, e2e 0d5b2d2, fix cf5eae4, cobertura 2055d08. Checks autoinformados: typecheck/lint, test 1355/0, e2e 17/17, audit OK; CLI sin cambios. Desviaciones: sin preview-model/preview-render (se introducen en J002); app-approve sin test renderizado (inalcanzable desde la UI); la pregunta y/n aparece solo al final; recuento e2e de Profile 7–8 → 6–9 of 41.
- Autorización del operador (2026-11-11): «continúa, intenta completar el I0032… saca release cuando acabes» — integrar J001–J004 con revisión aprobada y CI verde, y publicar al final.
