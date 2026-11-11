# I0033: Sobrescribir al exportar un Profile

Type: feature

## J001
- Status: pending
- Objective: Al exportar un Profile a un fichero que ya existe, ofrecer sobrescribirlo (con confirmación explícita) en vez de solo pedir otro nombre.
- Depends on: I0032 J001 (pie de confirmación).
- Blocker: en cola tras integrar I0032 J001 (antes de J002).
- Next step: diseño con confirmación de sobrescritura en TUI (profile-view.tsx:418) y flag explícito en CLI si aplica (profile-export.ts:267 usa `wx`); escritura atómica (atomic-file.ts).

### Acceptance
- Si el destino existe, la TUI pregunta si sobrescribir; `y` sobrescribe de forma atómica, `n` vuelve a pedir nombre.
- Sin confirmación nunca se sobrescribe; la CLI conserva el rechazo salvo flag explícito.

### Evidence
- Operador (2026-11-11): «al exportar si el fichero destino existe, da la posibilidad de sobrescribir»; autoriza completar I0032 y sacar release al acabar.
- Código: src/profile-export.ts:267-269 (`wx`, EEXIST → error), src/tui/profile-view.tsx:418.
- Operador (2026-11-11): «lo de sobrescribir no lo haces?» — se hará en esta tanda, antes de J002, e irá en la release.
- Autorización del operador (2026-11-11): integrar sin preguntar salvo algo grave que requiera confirmación.
