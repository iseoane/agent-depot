# I0031: Marca de frescura de Sources y refresco en background al arrancar

Type: enhancement

## J001
- Status: completed
- Objective: En la vista Sources, marcar cada Source como sin refrescar/refrescando/refrescada; al arrancar la TUI refrescar en background y actualizar la marca por Source.
- Depends on: None
- Brief: [brief-r1.md](jobs/J001/brief-r1.md)
- Blocker: None
- Next step: None. Seguimientos: test de la espera al salir; inyectar el opt-out en vez de variable de entorno; lock huérfano.

### Acceptance
- Cada Source muestra una marca de estado de refresco visible y accesible (no solo color).
- El arranque no bloquea por el refresco; las marcas cambian a refrescada o error por Source.
- Las previews siguen refrescando según ADR 0004; sin escrituras de estado fuera de los primitivos seguros.

- Un refresco reciente hecho en background (o ya completado) evita repetirlo en update/preview, preservando la garantía de ADR 0004 sobre datos frescos.

### Evidence
- Operador (2026-11-11): «poner una marquita en sources para indicar que está sin refrescar y cuando arrancamos la app, en background hacer el refresco e ir actualizando la marca».
- Operador: «si están hechos en background, ya no necesita hacerlos el update».
- Planner (2026-11-11, main 2d53f5c): sin registro de frescura; refresh vía GitSourceAccessAdapter con lock mkdir 30 s, sin timeout ni GIT_TERMINAL_PROMPT; vistas TUI se remontan al cambiar de pestaña (estado debe vivir sobre App); packageOperationsOf no comparte sourceOperations. Diseño: módulo core en memoria `source-refresh-session.ts` (dedupe por Source, ventana, force, concurrencia 2), wrapper TUI de SourceOperations, enmienda ADR 0004.
- Defaults del coordinador: D3 solo Sources registradas; D4 el catálogo no recarga solo. Riesgo registrado: lock huérfano tras kill (fuera de alcance salvo decisión).
- Decisiones del operador (2026-11-11): D1 ventana de frescura 1 hora («el usuario puede refrescar si él quiere manualmente»); D2 refresco en segundo plano sin prompt (GIT_TERMINAL_PROMPT=0) y límite 60 s, marcado como error.
- Autorización del operador (2026-11-11): integrar I0031 sin preguntar («te doy ya mi autorización para integrarlo sin preguntarme»), sujeto a revisión independiente aprobada y CI verde.
- Worker J001: a73cb55..461fa7d, con dos rondas de corrección (ronda 2 autorizada por el coordinador por un bloqueante). Checks autoinformados finales: typecheck/lint, test 1316/0, e2e 16/16, audit:all OK.
- Revisión V001: inconclusive (sin bloqueantes; F1 contradecía D2). V002 (delta): changes required (R2-1 `r` absorbido por un refresco no forzado). V003 (delta): approve. Pendientes informativos: espera de render.tsx sin test; opt-out por variable de entorno solo usada en tests.
- Entrega: PR #105 fusionado con CI verde.
