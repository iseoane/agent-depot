# J001 — Self-update con npm de mise/Omarchy (r2)

Supersedes r1. Authorization: operador «coordinador vamos con I0029» (2026-11-11): implementación local en rama `fix/self-update-mise-npm`, commits en esa rama. Sin push/PR (los hace el coordinador).

## Causa confirmada (coordinador, reproducción local)
mise sustituye `<prefix>/bin/npm` por un script bash (no symlink) que ejecuta `<prefix>/bin/node <prefix>/lib/node_modules/npm/bin/npm-cli.js` y hace `mise reshim` tras installs globales. `src/self-update.ts` npmGlobalExecutable exige que realpath(npm) termine en `npm/bin/npm-cli.js` → devuelve undefined → "not verified in npm's global package directory". `npm root --global` y la comparación de packageRoot pasarían.

## Objetivo y aceptación
Ver ../../plan.md (Acceptance). Diseño sugerido (validar con criterio de seguridad): análogo a la rama Windows npm.cmd — si el ejecutable resuelto no es symlink a npm-cli.js, verificar el npm-cli.js hermano en `<dir(npm)>/../lib/node_modules/npm/bin/npm-cli.js` (realpath con la forma esperada) y mantener las comprobaciones posteriores (npm root --global absoluto, paquete directorio, realpath(packageRoot) == realpath(instalado)). Seguir ejecutando el ejecutable npm resuelto (preserva reshim de mise). No aceptar cualquier wrapper sin npm-cli.js verificable; mantener rechazos existentes (locales, enlazados, one-off). Cambio mínimo, sin capa genérica de gestores de Node.

## Alcance
src/self-update.ts, tests/self-update.test.ts. Excluido: tocar mise/Node del usuario, instalaciones/red reales en tests, push/PR.

## Metodología (obligatoria)
- isswf-tdd: test RED primero (wrapper no-symlink con npm-cli.js hermano → hoy unsupported), mostrar salida roja, luego GREEN. Más controles negativos: wrapper sin npm-cli.js hermano; npm-cli.js hermano con forma incorrecta; raíz/packageRoot discordante.
- isswf-security: frontera de confianza del ejecutable npm.
- isswf-debug: causa ya confirmada arriba; no repetir salvo discrepancia.

## Checks
pnpm test:single tests/self-update.test.ts; pnpm typecheck; pnpm lint; pnpm test.

## Budget
Un worker, un intento de corrección. Reportar recursos consumidos, evidencia RED/GREEN, diff y commits.
