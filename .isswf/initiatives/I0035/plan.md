# I0035: Cierre de seguimientos antes de 0.6.15

Type: improvement

Decisiones del operador (2026-11-12): cerrar los seguimientos antiguos antes de la release; «✓ refreshed» sin tiempo y «… refreshing» con contador; nombres de pasos de recetas sin cambios; Updates «sources refreshed N min ago» sin cambios; recetas de Apps sin marca; los hallazgos de revisión se resuelven dentro de cada job (pedir rondas extra si hace falta); no perseguir casos extremos.

## J001
- Status: done
- Objective: Quitar el tiempo de la marca «✓ refreshed» en Sources y unificar los tres formateadores de progreso en uno.
- Depends on: None
- Brief: [brief-r1.md](jobs/J001/brief-r1.md)
- Blocker: None
- Next step: None.

### Acceptance
- Sources muestra `✓ refreshed` sin tiempo; `… refreshing Ns` sin cambios.
- bulk-actions, app-actions `stepLabel` y `formatProgressLabel` usan un único formateador con la misma salida que hoy en cada pantalla (posición omitida si total=1 salvo donde hoy se muestra; documentar y unificar).

### Evidence
- Operador: «el temporizador en refreshed sobra». Revisión I0030: tres formateadores de progreso.

## J002
- Status: in-progress
- Objective: Pulido de previews: cabecera con 0 aplicables, «Review 1 of 0», sangría y `│` en líneas partidas del árbol de pasos, desbordes por título largo o panel de trabajo, versión de origen de Package como hash.
- Depends on: J001
- Brief: [J002a brief-r1.md](jobs/J002/brief-r1.md); [J002b brief-r1.md](jobs/J002b/brief-r1.md)
- Blocker: None
- Next step: J002b (geometría): worker sonnet.

### Acceptance
- Cada punto corregido con test.

### Evidence
- Revisiones I0032 J001, J002, J003a.

## J003
- Status: pending
- Objective: Huecos de tests: golden de la CLI sin cwd y sin declaredChanges, Owned Skills, fila exacta de argv en e2e, `y` en aprobación desde Installations, paginación forzada y n/Esc en añadir/quitar hosts, Source removal sin filas encima.
- Depends on: J002
- Brief: [brief-r1.md](jobs/J003/brief-r1.md)
- Blocker: en cola tras J002.
- Next step: brief detallado tras J002.

### Acceptance
- Cada hueco cubierto por un test que falla si se rompe lo que protege.

### Evidence
- Revisiones I0032 J002, J003a, J004a, J004c.

## J004
- Status: pending
- Objective: Restos del escapado: recorte en NameField, `\X`/`\U` en mayúsculas, espacios no ASCII en rutas entrecomilladas, contador de teclas por turno compartido.
- Depends on: J003
- Brief: [brief-r1.md](jobs/J004/brief-r1.md)
- Blocker: en cola tras J003.
- Next step: brief detallado tras J003.

### Acceptance
- Cada punto corregido con test.

### Evidence
- Revisiones I0032 J005, J007.

## J005
- Status: pending
- Objective: Exportar y escritura atómica: aviso de permisos en README, test de fallo de escritura que conserva el original, fsync en atomic-file.ts.
- Depends on: J004
- Brief: [brief-r1.md](jobs/J005/brief-r1.md)
- Blocker: en cola tras J004.
- Next step: brief detallado tras J004.

### Acceptance
- README actualizado; test de fallo; escritura con fsync del fichero y del directorio donde la plataforma lo permita.

### Evidence
- Revisión I0033.
- J001 (sonnet, 6 min, 35k) entregado en PR #123 con CI verde; revisión sin hallazgos.
- J002 se parte por tamaño (regla S/M/L): J002a textos de cabecera/versión (S) y J002b geometría de líneas partidas y desbordes (M).
- J002a (sonnet) entregado en PR #124 con CI verde: cabecera sin aplicables, pie de preview vacía, `commit xxxxxxx` coherente en todas las vistas (sugerencia de la revisión resuelta en el job).
