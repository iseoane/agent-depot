# I0032: Claridad de recetas, previews y confirmaciones en la TUI

Type: enhancement

## J001
- Status: completed
- Objective: Rediseñar la presentación de la revisión de recetas, la preview de lotes de actualización y la confirmación para que se distinga qué pertenece a qué.
- Depends on: None
- Brief: [brief-r1.md](jobs/J001/brief-r1.md)
- Brief J002: [brief-r1.md](jobs/J002/brief-r1.md)
- Brief J003a: [brief-r1.md](jobs/J003a/brief-r1.md)
- Brief J003b: [brief-r1.md](jobs/J003b/brief-r1.md)
- Brief J004a: [brief-r1.md](jobs/J004a/brief-r1.md)
- Brief J004b: [brief-r1.md](jobs/J004b/brief-r1.md)
- Brief J004c: [brief-r1.md](jobs/J004c/brief-r1.md)
- Brief J004d: [brief-r1.md](jobs/J004d/brief-r1.md)
- Brief J005: [brief-r1.md](jobs/J005/brief-r1.md)
- Brief J006: [brief-r1.md](jobs/J006/brief-r1.md)
- Brief J007: [brief-r1.md](jobs/J007/brief-r1.md)
- Blocker: None
- Next step: None. Release 0.6.14 en curso.

### Acceptance
- Recetas, preview de lote y confirmaciones con las propuestas A elegidas por el operador; compuerta `y` hasta leer el final en todas las confirmaciones; texto no confiable escapado.

### Evidence
- Operador (2026-11-11): «las recetas, las confirmaciones, los preview… son poco claros para un humano, salen todo a batiburrillo… ¿2 propuestas por cada uno?».
- Decisión del operador (2026-11-11): recetas A (cabecera + bloque por paso), preview A (resumen y avisos arriba, grupos por tipo), confirmación A (barra fija con progreso de lectura y efecto de y).
- Nota (2026-11-11): el artifact de propuestas ya no existe; las decisiones A/A/A siguen registradas arriba. El HTML local está en /tmp/claude-1000/-home-iseoane-Work-agent-depot/df8c75c0-e3d3-4391-a0d8-709e868bce70/scratchpad/tui-previews.html (temporal).
- Planner (2026-11-11): previews son líneas planas; el bloqueo de `y` hasta el final lo recalcula cada llamador (riesgo de desincronía); solo la preview de update de Skills es texto compartido con la CLI; ~30 aserciones e2e dependen del texto actual. Diseño: `src/preview-model.ts` (secciones/ítems/filas/comandos/avisos), `src/tui/preview-render.ts` (aplanado, pie), hook de geometría único; `describeUpdatePreview` se reescribe sobre el modelo con test golden (CLI idéntica).
- Defaults del coordinador: CLI sin cambios; se permite cambiar los matchers e2e de «Scroll to end…» manteniendo «Review N of M», el rango y la pregunta.
- Decisiones del operador (2026-11-11): comandos como `$ cmd args` entrecomillando argumentos con espacios, comillas o metacaracteres; extender el pie a las confirmaciones sin paginación como trabajo aparte (J004); release 0.6.14 al terminar I0032.
- Worker J001: RED 6aa0402, GREEN 7fef274, e2e 0d5b2d2, fix cf5eae4, cobertura 2055d08. Checks autoinformados: typecheck/lint, test 1355/0, e2e 17/17, audit OK; CLI sin cambios. Desviaciones: sin preview-model/preview-render (se introducen en J002); app-approve sin test renderizado (inalcanzable desde la UI); la pregunta y/n aparece solo al final; recuento e2e de Profile 7–8 → 6–9 of 41.
- Autorización del operador (2026-11-11): «continúa, intenta completar el I0032… saca release cuando acabes» — integrar J001–J004 con revisión aprobada y CI verde, y publicar al final.
- Autorización del operador (2026-11-11): integrar sin preguntar salvo algo grave que requiera confirmación.
- Revisión J001 V001 (Agent-tool, no ligada): pass, 0 bloqueantes. S1 (preexistente en base 88e3166, keys.ts parte ráfagas por carácter): `jjj…y` en un mismo bloque puede actuar antes de dibujar ✓ → abordar en J004. I1 'Review 1 of 0' con preview vacía; I2 título muy largo o panel working pueden pasar de 17 filas; I4 Package approve/forget ahora exige leer hasta el final (dirección segura, aceptado).
- J001 entregado: PR #106 fusionado con CI verde.
- Decisión del operador (2026-11-11): partir el resto en trabajos pequeños — J003a revisión de recetas; J003b confirmación/desinstalación/paso manual de Apps con los bloques de paso; J004a pie en añadir/quitar hosts y desinstalar; J004b instalar y adoptar; J004c quitar receta y quitar Source; J005 ráfagas de teclas que alcanzan `y` antes de dibujar ✓.
- J002 worker b048313..c2ff9cb. Revisión V001: Spec pass, sin bloqueantes (Standards inconcluso por checks no observados). Coordinador observó: golden 2/0, preview-model 1/0, tui-updates-view 70/0; cli.test.ts y skill-update.test.ts sin cambios. Seguimientos para J003a: escapar caracteres invisibles (\p{Cf}) en comandos mostrados; casos golden sin cwd y sin declaredChanges.
- J002 entregado: PR #108 fusionado con CI verde.
- Regla de tamaño S/M/L aplicada en .isswf/project-setup.md (f3ff0a1); propuesta a isSWF: https://github.com/iseoane/isSWF/issues/270 (needs-triage, enhancement). Desviación del coordinador: los dispatches de esta sesión no pasaron el modelo/esfuerzo por rol del setup (heredaron el de la sesión); a partir de J003b se aplica la tabla.
- J003a worker f762165..ee1069f. Revisión V001 (opus, Agent-tool): inconclusive por checks no observados, 0 bloqueantes. Coordinador observó preview-model 2/0, preview-render 2/0, tui-sources-recipes 24/0 + CI. Seguimientos: espacios no ASCII (\p{Zs}) sin escapar en commandLine; ee1069f sin test; e2e de argv delegados sin fronteras exactas (fijar fila en vista ancha); pasos con nombres de campo de la receta.
- Nuevo J006 (prioritario, antes de la release; preexistente, confirmado en f762165): texto libre de recetas/Sources (nombre, homepage, manual, declaraciones, cwd) llega al terminal sin escapar caracteres de control/ESC → puede redibujar sobre las líneas `$ …` y alterar la geometría de la compuerta y. Escapar una vez al renderizar líneas estilizadas; incluir \p{Zs} no ASCII en commandLine.
- J003a entregado: PR #109 fusionado con CI verde (corrección de test frágil en Windows a89e9bc).
- J003b worker (sonnet, 19 min, 109k) 18e7b4d..9a2f0e8. Revisión V001 (opus): Spec pass, 0 bloqueantes; Standards inconcluso → coordinador observó: RED 5c9fa2c solo tests; CLI sin cambios; e2e iguales o más estrictos; tests focalizados 67/0.
- J003b entregado: PR #110 fusionado con CI verde.
- J004a worker (sonnet, 11 min, 93k) edb5a85..ed1c11f. Revisión V001 (opus): Spec pass, 0 bloqueantes; coordinador observó RED 0b1499c solo tests, CLI sin cambios, tui-installations-manage 23/0. Seguimientos: forzar paginación en tests de add/remove hosts; test de n/Esc a mitad de lectura. Pendiente añadido: quitar unmanaged y confirmaciones en lote (confirm-bulk-*) → J004d.
- J004a entregado: PR #111 fusionado con CI verde.
- J004b worker (sonnet, 16 min + corrección 17 min, 307k) 273251d..4ed5687. Revisión V001 (opus): fail (F1 bloqueante: filas de mensajes sobre la preview de instalación de recetas). Corrección: F1, F2 (colores de avisos, también en la desinstalación de J004a), F3 (Esc). V002: approve. Coordinador: sin aserciones eliminadas en tests editados; RED 9490d2c solo tests; CLI sin cambios. Tamaño: subestimado (1 corrección).
- J004b entregado: PR #112 fusionado con CI verde.
- J004c worker (sonnet, 12 min, 92k, sin corrección) 3a34f1a..ac8c4eb. Revisión V001 (opus): 0 bloqueantes; coordinador cerró lo no observado: RED f6f3e97 solo tests, CLI sin cambios, base sin colores en la retirada (nada perdido), tests 50/0. Seguimientos a J004d: ocultar filas de mensaje también en approve/uninstall-confirm/uninstall-manual de recetas (o limpiar notice en startRemoval); test de Source removal sin filas encima.
- J004c entregado: PR #113 fusionado con CI verde.
- J004d worker (sonnet; interrumpido por cuota y reanudado con SendMessage) 5e99044..f49a531. Revisión V001 (opus): 0 bloqueantes; coordinador: RED 2a2aff9 solo tests, CLI sin cambios, contenido del lote conservado (solo pierde color de grupo en etiquetas), tests 78/0. Seguimientos para J005: borrar PreviewConfirm/warnFirst sin uso en producción; devolver color de grupo a etiquetas del lote con líneas styled.
- J004d entregado: PR #114 fusionado con CI verde (arreglo de tests frágiles en Windows 7df4c28).
- J005: V001 fail (F1 `ry` en Sources); corrección 5a9d5df/17786b4; V002 changes required (F7 preexistente: `y` tras flechas/PgDn/escape en la misma lectura sigue confirmando). Presupuesto de corrección agotado → awaiting-human: ¿ronda extra con marcado por lectura de entrada, integrar lo actual y seguir F7 aparte, o descartar?
- Operador (2026-11-12): una ronda más para J005 con marcado por lectura de entrada.
- J005 V003: approve (F7 resuelto: marcado por turno de lectura). Coordinador: 4 commits RED solo tests, CLI sin cambios, tests afectados 164/0. Tamaño: subestimado (2 correcciones, 1 autorizada por el operador). Seguimiento informativo: contador compartido por turno si algún día un componente con confirmación se monta a mitad de lectura.
- J005 entregado: PR #115 fusionado con CI verde (test PgDn robusto en Windows db948d7).
- J006 worker (sonnet) b8a2e51..272da76. Revisión V001 (opus): Spec pass, 0 bloqueantes; coordinador: RED fe421f4 solo tests, CLI sin cambios, tests 21/0. S1 (preexistente, grave): texto no confiable sigue llegando crudo fuera de PagedPreview — descripciones y nombres de Skills remotas en el Catalog (OSC 52/8 posibles vía SKILL.md), preguntas y/n, listas, Working labels → J007 antes de la release. S2: los 
 del texto manual se ven como 
 (partir en líneas). S3: literal  indistinguible (mostrar \ como \).
- J006 entregado: PR #116 fusionado con CI verde.
- Operador (2026-11-12): tras la release, limpiar worktrees y ramas.
- J007 worker (sonnet) 57bcffc..d135287. V001 fail (F1 doble escapado en aprobaciones; F2 sin Source real; F3 Profile mide sin escapar). Corrección 73c1869/d135287. V002 approve. Coordinador: RED solo tests, CLI sin cambios, golden 2/0, tests afectados 62/0. Tamaño: subestimado (1 corrección).
- J007 entregado: PR #117 fusionado con CI verde. I0032 completa.
- Release 0.6.14 publicada (PR #118, workflow 43165080558) y esta máquina actualizada con self update. Ramas y worktrees limpios.
