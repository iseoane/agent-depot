# I0031: Marca de frescura de Sources y refresco en background al arrancar

Type: feature

## J001
- Status: in-progress
- Objective: En la vista Sources, marcar cada Source como sin refrescar/refrescando/refrescada; al arrancar la TUI refrescar en background y actualizar la marca por Source.
- Depends on: None
- Blocker: awaiting-human — D1 (ventana de frescura) y D2 (fetch colgado/credenciales).
- Next step: tras D1/D2, J001 (módulo de sesión de refresco + enmienda ADR 0004) y J002 (TUI: marcas, refresco al arrancar, reutilización en previews).

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
