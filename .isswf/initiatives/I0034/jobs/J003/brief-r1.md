# I0034 J003 — Tests independientes del tamaño de terminal (r1)

Autorización: operador «ok hazlos, coordinador» (2026-11-12); integrar sin preguntar salvo algo grave. Rama `test/size-independent-confirms`; commits en la rama; sin push/PR.
Tamaño: M — solo tests, varios ficheros con el mismo patrón; sin cambios de producto.

## Objetivo
1. Localizar los tests de la TUI que esperan una pregunta `y/n` o el pie `read ✓` con el tamaño de terminal por defecto y pulsan `y` asumiendo que la preview cabe en una página (patrón que falló en Windows en PR #109, #114 y #115 por rutas temporales largas). Cambiarlos para que lean hasta el final con los helpers existentes (`confirmAtEnd`, `readToEnd`) o, si el test trata de otra cosa, fijar un tamaño amplio con un comentario del motivo. No debilitar ninguna aserción.
2. Arreglar el test intermitente de Windows «the directory picker selects the current folder and descends into a subfolder» (falló una vez en el CI de PR #119 con `/\.\. \(parent folder\)/` sin coincidir y pasó al relanzar): diagnosticar la causa (espera insuficiente, orden de lectura del sistema de ficheros, ancho) y hacerlo determinista.

## Aceptación
- Ningún test de confirmación depende del tamaño por defecto; búsqueda documentada de los casos cubiertos.
- El test del selector de carpetas es determinista (causa explicada).
- Sin cambios en `src/`. Suite completa en verde; CI de Windows en verde.

## Metodología
isswf-debug para el test intermitente (causa con evidencia). Sin RED de producto: es trabajo de tests; mostrar que cada test modificado sigue fallando si se rompe la compuerta `y` (mutación puntual, conservar el registro en el informe).

## Checks
typecheck; lint; pnpm test; pnpm test:e2e.

## Budget
Un worker, un intento + una ronda de corrección.
