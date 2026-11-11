# I0032 J003a — Revisión de recetas de App (opción A) (r1)

Autorización: operador eligió recetas A y autorizó integrar (2026-11-11). Rama `feat/recipe-review-blocks`; commits en la rama; sin push/PR. Tamaño: S/M (una pantalla + un arreglo acotado).

## Objetivo
La preview de aprobación de receta (Sources › recetas, `recipe approve`; hoy `appRecipePreviewLines`/`appStepLines` en src/tui/app-actions.tsx y prefijo "Recipes named X" en src/tui/sources-recipes.tsx:~137) se muestra con el modelo de PR de J002 (`src/preview-model.ts`, `src/tui/preview-render.ts`):
- Cabecera: nombre en negrita, plataforma, estado con punto (`● needs approval`), y en gris fichero · homepage. Owned Skills si las hay.
- Un bloque por paso (`┌ install`, `├ check`, `├ update`, `└ uninstall`) con el comando `$ cmd args` (mismo `commandLine` de J002) y debajo en gris `ejecutable · in cwd`; `not found in PATH` en color de aviso; pasos manuales con su texto; avisos del paso visibles.
- Pie compartido: acción "Approve <app>", consecuencia "approval does not install".
Mockup: /tmp/claude-1000/-home-iseoane-Work-agent-depot/df8c75c0-e3d3-4391-a0d8-709e868bce70/scratchpad/tui-previews.html (sección 1, Propuesta A).

## Arreglo incluido (revisión J002)
`commandLine` (src/preview-model.ts): escapar caracteres invisibles o de formato (`\p{Cf}`, p. ej. U+202E, zero-width) y de control para que un argumento no pueda aparentar otro; test.

## Fuera de alcance
Confirmación/desinstalación/paso manual de Apps y Updates manual (J003b); CLI (sin cambios).

## Aceptación
- Toda la información de la preview anterior sigue presente (fichero, nombre, plataforma, estado, homepage, Owned Skills, cada paso con argv/ejecutable/cwd/manual/avisos).
- La compuerta `y` intacta (harness `confirmAtEnd` a 40x17, 80x24, 110x40).
- e2e de aprobación de receta y argumentos delegados exactos (tui.e2e.test.ts ~959-1012) pasan; ajustar matchers deliberadamente.

## Metodología
isswf-tdd (RED real; RED/GREEN separados; cada GREEN pasa `pnpm test`).

## Checks
typecheck; lint; pnpm test; pnpm test:e2e; pnpm audit:all.

## Budget
Un worker, un intento + una ronda de corrección.
