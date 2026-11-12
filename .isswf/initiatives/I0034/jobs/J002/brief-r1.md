# I0034 J002 — Recuperar bloqueos huérfanos de la caché de Sources (r1)

Autorización: operador «ok hazlos, coordinador» (2026-11-12); integrar sin preguntar salvo algo grave. Rama `fix/source-lock-recovery`; commits en la rama; sin push/PR.
Tamaño: M — un módulo (src/git-source.ts, `acquireSourceLock` ~551-570) con riesgo de concurrencia acotado entre procesos; sin cambios de UI.

## Problema
`acquireSourceLock` crea `<cache>.lock` con `mkdir` y lo borra al terminar. Si el proceso muere (kill, cierre de terminal, corte de luz) el directorio queda y todo refresco posterior de esa Source espera 30 s y falla con "lock directory is busy".

## Objetivo
- Al adquirir, escribir dentro del lock un fichero de propietario (pid, hostname, hora de inicio, y un identificador aleatorio) de forma atómica.
- Si el lock está ocupado, leer el propietario: si es del mismo host y su pid ya no existe (`process.kill(pid, 0)` → ESRCH; tratar EPERM como vivo), o si el lock no tiene fichero de propietario y es más antiguo que un umbral generoso (p. ej. 10 min, para locks de versiones anteriores o escritura interrumpida), recuperarlo de forma segura: renombrar el directorio a un nombre único de descarte (operación atómica; si otro proceso ya lo hizo, el rename falla y se reintenta la adquisición normal), borrarlo y reintentar `mkdir`.
- Un lock de otro host o con pid vivo se comporta como hoy (espera y error claro).
- Mantener la comprobación de enlace simbólico existente; no seguir enlaces al leer/borrar; usar `path-safety.ts` donde aplique.
- Mensaje de error actual mejorado si sigue ocupado: indicar pid/host del propietario.

## Aceptación
- Test: lock con propietario cuyo pid no existe → se recupera y el refresco continúa.
- Test: lock con pid vivo (el propio proceso de test u otro hijo vivo) → no se recupera; espera/falla como hoy.
- Test: dos adquisiciones concurrentes sobre un lock huérfano → solo una recupera y ambas terminan serializadas, sin borrar el lock de la otra.
- Test: lock antiguo sin fichero de propietario se recupera; reciente sin propietario no.
- Funciona en Linux y Windows (CI). Sin estado fuera del sandbox en tests (AGENTS.md: inyectar rutas).

## Metodología
isswf-tdd (RED real; RED/GREEN separados; cada GREEN pasa `pnpm test`); isswf-security (borrado de directorios: sin seguir enlaces, contención).

## Checks
typecheck; lint; pnpm test; pnpm test:e2e; pnpm audit:all.

## Budget
Un worker, un intento + una ronda de corrección.
