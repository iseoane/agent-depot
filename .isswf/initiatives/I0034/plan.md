# I0034: Seguimientos de I0031 e I0032

Type: improvement

## J001
- Status: done
- Objective: Probar la espera al salir de la TUI y sustituir la variable de entorno AGENT_DEPOT_NO_BACKGROUND_REFRESH por una opción inyectada.
- Depends on: None
- Brief: [brief-r1.md](jobs/J001/brief-r1.md)
- Blocker: None
- Next step: None.

### Acceptance
- Un test demuestra que `renderTui` espera a `settled()` tras salir y muestra el mensaje solo si hay refrescos en curso.
- El refresco al arrancar se desactiva en tests mediante una opción inyectada desde la CLI/tests, no leyendo el entorno en código de producción. Comportamiento de usuario sin cambios.

### Evidence
- Revisiones de I0031 (V001–V003): espera de render.tsx sin test; opt-out por variable de entorno leída en producción.

## J002
- Status: in-progress
- Objective: Recuperar el bloqueo huérfano de la caché de una Source cuando el proceso que lo tenía murió.
- Depends on: J001 integrado (orden secuencial, mismo checkout).
- Brief: [brief-r1.md](jobs/J002/brief-r1.md)
- Blocker: None
- Next step: worker sonnet tras J001.

### Acceptance
- Un bloqueo cuyo propietario ya no existe se recupera de forma segura y el refresco continúa; un bloqueo vivo sigue esperando/fallando como hoy.
- Sin falsos positivos ante dos procesos reales a la vez; Linux y Windows.

### Evidence
- I0031: si el proceso muere durante un refresco queda `<cache>.lock` y todos los refrescos de esa Source fallan tras 30 s (src/git-source.ts:551-570).

## J003
- Status: pending
- Objective: Eliminar la dependencia del tamaño de terminal por defecto en los tests que esperan `y/n` y pulsan `y`.
- Depends on: J002 integrado.
- Brief: [brief-r1.md](jobs/J003/brief-r1.md)
- Blocker: en cola tras J002.
- Next step: worker sonnet tras J002.

### Acceptance
- Los tests que confirman con `y` leen hasta `read ✓` (o fijan explícitamente un tamaño suficiente con motivo) en lugar de asumir que la preview cabe; sin debilitar aserciones.

### Evidence
- Fallos de Windows en PR #109, #114 y #115 por rutas largas; riesgo declarado en J004d.
- Autorización del operador (2026-11-12): «ok hazlos, coordinador» tras la lista de seguimientos; integración sin preguntar salvo algo grave (vigente).
- J001 worker (sonnet, 9 min, 51k) f5e3426..2999aaf. Revisión V001 (opus): 0 bloqueantes, inconcluso por evidencia no observada. Coordinador: RED e652a40 solo tests; tui-render 3/0, cli 83/0. Desviación aceptada: test de espera de caracterización (sin RED; mutación ad hoc no retenida); cableado renderTui→finishRunningRefreshes sin test (una línea).
- Operador (2026-11-12): sacar release 0.6.15 al terminar I0034 y actualizar esta máquina.
- J001 entregado: PR #119 fusionado con CI verde (Windows: test intermitente del selector de carpetas «the directory picker selects the current folder and descends into a subfolder» falló una vez y pasó al relanzar → añadir a J003).
