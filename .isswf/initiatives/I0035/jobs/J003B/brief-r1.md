# I0035 J003b — Reaprobar desde Installations una receta cambiada (r1)

Autorización: operador (no dejar deuda; integrar sin preguntar salvo algo grave). Rama `fix/installations-reapprove`; commits en la rama; sin push/PR.
Tamaño: S/M — un flujo (Installations › App seguida con receta cambiada); sin concurrencia.

## Problema
`inspectEntry` (src/app-flow.ts ~240-242) devuelve el resultado guardado «installed» antes de comprobar la aprobación cuando hay una versión en caché, así que la fila sigue mostrando «1.0.0 (recorded)» y Enter (src/tui/installations-browse.ts ~143-149) dice «demo is already approved» aunque `approvalStatus` es «needs approval». No hay ejecución sin aprobación (planLifecycle/executeLifecycle lo impiden), pero no se puede reaprobar desde ahí y el mensaje engaña.

## Objetivo
- La fila de una App seguida cuya receta necesita aprobación lo indica (p. ej. «needs approval» junto a la versión registrada).
- Enter en esa fila abre la revisión de aprobación de la receta (la misma de Sources, pie compartido); tras aprobar, la fila se actualiza.
- Elegir el punto de corrección más pequeño y seguro (comprobar la aprobación en `inspectEntry` antes de devolver lo guardado, o consultar `apps.approvalStatus` en la fila/Enter), sin cambiar la CLI ni los bloqueos de ejecución existentes.
- Actualizar el test del hueco 4 de J003 (tests/tui-installations-app.test.tsx ~621-641) para que fije `confirmAtEnd` en los tres tamaños.

## Aceptación
Ver plan. Tests de Updates/Installations existentes en verde.

## Metodología
isswf-tdd (RED real; RED/GREEN separados; cada GREEN pasa `pnpm test`).

## Checks
typecheck; lint; pnpm test; pnpm test:e2e; pnpm audit:all.

## Budget
Un worker, un intento + una ronda de corrección (ampliable con permiso del operador). Resolver en el job todo lo de la revisión.
