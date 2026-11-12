# I0033: Sobrescribir al exportar un Profile

Type: enhancement

## J001
- Status: completed
- Objective: Al exportar un Profile a un fichero que ya existe, ofrecer sobrescribirlo (con confirmación explícita) en vez de solo pedir otro nombre.
- Depends on: None
- Brief: [brief-r1.md](jobs/J001/brief-r1.md)
- Blocker: None
- Next step: None (seguimientos en Evidence).

### Acceptance
- Si el destino existe, la TUI pregunta si sobrescribir; `y` sobrescribe de forma atómica, `n` vuelve a pedir nombre.
- Sin confirmación nunca se sobrescribe; la CLI conserva el rechazo salvo flag explícito.

### Evidence
- Dependía de I0032 J001 (pie de confirmación), ya integrado en PR #106.
- Operador (2026-11-11): «al exportar si el fichero destino existe, da la posibilidad de sobrescribir»; autoriza completar I0032 y sacar release al acabar.
- Código: src/profile-export.ts:267-269 (`wx`, EEXIST → error), src/tui/profile-view.tsx:418.
- Operador (2026-11-11): «lo de sobrescribir no lo haces?» — se hará en esta tanda, antes de J002, e irá en la release.
- Autorización del operador (2026-11-11): integrar sin preguntar salvo algo grave que requiera confirmación.
- Worker J001: 894d9ba..2b34101. Revisión V001 (Agent-tool): Spec pass, sin bloqueantes; Standards inconcluso por checks no observados → el coordinador observó test:single profile 36/0 y tui-profile 38/0; CI del PR. Seguimientos: documentar pérdida de permisos/hardlinks al sobrescribir; test de fallo de escritura; fsync en atomic-file.ts.
- Entrega: PR #107 fusionado con CI verde.
