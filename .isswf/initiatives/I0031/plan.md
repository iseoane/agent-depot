# I0031: Marca de frescura de Sources y refresco en background al arrancar

Type: feature

## J001
- Status: pending
- Objective: En la vista Sources, marcar cada Source como sin refrescar/refrescando/refrescada; al arrancar la TUI refrescar en background y actualizar la marca por Source.
- Depends on: None
- Blocker: falta inicio explícito; revisar ADR 0004 (refresco antes de previews) y el refresco stale existente en catalog-view.
- Next step: research del estado de refresco actual (sources.ts, git-source.ts, catalog-view stale) y diseño de concurrencia/errores (fallo de red, Source lenta).

### Acceptance
- Cada Source muestra una marca de estado de refresco visible y accesible (no solo color).
- El arranque no bloquea por el refresco; las marcas cambian a refrescada o error por Source.
- Las previews siguen refrescando según ADR 0004; sin escrituras de estado fuera de los primitivos seguros.

- Un refresco reciente hecho en background (o ya completado) evita repetirlo en update/preview, preservando la garantía de ADR 0004 sobre datos frescos.

### Evidence
- Operador (2026-11-11): «poner una marquita en sources para indicar que está sin refrescar y cuando arrancamos la app, en background hacer el refresco e ir actualizando la marca».
- Operador: «si están hechos en background, ya no necesita hacerlos el update».
