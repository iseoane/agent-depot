# Agent Depot

[English](README.md) · **Español**

Agent Depot es un gestor multiplataforma de los recursos reutilizables que usan los
agentes de programación. Descubre Skills a partir de Sources de Git, las instala en
uno o varios Hosts (Pi, Claude Code, Codex y OpenCode), gestiona Apps globales de
usuario y Packages nativos del Host, registra lo que ha instalado y lo actualiza de
forma segura, todo desde una CLI o una TUI interactiva.

Qué hace:

- **Sources y catálogo**: registra repositorios Git (además de la Source integrada
  `builtin:agent-depot`) y descubre los Skills que contienen.
- **Instalar Skills** a nivel global de usuario o por proyecto, en varios Hosts a la
  vez, fijados a una versión o siguiendo la última. Un manifiesto de proyecto permite
  que un checkout nuevo reinstale los mismos Skills.
- **Actualizaciones**: comprueba y aplica actualizaciones por lotes; cada cambio se
  previsualiza antes y requiere confirmación explícita.
- **Instalaciones existentes**: informa de los Skills no gestionados que ya hay en
  disco, adopta los que coinciden exactamente con una Source o los elimina mediante
  una ruta explícita.
- **Apps**: instala, actualiza y desinstala aplicaciones globales de usuario mediante
  App recipes escritas por el usuario que deben aprobarse antes de ejecutarse.
- **Packages**: instala, actualiza y desinstala bundles nativos del Host (paquetes de
  Pi y plugins de Claude Code) delegando el ciclo de vida en la CLI de cada Host y
  leyendo la versión instalada de los propios archivos de estado del Host. Un bundle
  reserva sus Skills solo mientras lo hayas seleccionado o un Host demuestre que está
  instalado, así que los Skills de un bundle no seleccionado siguen siendo instalables
  por separado.
- **Profiles**: exporta tus Sources, selecciones de Skills, App recipes y selecciones
  de Packages globales de usuario a un archivo portable e impórtalos, solo añadiendo,
  en otra máquina.

Agent Depot nunca sobrescribe ni elimina contenido sin una previsualización y una
confirmación, y rechaza rutas y enlaces inseguros.

Requiere Node.js >= 24 (Active LTS). La [TUI interactiva](#tui-interactiva)
necesita un terminal interactivo.

## Instalación

Agent Depot se publica como el paquete con ámbito `@iseoane/agent-depot` y expone el
comando `agent-depot`. Requiere Node.js >= 24.

```sh
# Ejecutar sin instalar
npx @iseoane/agent-depot --version
npx @iseoane/agent-depot tui
pnpm dlx @iseoane/agent-depot tui

# O instalar globalmente
npm install --global @iseoane/agent-depot
pnpm add --global @iseoane/agent-depot
agent-depot --version
```

Los ejemplos siguientes usan el comando `agent-depot`; `npx @iseoane/agent-depot <args>`
funciona igual sin instalación global.

### Actualización

`npx` puede reutilizar una copia en caché de una versión anterior. Añade `@latest`
para forzar la versión más reciente:

```sh
npx @iseoane/agent-depot@latest tui
pnpm dlx @iseoane/agent-depot@latest tui
```

Una instalación global se actualiza con el gestor de paquetes que la instaló:

```sh
npm install --global @iseoane/agent-depot@latest
pnpm add --global @iseoane/agent-depot@latest
```

Un Agent Depot en ejecución nunca degrada los Skills integrados: un Skill instalado
por un Agent Depot más reciente se notifica como no actualizable (actualiza primero
Agent Depot).

## Uso

Con el paquete instalado (o mediante `npx @iseoane/agent-depot`). `agent-depot --help`
(también `-h` o `help`) muestra el uso y termina con código 0; ejecutarlo sin
argumentos o con un comando desconocido es un error de uso y termina con código 1.

```sh
agent-depot source list
agent-depot source add https://github.com/example/skills.git
agent-depot source refresh git:<source-id>
agent-depot source refresh git:<source-id> --yes
agent-depot source remove git:<source-id> --yes
agent-depot source remove git:<source-id> --skill <id|path> --yes
agent-depot source migrate git:<old-source-id> git:<new-source-id> --skill <path> --yes
agent-depot discover builtin:agent-depot git:<source-id>
agent-depot install --scope project --source builtin:agent-depot --skill architecture --host pi --version latest --portable-v1 --yes
agent-depot install --scope user-global --source builtin:agent-depot --skill architecture --host pi --version latest --portable-v1 --yes
# Only for an explicitly reviewed, untracked real-directory conflict:
agent-depot install --scope project --source builtin:agent-depot --skill architecture --host pi --version latest --portable-v1 --overwrite --yes
agent-depot install --scope project --manifest --portable-v1 --yes
agent-depot update check --scope project
agent-depot update apply --scope project --all --yes
agent-depot update apply --scope user-global --skill 0 --yes
agent-depot skill remove <id|path>... --yes
agent-depot skill remove <id|path> --host <host>... --yes
agent-depot skill host add <id|path> --host <host>... --yes --confirm-additional-host
agent-depot uninstall --cli
agent-depot uninstall --skills --yes
agent-depot uninstall --unmanaged-skill <exact-global-path> --yes
agent-depot uninstall --data --yes
agent-depot app list
agent-depot app approve <name> --yes
agent-depot app install <name> --yes
agent-depot package list
agent-depot package discover <source-id>
agent-depot package inspect <source-id>::<bundle-path> --host <host>
agent-depot package approve <source-id>::<bundle-path> --host <host> --action install
agent-depot package install <source-id>::<bundle-path> --host <host> --yes
agent-depot package forget <source-id>::<bundle-path> --host <host> --yes
agent-depot update check --scope user-global --package <selection>
agent-depot export --out profile.json
agent-depot import profile.json --yes
agent-depot tui
agent-depot --version
```

También se admiten URLs de directorios de GitHub, como
`https://github.com/cursor/plugins/tree/main/pstack`: Agent Depot clona el
repositorio, lee la referencia de la URL y solo descubre Skills dentro de ese
directorio. Las rutas de los Skills siguen siendo relativas al repositorio.
La URL completa conserva la identidad de la Source; si ya está registrada,
basta con refrescarla. La referencia ocupa un segmento de la URL: codifica los
`/` del nombre de una rama como `%2F` (por ejemplo `tree/release%2Fstable/pstack`).
Una referencia explícita de versión fija sustituye la de la URL, pero mantiene
el directorio seleccionado.

Los grupos del Catálogo muestran nombres de repositorios en lugar de IDs Git.
Catálogo e Installations empiezan con todos los grupos contraídos; usa Enter o
la flecha derecha para abrirlos. Un filtro del Catálogo expande automáticamente
las Sources con coincidencias.

El Catálogo de la TUI avisa por cada Source no disponible y permite seguir
navegando por las demás. Para crear una caché ausente, ve a Sources (`1`) y
refresca con `r`; abrir el Catálogo no inicia acceso a la red.

`refresh` primero muestra como previsualización la URL registrada. Requiere
confirmación explícita con `--yes` antes de cualquier acceso a la red y, en caso
contrario, falla de forma cerrada. La Source `builtin:agent-depot`, propiedad del
paquete, se lista como de solo lectura y no puede refrescarse.

La eliminación de una Source es solo global de usuario y nunca lee manifiestos de
proyecto ni borra cachés de Sources. Previsualiza todos los Skills globales de
usuario dependientes y mantiene todos ellos registrados por defecto. Pasa
`--skill <id|path>` para un subconjunto seleccionado o `--all` para todos los Skills
dependientes. Se aceptan índices numéricos para la lista de dependientes, pero una
ruta de Skill literal compuesta solo por dígitos tiene prioridad sobre su índice
numérico. El borrado de Skills siempre requiere `--yes`; el contenido adoptado y el
contenido modificado localmente (o que carece de una línea base de confianza)
reciben advertencias.
La comprobación previa rechaza rutas inseguras, enlaces inesperados, instalaciones
inexistentes, destinos seleccionados que se solapan y otros fallos de inspección
antes de cambiar el estado de la Source o de borrar ningún Skill. Una segunda
comprobación previa compara el resumen del contenido de cada destino, el indicador
de adopción y el estado de modificación antes del primer borrado.

`skill remove <id|path>...` elimina los Skills gestionados globales de usuario
seleccionados sin tocar su Source. Cada `<id|path>` es la ruta exacta del Skill o su
último segmento de ruta cuando es único; las selecciones desconocidas o ambiguas
fallan antes de cambiar nada. Previsualiza cada borrado (con advertencias de
adoptado/modificado), requiere `--yes`, vuelve a comprobar los destinos y después
borra los archivos y sus registros de instalación. Es solo global de usuario: las
instalaciones y manifiestos de proyecto nunca se leen ni se modifican, y la caché de
Git se conserva.

`skill host add <id|path> --host <host>... [--yes] [--confirm-additional-host]`
expone un Skill global de usuario ya instalado a más Hosts sin cambiar su contenido
ni su versión, y después registra los nuevos Hosts. Los Hosts distintos de Claude
comparten la ubicación canónica `~/.agents/skills/<skill>` y Claude es un enlace
simbólico a ella, por lo que solo se crea, como mucho, el enlace simbólico de Claude
que falte. La previsualización lista las nuevas ubicaciones; como expone el Skill a
más Hosts, necesita tanto `--yes` como `--confirm-additional-host`. Rechaza una
ubicación de Claude que ya contenga algo distinto del enlace simbólico gestionado, y
un Skill que no esté instalado en la ubicación canónica (exponerlo requeriría
copiarlo).

`skill remove <id|path> --host <host>... [--yes]` elimina únicamente esos Hosts. Por
esta vía solo se puede borrar el enlace simbólico gestionado de Claude; el
directorio canónico respalda a todos los Hosts restantes (incluido el enlace
simbólico de Claude) y permanece hasta que se elimina el último Host. Eliminar todos
los Hosts registrados es una eliminación completa con las advertencias habituales de
adoptado/modificado. Los destinos se vuelven a comprobar antes de borrar y el
registro se actualiza después. Las instalaciones de proyecto no se ven afectadas.

Para sustituir la URL de una Source, registra primero la nueva Source Git y después
migra explícitamente las identidades globales de usuario con `source migrate <old-id> <new-id> (--skill <path>... |
--all) [--yes]`. La migración reescribe solo los registros globales de usuario
seleccionados: nunca mueve instalaciones físicas ni reescribe manifiestos de
proyecto. Las colisiones de identidad se rechazan. Las políticas de versión fija se
conservan solo cuando la Source de reemplazo aporta evidencia de commit coincidente;
en caso contrario se elimina la evidencia de la Source resuelta anterior. Las líneas
base de contenido siguen ligadas a la instalación sin cambios, y los métodos
proporcionados por el usuario se conservan para su revisión en lugar de reescribirse.

## Opciones de desinstalación

La desinstalación es solo global de usuario y nunca lee ni cambia manifiestos de
proyecto. Las opciones son independientes: `--skills` elimina todos los Skills
gestionados globales de usuario, `--unmanaged-skill <exact-global-path>` elimina
únicamente directorios reales no gestionados seleccionados explícitamente bajo
`~/.agents/skills` o `~/.claude/skills`, `--data` elimina el archivo de estado de
catálogo/configuración y `--cli` muestra el traspaso al gestor de paquetes para
eliminar la CLI persistente. La eliminación de no gestionados nunca busca ni infiere
una Source, rechaza enlaces simbólicos, rutas transitorias/de copia de seguridad,
árboles inválidos, rutas gestionadas y solapamientos, y solo borra de forma
permanente después de mover el árbol sin cambios a un área de preparación del mismo
directorio padre. Los Skills y los datos del catálogo se conservan cuando se omiten
sus indicadores. Eliminar Skills reconcilia sus registros de instalación; eliminar
los datos conservando los Skills deja esos Skills sin registrar. Todo borrado del
sistema de archivos requiere `--yes` tras la previsualización completa, y la
previsualización de no gestionados advierte de que Agent Depot no puede garantizar la
recuperación sin una Source resoluble. Inmediatamente antes de cada eliminación
destructiva, Agent Depot vuelve a leer los registros de instalación gestionados y
falla de forma cerrada si han cambiado o si ahora reclaman la ruta seleccionada. El
almacén de estado de las Sources serializa las actualizaciones cooperantes, pero un
proceso no cooperante aún puede provocar una condición de carrera entre la última
comprobación y el renombrado/borrado en el sistema de archivos; los fallos de
preparación restauran la ruta original cuando se conoce el resultado y, en caso
contrario, conservan la ruta de preparación con un error de estado incierto. Agent
Depot nunca invoca ni infiere un gestor de paquetes, y las cachés de las Sources Git
se conservan. `uninstall --cli` muestra los comandos exactos
(`npm uninstall --global @iseoane/agent-depot`, `pnpm remove --global @iseoane/agent-depot`);
las ejecuciones con `npx`/`pnpm dlx` no necesitan desinstalación, solo dejan una
entrada de caché.

## Actualizaciones por lotes

Comprueba cualquiera de los dos ámbitos de instalación independientes antes de
aplicar actualizaciones:

```sh
agent-depot update check --scope project
agent-depot update check --scope user-global
```

La comprobación informa por separado de los Skills gestionados `Updateable`,
`Current` y `Unknown`. `Unknown` significa que una selección gestionada registrada
no pudo evaluarse de forma segura (por ejemplo, porque no está disponible la
evidencia de su Source o de su versión); sigue siendo gestionada, pero no es
actualizable. Solo para `--scope user-global`, la comprobación también informa de los
directorios de Skill reales `Unmanaged` encontrados en ubicaciones absolutas exactas
bajo las raíces globales de usuario admitidas. Estos no son candidatos a
actualización, no se incluyen en los recuentos de estado de los gestionados y nunca
se buscan a través de una Source. Las comprobaciones de proyecto no inventarían ni
informan de directorios no gestionados.

Las entradas globales omitidas o inseguras se muestran por separado con
orientaciones y no son entradas Unmanaged ni candidatas a eliminación. Pueden ser
enlaces simbólicos, raíces o archivos de Skill inseguros, o rutas transitorias de
Agent Depot; inspecciónalas manualmente. El flujo posterior de eliminación de no
gestionados requiere su propia previsualización de ruta exacta y confirmación
explícita.

Aplica todos los Skills actualizables o selecciona uno o varios por su ID de
actualización impreso, su índice numérico o una ruta de Skill inequívoca:

```sh
agent-depot update apply --scope project --all --yes
agent-depot update apply --scope user-global --skill 0 --yes
agent-depot update apply --scope user-global --package git:<source-id>::pi:. --yes
```

Solo para `--scope user-global`, la comprobación también evalúa cada Package
registrado y `update apply` acepta `--package <selection>` repetible o incluye los
Packages actualizables con `--all`. Un Package con estado de versión `unknown`
nunca se ofrece como actualización. Los Packages se ejecutan después de los Skills
y las Apps, cada Package seleccionado previsualiza su plan congelado y se aprueba
mediante `package approve --action update` el recibo de actualización que falte antes de ejecutar desde la CLI. El ámbito de proyecto nunca lee ni
selecciona un Package.

Un Skill registrado en una ruta de proyecto no canónica (fuera de
`.agents/skills/<name>` y `.claude/skills/<name>`) está controlado por el
repositorio, por lo que `--yes` por sí solo no lo actualiza. La previsualización
imprime la ruta relativa; repite el comando con `--confirm-path` (una vez por cada
ruta de ese tipo):

```sh
agent-depot update apply --scope project --all --yes --confirm-path vendor/alpha
```

Aplicar siempre previsualiza primero cada candidato seleccionado. `--yes` es
obligatorio y confirma cada candidato de forma independiente; sin él no se cambian
archivos ni estado. Las instalaciones modificadas se señalan y nunca se sobrescriben
sin esa confirmación explícita. Los comandos de actualización externos muestran su
vector de argumentos exacto, el directorio de trabajo, el destino, los cambios
declarados y una advertencia de que los efectos secundarios no pueden verificarse ni
revertirse. Los Skills de versión desconocida se notifican pero no pueden
seleccionarse para su aplicación, y los fallos independientes se resumen después de
que terminen los candidatos restantes.

`discover` requiere uno o más ID de Source en cada invocación. Usa `source list` para
encontrar los ID registrados. Lee el HEAD actual del espejo Git en caché sin
refrescarlo, así que ejecuta primero `source refresh <id> --yes` cuando un espejo no
esté disponible o esté obsoleto. Imprime una línea `Candidate:` separada por
tabuladores por cada Skill reconocido con este formato:

```text
Candidate: <source-id>\t<skill-path>\t<name>\t<description>
```

El descubrimiento solo presenta candidatos. No persiste la selección de Sources, no
selecciona candidatos ni instala nada automáticamente.

## Instalación global de usuario

Las instalaciones globales de usuario usan las mismas ubicaciones canónicas de Host
bajo el directorio personal del usuario (`.agents/skills/<skill>` y, cuando se
solicita, un enlace simbólico de Claude en `.claude/skills/<skill>`). Son
independientes de los manifiestos de proyecto y se registran en el estado compartido
de Sources por usuario, de modo que distintas invocaciones de la CLI reutilizan los
mismos registros de instalación. La Source, el Skill, los Hosts y la ubicación real
adoptada o instalada seleccionados se previsualizan antes de la confirmación con
`--yes`.

Una instalación directa de proyecto o global de usuario puede configurar su método de
instalación antes de la primera instalación con `--method <json>`. El valor debe ser
un único objeto de método JSON estricto, por ejemplo:

```sh
agent-depot install --scope user-global --source builtin:agent-depot \
  --skill architecture --host pi --version latest \
  --method '{"kind":"command","argv":["node","scripts/install.mjs"],"cwd":"tools"}' \
  --portable-v1 --yes
```

El método se almacena como `methods.install`, tiene prioridad sobre los metadatos de
la Source y se ejecuta a partir de un vector de argumentos sin shell. El comando y
los cambios previstos se previsualizan antes de la confirmación. Esta opción solo
configura el método de instalación; la ejecución de actualizaciones no forma parte de
este ciclo de vida.

## Instalación de proyecto

La instalación de proyecto requiere un `--scope project` explícito, un ID de Source,
la ruta del Skill, uno o más valores de `--host` (`pi`, `claude`, `codex` u
`opencode`) y una política de versión (`--version latest` o
`--version fixed:<value>`). Las Sources externas requieren un commit de Git fijo de
40 o 64 caracteres. Para la Source integrada, `latest` sigue el paquete de Agent
Depot instalado, mientras que una política fija solo se acepta cuando su valor es
exactamente igual a la versión actual de ese paquete; los demás valores fallan de
forma cerrada porque la versión de paquete solicitada no puede reproducirse. Un
manifiesto escrito por otro Agent Depot sigue siendo cargable: un Skill integrado
fijado a una versión distinta aparece como desconocido en `update check` ("pinned to
Agent Depot X; running Y") y `install --manifest` lo omite, mientras que los demás
Skills siguen funcionando. La Source integrada no admite `--ref`, y la CLI lo rechaza
explícitamente. Un `latest` externo puede seguir una ref mutable segura explícita,
pero una ref de commit inmutable debe usar una política fija que coincida con ese
commit. El indicador `--portable-v1` exige la regla de formato portable validada; la
compatibilidad se deriva de los bytes de origen y de las exclusiones en lugar de
confiar en una afirmación del llamante. Se admite un directorio `agents/` relativo
al Skill: sus archivos permanecen dentro del árbol del Skill seleccionado y se
instalan en `.agents/skills/<skill>/agents/`, en lugar de tratarse como un
directorio `agents/` a nivel de Host. Otros directorios de primer nivel específicos
de Host, como `.claude`, `.codex`, `.opencode`, `.pi`, `extensions`, `plugins` y
`mcp`, quedan fuera del formato portable V1.

La CLI lee el árbol inmutable del Skill seleccionado antes de pedir `--yes`. Las
incompatibilidades con el formato portable se rechazan antes de la confirmación o de
cualquier escritura, mostrando en el error la ruta de origen rechazada y el motivo.
La identidad y el contenido del destino inspeccionados se arrastran a través de la
confirmación y se comprueban de nuevo inmediatamente antes del reemplazo; si hay
deriva, se aborta sin mover el destino. Una previsualización correcta lista los
archivos seleccionados exactos, incluidos los archivos de agents relativos al Skill
admitidos, y solo un `--yes` confirmado procede a la instalación.

Una instalación confirmada escribe `agent-depot.json` en la raíz del proyecto. El
manifiesto almacena la identidad integrada o una URL canónica externa, la ruta del
Skill, la política de versión y los Hosts, de modo que
`install --scope project --manifest` pueda resolverlo sin el catálogo global de
Sources. Los manifiestos portables rechazan las Sources de ruta local porque su
identidad no es resoluble de forma independiente. Las Sources Git externas solo se
refrescan tras la confirmación.

El árbol completo del Skill se copia byte a byte y se conservan los modos
ejecutables. Antes de la confirmación se inspeccionan las ubicaciones de Host
existentes y se muestran los conflictos. El contenido idéntico se adopta en su sitio;
un Skill ya registrado como gestionado debe cambiarse con `update apply`, no con una
nueva instalación. Por defecto no se sobrescribe ninguna ruta existente. Para un
directorio real sin registrar cuyo contenido difiere, el reemplazo requiere tanto
`--overwrite` como `--yes`:

```sh
agent-depot install --scope project --source builtin:agent-depot \
  --skill architecture --host pi --version latest --portable-v1 --overwrite --yes
```

La previsualización es explícita sobre esta distinción: sin `--yes` no se modifica
ningún archivo ni estado de instalación; con ambos indicadores, informa de que el
destino será reemplazado y muestra el patrón de copia de seguridad
`.agent-depot-backup-<generated-suffix>`. El mismo contrato se aplica a
`--scope user-global`. Los enlaces simbólicos, los archivos especiales, los árboles
inseguros, las ubicaciones ambiguas de Claude y las condiciones de carrera entre la
previsualización y la mutación fallan de forma cerrada. El reemplazo primero mueve el
directorio original exacto a una copia de seguridad persistente junto a la
instalación y después instala el árbol inmutable de la previsualización. La CLI
imprime la ruta de la copia de seguridad; las copias de seguridad correctas nunca se
borran automáticamente. Los fallos de reemplazo en el sistema de archivos y de
manifiesto/estado global se restauran dentro del proceso antes de devolver el error.
La reversión verifica la copia de seguridad retenida y el contenido de reemplazo
antes de borrar el reemplazo y falla de forma cerrada cuando alguno de los dos ha
cambiado. Estas son las comprobaciones portables del sistema de archivos más fuertes
disponibles, no un compare-and-swap atómico entre procesos: un escritor externo aún
puede provocar una condición de carrera tras la comprobación final, por lo que Agent
Depot no afirma serializar escritores concurrentes. Esto no es una recuperación ante
caídas: una caída del proceso después de mover el original puede dejar el directorio
`.agent-depot-backup-*` retenido sin un estado de reemplazo garantizado. Detén la
CLI, inspecciona la copia de seguridad y el destino, y renombra manualmente la copia
de seguridad retenida a la ruta de instalación prevista cuando sea necesaria la
recuperación; después vuelve a ejecutar la instalación. Los métodos de instalación
externos solo se ejecutan después de que la transacción del sistema de archivos y del
estado del ámbito seleccionado haya tenido éxito.
Claude se expone mediante un enlace simbólico a la instalación canónica
`.agents/skills/<skill>`.

## Métodos de instalación proporcionados por el usuario

Una selección de proyecto puede persistir métodos portables de instalación y de
futura actualización en su campo `methods`:

```json
{
  "source": { "kind": "external", "url": "https://example.com/skills.git", "ref": "main" },
  "path": "portable/example",
  "version": { "policy": "latest" },
  "hosts": ["pi"],
  "methods": {
    "install": { "kind": "command", "argv": ["node", "scripts/install.mjs"], "cwd": "tools" },
    "update": { "kind": "command", "argv": ["node", "scripts/update.mjs"] }
  }
}
```

La misma forma de selección se almacena bajo `userGlobalInstallations` en el estado
compartido `sources.json` global de usuario. `methods.install` tiene prioridad sobre
un método declarado por la Source seleccionada; el método de la Source solo se usa
cuando no existe un método de instalación configurado. El método `update` configurado
actualmente solo se persiste; la ejecución de actualizaciones pertenece al flujo de
actualización.

Antes de ejecutar cualquier método configurado o de la Source, la CLI previsualiza el
argv exacto, el cwd resuelto del proyecto o global de usuario, los archivos
seleccionados y las ubicaciones de instalación previstas. Requiere `--yes`
explícito; rechazar la previsualización no realiza ninguna instalación ni ejecuta
ningún método. Los métodos son vectores de argumentos, nunca cadenas de shell: deben
usar un único comando portable sin variantes específicas del sistema operativo, y se
rechazan los intérpretes de shell y la sintaxis de shell. La configuración no debe
contener credenciales literales. La validación rechaza patrones evidentes de
credenciales con el mejor esfuerzo posible; no puede detectar todos los secretos, por
lo que los usuarios siguen siendo responsables de evitar secretos en los argumentos o
en los archivos del repositorio.

Un método confirmado se ejecuta como código arbitrario de un proceso hijo, sin
sandbox. Puede cambiar cualquier ubicación del sistema de archivos o sistema externo
disponible para ese proceso; Agent Depot no puede previsualizar ni revertir esos
efectos secundarios. La instalación gestionada del Skill y el manifiesto/estado se
persisten antes de la ejecución del método, y un fallo del método conserva esos
registros. Los metadatos de la Source se leen de la misma instantánea de árbol
inmutable mostrada en la previsualización, no de una relectura mutable de la última
versión.

Una Source puede declarar un método de instalación únicamente mediante un archivo de
metadatos JSON explícito dentro del Skill seleccionado (`.agent-depot.json`,
`agent-depot-method.json` o `installation-method.json`), nunca a partir de la prosa
de `SKILL.md`. El archivo puede contener el objeto de método o
`{ "method": { "kind": "command", "argv": ["executable", "arg", ...],
"cwd": "optional/project-relative-directory" } }`. El ejecutable debe ser un nombre
de comando simple y seguro, y `cwd` debe permanecer por debajo de la raíz del
proyecto tras resolver el realpath. Un método confirmado sigue pasando por la
validación de compatibilidad, la instalación canónica y la ruta del enlace simbólico
de Claude. Se rechazan las instalaciones por lotes que contengan métodos porque los
efectos secundarios de procesos hijos arbitrarios no se pueden revertir. Las entradas
de manifiesto que identifican una ruta local externa son rechazadas por el
resolvedor exclusivo de Git con un error accionable de Source no admitida; las
Sources por URL siguen siendo autocontenidas y resolubles en una máquina nueva.

## TUI interactiva

```sh
agent-depot tui
```

La TUI es un front end de [Ink](https://github.com/vadimdemedes/ink) (React para
terminales) sobre las mismas operaciones que la CLI. Necesita Node.js >= 24 y un
terminal interactivo; en caso contrario, `tui` falla con un error. Cambia de vista
con `1`-`5` y sal con `q` (no mientras haya un aviso abierto). Toda lista se
desplaza cuando es más alta que el terminal. `j`/`k` o las flechas mueven la
selección.

| Vista | Propósito |
| --- | --- |
| 1 Sources | Sources de Git (sus skills y Packages) y recetas App del usuario en una sola lista, con tipos `skills`/`app` y acciones contextuales. |
| 2 Catalog | Skills que se pueden instalar: los que aún no están instalados, como Source y luego Skills. Cada Source muestra además un grupo Packages, y los Skills que posee un bundle se marcan y se atenúan. |
| 3 Installations | Lo que hay en disco: instalaciones gestionadas (globales de usuario y de proyecto), selecciones de Packages y skills globales de usuario no gestionados. |
| 4 Updates | Skills y Packages gestionados con una versión más reciente disponible, para el ámbito global de usuario y de proyecto. |
| 5 Import/Export | Transferir las elecciones portables de Sources globales de usuario, las selecciones de Skills, las App recipes y las selecciones de Packages. |

Teclas por vista (los avisos también aceptan `Esc` para cancelar y `y`/`n` para
confirmar):

| Vista | Teclas |
| --- | --- |
| Sources | `j`/`k` recorren Sources de Git y recetas App, sin cambiar de sección con Tab. `Enter` abre el Catálogo de una Source de Git (sus skills y Packages) o previsualiza/aprueba una receta. `n` añade una Source de Git reutilizable o guía la creación de recetas; `r` refresca Sources o recarga el estado de recetas; `d` elimina. `space`/`a` solo marcan Sources de Git. |
| Catalog | `Enter`/flechas expandir y contraer, `space` marcar, `a` marcar todos los listados, `i` instalar las Skills marcadas (o el skill resaltado) o previsualizar el bundle de Package resaltado, `/` filtrar, `s` alternar entre una Source o todas (cuando se abre desde una Source) |
| Installations | `Enter`/flechas expandir y contraer, `u` desinstalar (todos los Hosts o los Hosts elegidos) o eliminar un skill no gestionado, `h` o `i` añadir Hosts a una instalación, `A` o `Enter` adoptar un skill no gestionado, `space` marca una hoja y `a` marca todas las hojas visibles: con marcas, `u` y `h` actúan sobre todas ellas con una única previsualización combinada y una única confirmación (las instalaciones de proyecto se omiten con un motivo). En una fila de Package: `i` previsualiza el plan de instalación congelado y lo ejecuta, aprobando antes el recibo si falta; `Enter` solo aprueba la declaración de instalación; `U` actualiza, `u` desinstala, `f` olvida el registro de selección. Las filas de Package no se pueden marcar para acciones por lotes. |
| Updates | `space` marcar, `a` marcar todo, `t`/`p`/`g` mostrar todo, proyecto o global de usuario, `Enter` previsualizar las marcas, `r` comprobar de nuevo, las flechas pliegan la línea "cannot assess". Un Package marcado se une al lote y se aprueba antes de ejecutar su actualización. |
| Import/Export | `e` exportar, `i` importar; introduce una ruta de archivo, `space` alterna opciones, `a` alterna todas, `Enter` previsualiza, `y` aplica; `j`/`k` desplazan las previsualizaciones y los resultados |

Al eliminar una receta App se comprueban su comando de versión aprobado y su
seguimiento. Si la App está instalada o sigue registrada, la TUI ofrece el flujo
existente de desinstalación: `n` cancela la eliminación y un fallo conserva la
receta. Tras verificar la desinstalación —o si no está instalada— se confirma por
separado el borrado exclusivo del archivo o enlace de la receta. No se eliminan
implícitamente datos de la App ni configuración de Hosts. Las recetas inválidas
deben repararse antes de poder comprobar el estado de su App.

Modelo de seguridad:

- No se escribe nada antes de una previsualización y un `y` explícito. Exponer un
  skill a un Host adicional necesita una segunda confirmación, separada, como
  `--confirm-additional-host`.
- Una instalación refresca su Source Git antes de la previsualización, de modo que el
  contenido que confirmas es el contenido que se aplica. La vista Updates refresca
  las Sources Git en uso cuando entras en ella y con `r`.
- Una acción de Package previsualiza la declaración congelada y los comandos exactos
  del Host. Si falta el recibo de la acción, el primer `y` lo aprueba y un segundo `y`
  ejecuta el comando del Host; una acción ya aprobada se ejecuta con el primer `y`.
  `n` o `Esc` en cualquiera de las dos puertas cancela sin aprobar ni ejecutar nada.
  Listar y recargar Packages nunca ejecuta un comando del Host.
- La Source integrada es fija: se muestra como una fila no seleccionable y no puede
  refrescarse ni eliminarse.
- La eliminación es solo global de usuario. Las instalaciones de proyecto se listan,
  pero la desinstalación de proyecto no está admitida (`u` sobre una fila de proyecto
  muestra un mensaje).
- Los skills no gestionados se eliminan solo desde las rutas listadas en la
  previsualización. Un enlace simbólico se elimina como enlace; su destino nunca se
  toca.
- Las instalaciones y eliminaciones por lotes se aplican elemento a elemento; un
  fallo no detiene a los demás y cada elemento informa de su propio resultado.

Consulta [CONTEXT.md](https://github.com/iseoane/agent-depot/blob/main/CONTEXT.md) para ver los términos del dominio y [docs/adr](https://github.com/iseoane/agent-depot/tree/main/docs/adr) para ver las decisiones que hay detrás de la TUI.

## Configuración y caché

El catálogo de Sources y los registros de instalación globales de usuario se
almacenan juntos en:

- Linux y otras plataformas Unix: `$XDG_STATE_HOME/agent-depot/sources.json`,
  o `~/.local/state/agent-depot/sources.json` cuando `XDG_STATE_HOME` no está
  definida.
- Windows: `%APPDATA%/Agent Depot/sources.json` (con respaldo en el directorio
  `AppData/Roaming` del usuario).

Los espejos Git se almacenan en caché por separado del catálogo:

- Linux y otras plataformas Unix: `$XDG_CACHE_HOME/agent-depot/git-sources`,
  o `~/.cache/agent-depot/git-sources`.
- Windows: `%LOCALAPPDATA%/Agent Depot/git-sources`.

## Limitaciones

Los Packages están limitados a los Hosts Pi y Claude Code en V1. El empaquetado de
Codex y OpenCode, los paquetes de Pi procedentes de npm, los Packages de ámbito de
proyecto y los marketplace de Claude externos quedan aplazados, y una selección de
Claude de versión fija se rechaza; consulta [Packages](#packages).

Solo se aceptan URL de repositorios Git que usen `git:`, `http:`, `https:` o `ssh:`.
`refresh` usa la URL registrada y ejecuta Git con matrices de argumentos, sin shell.
Crea u obtiene un espejo bare, sincroniza explícitamente todas las refs y poda las
refs eliminadas; no hace checkout de archivos, no instala skills ni elige Sources
automáticamente. Se requiere acceso a la red para un refresh confirmado.

## Desarrollo

Desde un checkout de código fuente, compila y ejecuta la CLI directamente:

```sh
pnpm install
pnpm build
node dist/src/cli.js --version
```

## Análisis estático

[Fallow](https://docs.fallow.tools) 3.30.0 se ejecuta mediante `npx --yes fallow@3.30.0`
(fijado, sin instalar ninguna dependencia) y lee `.fallowrc.json`, que define los
puntos de entrada y los límites de las capas de módulos (`cli` -> `tui` -> `application`
-> `core` -> `infrastructure`; las importaciones solo pueden apuntar hacia abajo, y
`cli` también puede usar directamente las capas inferiores). `scripts/**` forma una
zona aislada `tooling`. Todo archivo fuente debe pertenecer a una zona; los módulos
de App y Profile están en `application`, excepto `atomic-file.ts`, que está en
`infrastructure`.

- `pnpm audit:dead-code`: archivos, exportaciones y dependencias sin usar, además de
  violaciones de límites. Debe salir limpio.
- `pnpm audit:dupes`: duplicación de código (umbral del 6%).
- `pnpm audit:health`: complejidad y puntuaciones CRAP usando cobertura real; falla
  cuando la puntuación de salud cae por debajo de 85.
- `pnpm audit:all`: ejecuta las tres comprobaciones en orden.
- `pnpm test:coverage`: ejecuta los tests con la cobertura V8 integrada
  (`NODE_V8_COVERAGE`, source maps) en `coverage/v8`, que Fallow lee.
  Recompila `dist/` con source maps; no se necesitan dependencias adicionales.

## App recipes globales de usuario

Coloca recipes JSON propiedad del usuario en `apps/`, junto al `sources.json` por
usuario (Linux/WSL: `${XDG_STATE_HOME:-~/.local/state}/agent-depot/apps`; Windows:
`%APPDATA%\Agent Depot\apps`). Las recipes nunca se reescriben ni las suministran las
Sources.

```sh
agent-depot app schema
agent-depot app validate /path/to/example.json
agent-depot app list
agent-depot app approve example --yes
```

La validación previsualiza cada argv declarado y su ejecutable resuelto, pero nunca
aprueba recipes (`validate --yes` se rechaza). Revisa la previsualización antes de
usar `app approve <name> --yes`: la aprobación autoriza los comandos de versión, no
solo un comportamiento de solo lectura. Los recibos de aprobación privados y escritos
de forma atómica viven en el directorio hermano `app-approvals/` y están ligados a la
ruta canónica del archivo y al hash exacto de su contenido. Si cambian los bytes, se
requiere una nueva aprobación; restaurar los bytes aprobados restaura la aprobación.
`app list` nunca aprueba recipes. Las recipes inválidas se muestran con sus motivos;
la validación termina con código distinto de cero para recipes inválidas. Las recipes
de otras plataformas se notifican como no aplicables y nunca se ejecutan. WSL cuenta
como Linux y nunca ejecuta ejecutables cuyo realpath esté bajo `/mnt/<drive>/`; omite
esos candidatos del PATH mientras busca ejecutables de Linux. Los comandos lanzan el
candidato del PATH en lugar del realpath para que los shims y los binarios multicall
conserven su identidad.

Los campos obligatorios son `name`, `install`, `update`, `uninstall` y `version`. Los
pasos del ciclo de vida contienen `argv`, `manual` o ambos; el texto manual nunca se
ejecuta. `version` contiene un `argv` seguro sin shell y un `pattern` de expresión
regular de JavaScript con un grupo de captura. Los comandos se ejecutan desde el
directorio personal del usuario. Una comprobación de versión sin éxito o no
resoluble significa no instalado. El esquema describe la estructura; `app validate`
además impone la seguridad del argv y la semántica de la expresión regular.

### Instalar, actualizar y desinstalar

```sh
agent-depot app install example          # solo previsualización; termina con código distinto de cero hasta que se confirma
agent-depot app install example --yes
agent-depot app update example --yes
agent-depot app uninstall example --yes
agent-depot app setup example --host pi --host codex --yes
agent-depot app teardown example --host pi --yes
```

Cada paso previsualiza su texto argv/manual, el ejecutable resuelto, el directorio de
trabajo (el personal del usuario) y el entorno. El recurso manual solo se produce
cuando un proceso no puede lanzarse, nunca tras una salida con código distinto de
cero (que se notifica con stdout/stderr). Ejecuta tú mismo las instrucciones manuales
mostradas y después certifica la finalización sin volver a ejecutar el argv:

```sh
agent-depot app install example --manual-done --yes
agent-depot app uninstall example --manual-done --yes
```

`--yes` por sí solo no certifica la finalización manual. La instalación registra una
versión solo cuando la comprobación de versión tiene éxito. La desinstalación
mantiene el seguimiento mientras la versión siga teniendo éxito;
`agent-depot app uninstall example --forget --yes` elimina explícitamente el
seguimiento sin ejecutar ningún comando de la recipe, incluso si la recipe ya no
existe. Los registros atómicos por App viven en el directorio hermano
`app-installations/`. La desinstalación no ejecuta implícitamente el teardown de Host.

`app list` y `update check --scope user-global` resuelven las últimas versiones desde
GitHub Releases, npm o un `latest.argv` aprobado. Las consultas ausentes o fallidas
son desconocidas y nunca se ofrecen como actualizaciones. Las peticiones HTTP
públicas no envían credenciales, rechazan redirecciones, limitan las respuestas a
1 MiB y expiran a los cinco segundos.

```sh
agent-depot update apply --scope user-global --all --yes
agent-depot update apply --scope user-global --skill 0 --app example --yes
agent-depot app update example --manual-done --yes
```

`--all` incluye Apps y Skills; repite `--app <name>` para seleccionar Apps junto con
Skills. Las actualizaciones de Apps se ejecutan **después de los Skills** en el mismo
lote. Las Apps son solo globales de usuario; `--all --scope project` omite las Apps.
Cada paso seleccionado se previsualiza antes de la confirmación del lote; los fallos
independientes no detienen las actualizaciones restantes. Los resultados manuales del
lote se completan por separado con `app update --manual-done`. Las actualizaciones
registran la versión confirmada por el comando de versión de la recipe, no la
respuesta del registro. Las actualizaciones requieren un cambio de versión; las
versiones sin cambios fallan sin reescribir el seguimiento de lo instalado. Una `v`
inicial y los cambios de SemVer que solo afectan a los metadatos de compilación
cuentan como sin cambios, igual que en las comprobaciones de disponibilidad. Los
resultados correctos muestran `installed <old> -> <new> (latest <latest>)`, incluso
cuando new difiere de latest. Una previsualización/recurso manual de actualización
confirmado guarda evidencia privada de versión en el directorio hermano
`app-pending-updates/`, de modo que una invocación posterior de `--manual-done` pueda
comparar con la versión previa a la actualización. Una finalización manual
certificada consume esta evidencia incluso en caso de fallo; obtén una nueva
previsualización confirmada antes de reintentar.

La comparación estricta de SemVer ignora una `v` inicial, ordena las prereleases y no
ofrece una degradación cuando la versión instalada es igual o posterior a la última.
Las versiones que no son SemVer usan una desigualdad opaca y **pueden ofrecer una
degradación**. GitHub `/releases/latest` excluye borradores y prereleases; npm usa
`dist-tags.latest` de los metadatos del paquete. `app list` comprueba las Apps de
forma concurrente, conservando el orden del listado. El fallo de la comprobación de
una App no oculta otras Apps ni las actualizaciones de Skills. Los fallos de consulta
muestran sus motivos (redirección, límite de peticiones, estado HTTP, tiempo de
espera agotado, respuesta demasiado grande o inválida).


Los comandos del ciclo de vida de las Apps no son interactivos: stdin se ignora
(EOF), como en el ejecutor de comandos de Skills existente, y no hay tiempo límite de
ejecución. Las recipes deben usar indicadores no interactivos; los instaladores que
requieren un terminal pertenecen a los pasos `manual`. EOF hace que los avisos
basados en stdin fallen en lugar de esperar una entrada, pero un proceso que ignore
EOF aún puede quedarse colgado; cancélalo manualmente. Los stdout y stderr
capturados de las Apps están limitados cada uno a 1 MiB; los fallos muestran solo
sus últimos 4 KiB.

El setup/teardown de Apps solo acepta Hosts declarados para esa acción. Todos los
pasos seleccionados se previsualizan antes de la ejecución; cada Host obtiene un
resultado y los fallos no detienen a los Hosts restantes. Para la finalización
manual, vuelve a ejecutar el Host seleccionado con `--manual-done --yes`. Esto
comprueba la versión de la App, no la integración con el Host. Las acciones de Host
nunca cambian el seguimiento de Apps instaladas.

## Packages

Un Package es un bundle nativo del Host descubierto dentro de una Source registrada:
un paquete de Pi (un `package.json` con una clave `pi`, o los directorios
convencionales `extensions/`, `skills/`, `prompts/` y `themes/`) o un plugin de Claude
Code (un `.claude-plugin/plugin.json` vinculado por un
`.claude-plugin/marketplace.json` dentro del repositorio). Un mismo repositorio puede
ser ambas cosas, como `pstack-claude`. V1 solo admite los Hosts Pi y Claude Code; el
empaquetado de Codex y OpenCode, los paquetes de Pi procedentes de npm y los Packages
de ámbito de proyecto quedan aplazados.

Agent Depot no copia el contenido de un bundle. Lee el manifiesto del bundle en un
inventario de componentes tipado, deriva los comandos propios del Host a partir de esa
declaración, los ejecuta mediante el ejecutor de comandos sin shell tras la aprobación
y lee la versión instalada de los archivos de estado del Host. El Host posee lo que
está instalado. Agent Depot posee el registro de selección y el recibo de lo que
delegó. Los Skills propios de un bundle nunca se ofrecen para adopción ni se instalan
por segunda vez, porque el Host posee sus archivos y ubicaciones.

### Añadir una Source y descubrir sus bundles

El descubrimiento lee el espejo Git en caché y nunca lo refresca. El primer
descubrimiento de una Source cuyo espejo falta falla hasta que refresques esa Source:

```sh
agent-depot source add https://github.com/michael-denyer/pstack-claude.git
agent-depot source list
agent-depot source refresh git:<source-id> --yes
agent-depot package discover git:<source-id>
```

`package discover` imprime una línea por bundle de la Source junto con su inventario
de componentes. `pstack-claude` produce un bundle de Pi en la raíz del repositorio y
un bundle de Claude desde su marketplace dentro del repositorio:

```text
Package git:<source-id>::pi:.: pstack
Package git:<source-id>::claude:.#pstack: pstack
```

Cada línea de componente indica un tipo, una propiedad (`skill-category` o
`host-only`), un efecto y las rutas declaradas. Las definiciones de agente y los
servidores MCP aparecen como `host-only`: Agent Depot los informa y los deja al Host.

### Seleccionar, aprobar y ejecutar una acción de ciclo de vida

Una selección es `<source-id>::<bundle-path>` más `--host`, o una selección
cualificada por Host `<source-id>::<host>:<bundle-path>`. La ruta de un bundle de
Claude termina en `#<plugin-name>` cuando la Source ofrece más de un plugin.

`approve` es por acción. Escribe el recibo de la declaración exacta de esa única
acción, por lo que aprobar `install` no autoriza `update`. `--yes` confirma la
ejecución y nunca sustituye a la aprobación. Planificar una acción de ciclo de vida
refresca primero la Source Git de la selección, de modo que el manifiesto
previsualizado es el que usan los comandos.

```sh
# Paquete de Pi en la raíz del repositorio
agent-depot package inspect git:<source-id>::pi:. --host pi
agent-depot package install git:<source-id>::pi:. --host pi
agent-depot package approve git:<source-id>::pi:. --host pi --action install
agent-depot package install git:<source-id>::pi:. --host pi --yes

# Plugin de Claude Code desde el marketplace dentro del repositorio
agent-depot package inspect git:<source-id>::claude:.#pstack --host claude
agent-depot package approve git:<source-id>::claude:.#pstack --host claude --action install
agent-depot package install git:<source-id>::claude:.#pstack --host claude --yes
```

Los comandos `install`, `update` y `uninstall` imprimen la previsualización completa y
después terminan con código distinto de cero hasta que exista el recibo de la acción
y se indique `--yes`. La previsualización muestra el origen y el commit resueltos, el
descriptor, el inventario de componentes con su propiedad y efecto, cada comando del
Host con el nombre de su ejecutable, las coordenadas registradas que la acción puede
cambiar (`affects`), el directorio de trabajo, el entorno y cualquier advertencia.
Inmediatamente antes de la ejecución, Agent Depot vuelve a derivar la declaración y se
detiene con `stale plan` si el manifiesto, el commit, la identidad de instalación o
los comandos ordenados cambiaron desde la previsualización. Cuando el Host ya informa
del bundle como instalado, el plan no ejecuta ningún comando y solo registra la
selección.

Los comandos del Host para los dos Hosts de V1:

| Host | Instalar | Actualizar | Desinstalar |
| --- | --- | --- | --- |
| Pi | `pi install <source>` | `pi update <source>` | `pi remove <source>` |
| Claude Code | `claude plugin marketplace add <source>`, después `claude plugin install <plugin>@<marketplace>` | `claude plugin marketplace update <marketplace>`, después `claude plugin update <plugin>@<marketplace>` | `claude plugin uninstall <plugin>@<marketplace>` |

Agent Depot omite el paso `marketplace add` cuando el Host ya conoce el marketplace y
siempre nombra el marketplace en el verbo de actualización con ámbito. Cada acción de
V1 afecta solo a su propia selección.

### Estado instalado, versiones y eliminación

`package list` muestra cada selección registrada con su ID de instalación y la
evidencia de versión que Agent Depot registró. La evidencia en vivo procede de
`~/.pi/agent/settings.json` y `~/.claude/plugins/installed_plugins.json`, que Agent
Depot lee y nunca escribe. Un archivo de Host ausente es una vista vacía. Un archivo
desviado o ilegible deja la búsqueda afectada en `unknown` y nunca lanza una
excepción. Un paquete git de Pi sin versión se informa como `unknown`, nunca como
`current`.

Una actualización registra una versión nueva solo cuando el estado del Host cambió de
una forma que Agent Depot puede verificar, es decir, cuando las dos observaciones
coinciden en una versión o en un commit hexadecimal y difieren, o cuando el Host pasó
de no tener nada instalado a instalado. Una actualización no verificable falla y deja
el registro intacto. `uninstall` delega el comando del Host y después elimina el
registro de selección:

```sh
agent-depot package approve git:<source-id>::pi:. --host pi --action uninstall
agent-depot package uninstall git:<source-id>::pi:. --host pi --yes
agent-depot package forget git:<source-id>::pi:. --host pi --yes
```

`forget` elimina solo el registro de selección de Agent Depot. No ejecuta ningún
comando del Host y deja la instalación del Host tal cual.

### Límites de los Packages

- Una selección de Claude de versión fija no puede delegarse. `claude plugin install`
  toma `<plugin>@<marketplace>` y no tiene hueco para un pin, así que planificar un
  `install` o `update` de Claude con una política de versión `fixed` falla en cerrado
  en lugar de reclamar un pin que el Host ignoraría. Usa `latest` para una selección
  de Claude, o un pin fijo para una selección de Pi, hasta que se verifique una forma
  de pin admitida por Claude.
- Un plugin de Claude sin vinculación a un marketplace dentro del repositorio se
  informa pero no es instalable.
- Agent Depot no lee la salida en prosa de la CLI del Host, incluido `pi list`. La
  evidencia instalada procede solo de los archivos de estado del Host.

## Exportar un Profile global de usuario

Exporta las elecciones portables a otra máquina o guárdalas en git:

```sh
agent-depot export > profile.json
agent-depot export --out profile.json
agent-depot export --no-apps --source <source-id> --skill doctor-md-agents
agent-depot export --no-sources --no-skills --app my-tool --app another-tool
agent-depot export --package git:<source-id>::pi:.
```

Todo lo portable se selecciona por defecto. `--no-sources`, `--no-skills`,
`--no-apps` y `--no-packages` excluyen bloques; `--source <id|url>`,
`--skill <path|name>`, `--app <name>` y `--package <selection>`, que son repetibles,
restringen cada bloque de forma independiente. Las selecciones desconocidas y
combinar el filtro de inclusión de un bloque con su indicador `--no-*` son errores.

La salida estándar contiene solo JSON; stderr muestra la previsualización y los
motivos de exclusión. `--out` requiere un archivo nuevo (los archivos existentes y
los enlaces simbólicos no se reemplazan). Los Profiles contienen URL de Git
canónicas con su inclusión en el descubrimiento, las políticas de versión/Hosts/
métodos de usuario registrados de los Skills, recipes de App completas, incluidas
las recipes de otras plataformas, y selecciones de Package solo como declaraciones:
su Source, coordenadas de Host y política de versión. La exportación por CLI siempre
escribe
`included: true`; las elecciones de descubrimiento son transitorias, mientras que la
TUI puede pasar elecciones de inclusión explícitas al núcleo de exportación
compartido. La exportación no refresca Sources ni ejecuta comandos de Apps, y un
recibo de Package nunca viaja en un Profile.

Las rutas locales y las credenciales evidentes no son portables. Los elementos no
portables o inválidos se excluyen con sus motivos, al igual que los Skills no
gestionados, propiedad de Apps y de proyecto, las ubicaciones/evidencia de
instalación, los recibos de aprobación, el estado de las Apps instaladas, las
actualizaciones pendientes y los recibos/estado instalado de los Packages. Las
comprobaciones de portabilidad del texto libre de las
recipes son conservadoras; revisa los Profiles antes de compartirlos: los secretos
arbitrarios no pueden detectarse automáticamente.

## Importar un Profile global de usuario

Primero previsualiza y después confirma explícitamente la misma selección:

```sh
agent-depot import profile.json
agent-depot import profile.json --yes
agent-depot import profile.json --no-apps --skill doctor-md-agents --yes
```

La importación usa los mismos filtros independientes por bloque/nombre que la
exportación, incluidos `--no-packages` y `--package <selection>`. Informa de **add**
(añadir), **same** (igual, omitido) y **conflict**
(conflicto, con la diferencia mostrada, omitido). Sin `--yes` no se escribe nada. Las
elecciones existentes y los archivos en conflicto nunca se reemplazan. Un Profile
producido por una versión más reciente de Agent Depot genera una advertencia, no un
error.

Las adiciones confirmadas se ejecutan en orden: registro de Sources, Skills globales
de usuario mediante las previsualizaciones de instalación refrescadas y las
comprobaciones de seguridad normales, después las App recipes y a continuación las
selecciones de Packages. Se conservan los
Hosts, las políticas de versión y los métodos de usuario registrados. Incluso sin
`--yes`, la previsualización de cada Skill a añadir muestra su Source, Hosts,
política de versión y el argv completo de cada método proporcionado por el usuario,
marcado como que se ejecuta solo tras la confirmación. La previsualización de
instalación normal sigue apareciendo antes de la ejecución. Cada fallo se notifica
de forma independiente y los elementos restantes continúan; cualquier elemento
fallido hace que el comando termine con código distinto de cero.

Una selección de Package es solo una selección. La importación la reproduce mediante
la acción `select` del flujo, que escribe un recibo solo para esa acción, cuya
declaración no contiene ningún argv. No autoriza ninguna instalación ni actualización
y no ejecuta ningún comando del Host, así que la importación nunca instala un Package.

Las recipes, incluidas las de otras plataformas, llegan **sin aprobar** a `apps/`.
Una recipe de destino con el mismo nombre bloquea la importación solo cuando su
plataforma se solapa con la de la recipe entrante: las plataformas iguales se
solapan, y una plataforma ausente se solapa con todas las plataformas. Las recipes
de plataformas disjuntas pueden añadirse ambas. El JSON de recipe inválido usa su
nombre y plataforma en bruto para la misma comprobación; los archivos de nombre
desconocido se notifican con detalles de lectura/análisis sin bloquear Apps no
relacionadas. Un Profile no puede contener recipes del mismo nombre cuya aplicabilidad
de plataforma se solape. La importación nunca instala Apps ni ejecuta comandos de
recipes. Revisa y aprueba las recipes aplicables con
`agent-depot app approve <name> --yes` antes de usar sus comandos de ciclo de vida.
La inclusión de una Source en el descubrimiento sigue siendo una elección transitoria
del frontend, no un cambio persistente en una Source existente. Los Skills llevan su
propia identidad de Source, por lo que omitir su bloque de Sources no fuerza el
registro; la previsualización nombra las Sources no registradas que se obtendrán sin
registrarse. Las filas de Sources existentes explican cuándo la inclusión en el
descubrimiento difiere pero no se importa.

La pestaña **5 Import/Export** de la TUI ofrece listas de verificación agrupadas y
las mismas previsualizaciones del núcleo compartido que la CLI. Las exclusiones y los
conflictos no pueden seleccionarse. La exportación solo crea un archivo nuevo; las
exportaciones vacías no escriben nada (la CLI informa de un error). La importación
añade las elecciones que faltan sin reemplazar las existentes. Las recipes importadas
permanecen sin aprobar y la importación nunca instala Apps. Las selecciones de Package
importadas se registran sin instalar ningún bundle y sin ejecutar ningún comando del
Host.
