# I0033 J001 — Sobrescribir al exportar un Profile (r1)

Autorización: operador pidió la función y autorizó integrar (2026-11-11). Rama `feat/profile-export-overwrite`; commits en la rama; sin push/PR.

## Objetivo
Al exportar un Profile a un fichero existente, la TUI ofrece sobrescribirlo con confirmación explícita.

## Alcance
- TUI (src/tui/profile-view.tsx:~418, hoy `already exists; choose another name`): en vez de solo error, abrir una confirmación «Overwrite <path>? » usando el pie compartido de PR #106 (previewViewport/chrome con `action`, p. ej. "Overwrite <file>"); `y` sobrescribe, `n`/Esc vuelve al campo de nombre con el valor conservado.
- Core (src/profile-export.ts:~267, `writeFile` con `wx`): añadir opción explícita `overwrite` que escriba de forma atómica con `atomic-file.ts` y contención de rutas con `path-safety.ts` donde aplique; sin la opción, el comportamiento actual (EEXIST → error) no cambia.
- CLI: si existe `profile export`, añadir flag explícito `--overwrite` (sigue rechazando sin él; con `--yes` no basta). Si no hay comando CLI de export, no tocar la CLI y decirlo.
- Excluido: borrar ficheros, sobrescribir directorios o enlaces simbólicos (rechazar si el destino no es un fichero regular).

## Aceptación
- TUI: destino existente → confirmación; `y` reemplaza el contenido; `n` no toca el fichero.
- Nunca se sobrescribe sin confirmación; el destino que es directorio o symlink se rechaza.
- Escritura atómica (sin fichero a medias si falla).

## Metodología
isswf-tdd (RED real; commits RED/GREEN separados; cada GREEN pasa `pnpm test`). Tests con rutas en sandbox (AGENTS.md).

## Checks
typecheck; lint; pnpm test; pnpm test:e2e; pnpm audit:all.

## Budget
Un worker, un intento + una ronda de corrección.
