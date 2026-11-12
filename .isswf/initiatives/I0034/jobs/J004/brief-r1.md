# I0034 J004 — Endurecer el bloqueo de la caché de Sources (r1)

Autorización: operador «ok hazlos, coordinador» y «no dejemos más deuda» (2026-11-12); integrar sin preguntar salvo algo grave. Rama `fix/source-lock-hardening`; commits en la rama; sin push/PR.
Tamaño: M — un módulo (src/git-source.ts, código de bloqueo de PR #120) con riesgo de concurrencia acotado.

## Objetivo (revisión V002 de J002)
1. S3/I2: publicar `owner.json` sin sobrescribir: escribir un temporal y `link()` a `owner.json` (EEXIST si ya existe) y borrar el temporal. Un titular que reanuda tras perder su bloqueo no puede pisar el `owner.json` del nuevo titular; si falla con EEXIST, aborta sin tocar la caché. Si `link` no está disponible en Windows, usar la alternativa segura más cercana (p. ej. `open` con `wx`) y documentarlo.
2. I1: el mutex `<lock>.recovering` lleva un id propio. El recuperador comprueba justo antes del `rm` del huérfano que el mutex sigue siendo suyo; si no, no borra. Al soltar el mutex, solo lo borra si es suyo.
3. Antes de ejecutar git, el titular verifica que `owner.json` sigue siendo el suyo.
4. S4: `rm` de liberación, recuperación y mutex con `{ maxRetries: 5, retryDelay: 50 }`.

## Aceptación
- Test: titular pausado (seam existente) pierde el bloqueo y un sucesor lo toma → al reanudar no sobrescribe `owner.json`, no ejecuta git y falla con mensaje claro.
- Test: recuperador cuyo mutex fue reclamado por otro no borra el bloqueo del sucesor.
- Tests de bloqueo existentes en verde (incluidos dos procesos reales). Linux y Windows (CI).
- Si queda algún límite residual, documentarlo en el código y en el informe (no deuda silenciosa).

## Metodología
isswf-tdd (RED real; RED/GREEN separados; cada GREEN pasa `pnpm test`); isswf-security.

## Checks
typecheck; lint; pnpm test; pnpm test:e2e; pnpm audit:all.

## Budget
Un worker, un intento + una ronda de corrección (ampliable con permiso del operador).
