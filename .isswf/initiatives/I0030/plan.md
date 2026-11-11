# I0030: Progreso visible durante instalar/actualizar en la TUI

Type: feature

## J001
- Status: in-progress
- Objective: Durante install/update en la TUI, mostrar junto al contador una línea con el recurso (Skill/App/Package) y paso en curso, en lugar de una vista estática.
- Depends on: None
- Brief: [brief-r1.md](jobs/J001/brief-r1.md)
- Blocker: None
- Next step: PR abierto; CI verde → fusionar (riesgo bajo).

### Acceptance
- La vista de trabajo muestra qué se está instalando/actualizando y avanza al cambiar de recurso.
- El progreso viene de los módulos core (sin parsear salida CLI); CLI sin regresiones.
- Tests deterministas del evento de progreso y de su render.

### Evidence
- Operador (2026-11-11): «cuando instalamos o actualizamos, la ventana se queda estática con el contador de tiempo corriendo… una línea con lo que está instalando/actualizando».
- Autorización (2026-11-11): «el orden en el que las he pedido» — iniciar I0030.
- Worker J001: rango 5236b9a..62c411c (16 archivos, +271/−18). Checks autoinformados: typecheck/lint, test 1295/0, e2e 16/0, audit:all OK. Desviaciones declaradas: commits GREEN 327d258/beca884 fallan la suite completa por carrera de test (corregida en 07b3ad8); Updates muestra ruta de Skill, Catalog nombre.
- Revisión V001 (Agent-tool, no ligada; herramientas de evidencia fallaron por binding): pass. Sugerencia de seguimiento: unificar los tres formateadores de progreso (bulk-actions, app-actions stepLabel, formatProgressLabel).
