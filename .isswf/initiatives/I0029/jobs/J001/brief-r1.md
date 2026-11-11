# J001 — Self-update con npm de mise/Omarchy (r1)

## Identity and authorization
- Initiative: I0029; job: J001; revision: r1.
- Source: conversación del operador: «ok, coordinador añadelo como iniciativa».
- Request mode: prepare-only, local. Autorizado registrar plan y brief, no ejecutar implementación, instalar, modificar configuración global, hacer commits, push ni publicar issues/PRs.
- Coordinator owns these records. No worker dispatched; actor/model/budget pendiente de un inicio explícito.

## Objective
Permitir self update para una instalación npm global verificable con el formato npm observado tras actualizar Omarchy/mise, sin aceptar instalaciones ni ejecutables no verificables.

## Scope and acceptance
- Alcance previsto: detección segura de npm e instalación global en src/self-update.ts, helpers de resolución afectados y tests/self-update.test.ts. Reabrir referencias al empezar.
- Exclusiones: cambios a mise/Omarchy o Node del usuario; desactivar comprobaciones, autoaceptar cualquier wrapper, actualizar realmente paquetes durante tests, publicación remota.
- Acceptance: las cuatro condiciones de ../../plan.md.
- Unidad funcional única: diagnóstico, corrección acotada y regresiones positivas/negativas en la misma entrega, si se autoriza.
- Checks propuestos, no ejecutados: pnpm test:single tests/self-update.test.ts; pnpm typecheck; pnpm lint; pnpm test. Ninguna llamada real al registro ni instalación global en regresiones.

## Inputs and bases
- Base examinada: 1cfce0db464fb068723586cca4933bbbe30e2a06.
- Document checkpoint: no creado; no commit autorizado.
- Reading map: src/self-update.ts:100-127, createSelfUpdateOperations/npmGlobalExecutable, verificación del ejecutable y comparación de raíces; tests/self-update.test.ts, regresiones existentes; src/executable-resolution.ts, resolución portable, por investigar.
- Observación del operador: npm global reinstalado, CLI 0.6.12, persiste “not verified in npm's global package directory”. npm realpath termina en node/26.13.0/bin/npm, no en npm-cli.js. mise resuelve Agent Depot bajo node/latest/bin.
- Hipótesis principal: guard de forma/ruta de npm rechaza este formato antes de consultar la raíz global. No causa confirmada mediante ejecución local; no afirmar que mise sea defectuoso ni confiar en un nombre de archivo como prueba suficiente.
- Incertidumbres: formato/contenido legítimo del ejecutable npm; raíz global completa (salida aportada posiblemente truncada); coherencia entre npm, Node y packageRoot efectivos; equivalencia entre fuente actual y paquete 0.6.12 instalado.
- Codegraph: búsqueda de herramientas por self update sin resultados; grounding directo en fuente. Engram: búsqueda explícita agent-depot/self-update mise sin contexto actual reutilizado; memoria histórica no prueba el estado presente.

## Quality inventory
- Correctitud: síntoma aportado, guard inspeccionado; falta reproducción discriminante y controles negativos.
- Seguridad: frontera de confianza en ejecutable npm y raíz de instalación; no relajar controles sin alternativa verificable.
- Compatibilidad: mantener npm convencional y camino Windows npm.cmd; comprobar wrappers/formato real antes de diseñar.
- Mantenibilidad: preferir cambio acotado y helpers existentes; no crear capa general de gestores de Node.
- Verificación/coste: seam unitario existente; evitar instalaciones y red reales. No se ejecutaron tests, auditorías, análisis de duplicación ni cobertura durante el registro.

## Methodology considered
- isswf-debug: selected para la futura ejecución; exigir reproducción del rechazo y comprobación causal discriminante con candidato/comando/resultados. Registrar limitaciones si falta acceso al formato real.
- Verification principles: selected; mapear criterios a aserciones positivas y negativas, sin usar el estado de este plan como prueba.
- isswf-security: selected para la futura ejecución; evaluar confianza del ejecutable, wrappers y congruencia de raíces, incluyendo entradas no verificables.
- isswf-tdd: not selected todavía; seam barato identificado, decidir al autorizar ejecución sin inventar evidencia RED.
- isswf-interview: not selected; objetivo acotado, incertidumbres técnicas investigables.
- Researcher: not selected; investigar primero fuente y reproducción local.
- E2E ponderado: tests deterministas de detección y runner parecen suficientes inicialmente; reevaluar si el defecto depende del proceso real. No activar suite E2E ni instalar herramientas para este registro.
- isswf-writing: selected para este registro; audiencia agente/coordinador, evidencia curada, alcance y autorización explícitos.

## Independent review and execution boundary
Revisión de seguridad y comportamiento proporcional antes de una futura entrega; identidad exacta, perfil/modelo, presupuesto y recursos canónicos se fijarán antes de dispatch. Recursos de métodos futuros aún no consumidos; exigir consumed/missing y observed/self-reported, y referencia → aplicación concreta o razón de no aplicación. No afirmar revisión independiente ni implementación verificada.

Tracking configurado: GitHub Issues, pero esta petición solo autoriza iniciativa local. Publicación remota no realizada. Setup existente describe Claude Code; una futura ejecución en Pi requiere preflight del host/modelos, sin trasladar silenciosamente esa configuración.

Next step: esperar instrucción explícita de inicio, luego confirmar causa y revisar diseño seguro. No commit ni dispatch autorizado por este brief.
