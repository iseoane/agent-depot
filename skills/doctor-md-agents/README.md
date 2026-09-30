# doctor-md-agents

Audita los ficheros de instrucciones que se inyectan en cada prompt —`AGENTS.md`, `CLAUDE.md` y los que le indiques— contra el historial real de sesiones locales del propio usuario. Emite un informe HTML con, por regla: cuántas veces fue aplicable, si se obedeció, cuántas veces el usuario tuvo que corregir a mano sobre ese punto, lo que cuesta en tokens, y un veredicto de **mantener / mejorar / borrar**. Después propone las reglas que *faltan*, minadas de correcciones repetidas que ninguna regla actual cubre.

Todo corre en local. No sube transcripciones, ficheros de sesión ni instrucciones a ningún sitio.

## Instalación

El repositorio es la copia real; la skill se expone mediante symlink:

```bash
ln -s /path/to/doctor-md-agents ~/.agents/skills/doctor-md-agents
```

## Uso

Invoca la skill (`doctor-md-agents`) desde tu agente. `SKILL.md` es el contrato completo: 7 pasos, de extraer las reglas a proponer las ediciones. **Nunca modifica los ficheros de instrucciones**; las propuestas van a un directorio temporal y aplicarlas es una decisión aparte.

Los argumentos solo preseleccionan respuestas a las preguntas del Paso 0; nunca ejecutan la skill por intención inferida:

```
/doctor-md-agents --mode restructure --files repo
```

Este ejemplo concreto queda totalmente dirigido por argumentos: al fijar `--mode restructure` y `--files repo`, y si ningún fichero del repo tiene ya bloques `<important if>`, la skill no pregunta nada — ni siquiera qué conversaciones minar, porque con *Restructure only* cubriendo todos los ficheros seleccionados los Pasos 2–4 nunca se ejecutan.

## Qué mide, y qué no

Dos señales con **denominadores distintos**, que nunca se mezclan:

- **Correcciones (señal dura).** El usuario corrigiendo al agente. Se minan por patrones sobre el corpus *completo* de la ventana (cientos de sesiones). Evidencia fiable.
- **Adherencia (señal blanda).** Un modelo juzga, por transcripción muestreada, si una regla aplicable se cumplió. Ruidosa: sirve para ordenar candidatas, nunca por sí sola para borrar una regla.

Cada cita del juez se verifica mecánicamente contra la transcripción por subcadena literal. Lo que no se verifica, se descarta.

## Estructura

| | |
|---|---|
| `SKILL.md` | el contrato que ejecuta el agente |
| `scorers/` | rúbricas de adherencia y de valor de regla |
| `references/` | modelo de regla, privacidad, licencia de terceros |
| `scripts/` | 5 scripts stdlib + 5 suites (95 tests) |

## Tests

```bash
python3 -m unittest discover -s scripts -p 'test_*.py'
```

Sin dependencias: stdlib de Python 3.9+.
