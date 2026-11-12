# I0035 J003 — Huecos de tests (r1)

Autorización: operador (cerrar seguimientos; integrar sin preguntar salvo algo grave). Rama `test/coverage-gaps`; commits en la rama; sin push/PR.
Tamaño: M — solo tests, seis huecos concretos ya identificados por revisiones; sin cambios de producto salvo que un test destape un fallo (en ese caso parar e informar).

## Huecos
1. Golden de la CLI (tests/update-preview-golden.test.ts): casos de método externo sin `cwd` y con `declaredChanges` vacío, byte a byte.
2. Owned Skills en la revisión de recetas (app-actions.tsx ~117, PR #109 ee1069f sin test): una Skill con espacio y otra con carácter invisible se muestran sin ambigüedad.
3. e2e de argumentos delegados (tests/e2e/tui.e2e.test.ts ~1010): en una vista ancha donde la línea no se parte, afirmar la fila exacta `$ depot-e2e-app install separate argv --danger=host-setup-tail` (fronteras de argumentos).
4. Aprobación de App desde Installations (`app-approve`): `confirmAtEnd` en los tres tamaños por esa entrada (si es alcanzable; si no lo es, documentarlo con evidencia).
5. Añadir/quitar hosts (tests/tui-installations-manage.test.tsx): un caso con preview forzada a varias páginas donde `y` se ignora a mitad de lectura y `n`/Esc cancelan.
6. Quitar Source sin filas encima: App completa, tras un refresco con mensaje, `d` → la preview no muestra el mensaje anterior ni la cabecera de la lista.

## Aceptación
- Cada test falla si se rompe lo que protege (mostrar una mutación puntual por test o razonamiento verificable en el informe; sin bucles de estrés).
- Tests independientes del tamaño por defecto y de rutas largas realistas. CLI sin cambios.

## Metodología
isswf-tdd para lo que sea comportamiento; isswf-e2e para el punto 3.

## Checks
typecheck; lint; pnpm test; pnpm test:e2e; pnpm audit:all.

## Budget
Un worker, un intento + una ronda de corrección (ampliable con permiso del operador). Resolver en el job todo lo de la revisión.
