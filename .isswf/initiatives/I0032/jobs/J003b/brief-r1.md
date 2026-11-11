# I0032 J003b — Pantallas de App con bloques de paso (r1)

Autorización: operador (recetas A, integrar sin preguntar). Rama `feat/app-step-blocks`; commits en la rama; sin push/PR.
Tamaño: M — tres superficies relacionadas que reutilizan los bloques de J003a; sin riesgo de concurrencia; cabe en una lectura.

## Objetivo
Aplicar la cabecera + bloque por paso de J003a (`stepBlockLines` en src/tui/preview-render.ts, `commandLine`) a:
1. Confirmación de App install/update/uninstall (`appPreviewLines` en src/tui/app-actions.tsx, modo `app-confirm`): cabecera `App <name> <action> (host)`, versiones `prev → latest` si existen, y el paso en bloque.
2. Paso manual de App (`app-manual` en app-actions.tsx y la desinstalación manual de recetas en src/tui/sources-recipes.tsx).
3. Paso manual en Updates (`updates-preview.ts` caso `manual`).
Eliminar `appStepLines` antiguo si queda sin uso.

## Aceptación
- No se pierde información (argv, ejecutable o «not found in PATH», cwd, entorno, manual, avisos, versiones).
- Compuerta `y` intacta en cada superficie (harness `confirmAtEnd` a 40x17, 80x24, 110x40), una sola geometría para teclas y render.
- Los tests no deben depender de cuánto cabe en una página (lección de PR #109: Windows tiene rutas más largas).
- CLI sin cambios.

## Metodología
isswf-tdd (RED real; RED/GREEN separados; cada GREEN pasa `pnpm test`).

## Checks
typecheck; lint; pnpm test; pnpm test:e2e; pnpm audit:all.

## Budget
Un worker, un intento + una ronda de corrección.
