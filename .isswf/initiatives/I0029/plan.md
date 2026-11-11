# I0029: Self-update con npm de mise/Omarchy

Type: bug

## J001
- Status: in-progress
- Objective: Diagnosticar y corregir el rechazo de self update en una instalación npm global válida con Node gestionado por mise/Omarchy, preservando las verificaciones de seguridad.
- Depends on: None
- Brief: [brief-r2.md](jobs/J001/brief-r2.md)
- Blocker: None
- Next step: worker implementa corrección con TDD; luego revisión independiente, PR y CI.

### Acceptance
- Una instalación npm global válida en el formato observado de mise/Omarchy puede comprobar y aplicar self update.
- La solución conserva el rechazo de instalaciones locales, enlazadas, one-off y ejecutables npm no verificables; mantiene los controles existentes de versión y ejecución.
- Pruebas deterministas cubren el caso positivo y controles negativos; se comprueba compatibilidad con el npm habitual y Windows.
- La evidencia distingue datos aportados por el operador, reproducción local y causa confirmada.

### Evidence
- Operador: tras actualizar Omarchy, Node activo pasó de 26.8.1 a 26.13.0; npm install --global @iseoane/agent-depot@latest finalizó y agent-depot --version devolvió 0.6.12, pero self update --yes siguió rechazando la instalación.
- Operador: realpath de npm termina en node/26.13.0/bin/npm; mise resuelve Agent Depot en node/latest/bin/agent-depot. Salida de npm root --global aportada termina en lib/node_module (posible truncamiento; verificar, no normalizar como hecho).
- Lectura del coordinador: src/self-update.ts:100-127 exige realpath con sufijo npm/bin/npm-cli.js antes de consultar npm root --global. El rechazo por este control es la hipótesis principal, todavía sin reproducción causal local.
- Autorización del operador: «ok, coordinador añadelo como iniciativa». Preparación local únicamente; no implementación, commits ni publicación remota.
- Autorización del operador (2026-11-11): «coordinador vamos con I0029» — inicio de implementación.
- Reproducción del coordinador (local, Omarchy/mise, Node 26.13.0): `node/latest/bin/npm` → realpath `node/26.13.0/bin/npm`, script bash de mise que ejecuta `"$plugin_dir/bin/node" "$plugin_dir/lib/node_modules/npm/bin/npm-cli.js"` (y `mise reshim` tras installs globales). `npm root --global` = `…/node/26.13.0/lib/node_modules` completo (la salida aportada estaba truncada). Paquete presente en esa raíz; realpath del bin coincide. Causa confirmada: el guard de forma de realpath (src/self-update.ts:107) rechaza el wrapper.
