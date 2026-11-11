# I0030: Progreso visible durante instalar/actualizar en la TUI

Type: feature

## J001
- Status: in-progress
- Objective: Durante install/update en la TUI, mostrar junto al contador una línea con el recurso (Skill/App/Package) y paso en curso, en lugar de una vista estática.
- Depends on: None
- Blocker: None
- Next step: planner: research de cómo los flujos core (update-flow, app-flow, package-flow, skill-install) podrían emitir eventos de progreso sin que la TUI parsee salida CLI (ADR 0006).

### Acceptance
- La vista de trabajo muestra qué se está instalando/actualizando y avanza al cambiar de recurso.
- El progreso viene de los módulos core (sin parsear salida CLI); CLI sin regresiones.
- Tests deterministas del evento de progreso y de su render.

### Evidence
- Operador (2026-11-11): «cuando instalamos o actualizamos, la ventana se queda estática con el contador de tiempo corriendo… una línea con lo que está instalando/actualizando».
- Autorización (2026-11-11): «el orden en el que las he pedido» — iniciar I0030.
