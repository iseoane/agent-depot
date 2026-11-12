# I0035 J005 — Exportar y escritura atómica (r1)

Autorización: operador (cerrar seguimientos; integrar sin preguntar salvo algo grave). Rama `fix/atomic-write-durability`; commits en la rama; sin push/PR.
Tamaño: S/M — un módulo compartido (src/atomic-file.ts) con efecto en todas las escrituras de estado, un test y una línea de README.

## Objetivo (revisión I0033)
1. `writeFileAtomically` (src/atomic-file.ts): antes del `rename`, `fsync` del fichero temporal; después del `rename`, `fsync` del directorio padre donde la plataforma lo permita (en Windows abrir un directorio para fsync no está soportado: omitirlo sin error). Un corte de luz no debe dejar el fichero destino vacío. Mantener el comportamiento actual en todo lo demás (permisos, limpieza del temporal en fallo).
2. Test: si la escritura falla (p. ej. fallo inyectado en la escritura o en el `rename`, o carpeta de solo lectura en POSIX), el fichero original queda intacto y no queda ningún temporal. Que el test no dependa de ser root ni de la plataforma más allá de saltarse donde no aplique.
3. README (sección de `profile export --overwrite`, ~974): indicar que sobrescribir crea un fichero nuevo y no conserva permisos, propietario ni enlaces duros del original.

## Aceptación
- Tests del punto 2 y de que fsync se invoca (seam inyectable o espía) en el orden correcto; suite completa en verde en Linux y Windows (CI). CLI sin cambios de salida.

## Metodología
isswf-tdd (RED real; RED/GREEN separados; cada GREEN pasa `pnpm test`). Proporcionado.

## Checks
typecheck; lint; pnpm test; pnpm test:e2e; pnpm audit:all.

## Budget
Un worker, un intento + una ronda de corrección (ampliable con permiso del operador). Resolver en el job todo lo de la revisión.
