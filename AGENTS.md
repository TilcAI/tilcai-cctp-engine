# Instrucciones para agentes

Reglas para los agentes de código que trabajen en este repositorio. `CLAUDE.md`, `GEMINI.md` y
`.github/copilot-instructions.md` remiten a este archivo: los cambios se hacen aquí.

## Historial de prompts y salidas (obligatorio)

Cada prompt que una persona le da a un agente en este repositorio, y la salida del agente, se
registran en [`AGENT_HISTORY.md`](AGENT_HISTORY.md): así se puede trazar quién pidió qué, cuándo
y qué resultó. Vale para cualquier agente (Codex, Claude Code, Gemini CLI, Cursor, Copilot,
OpenCode…) y es la misma regla en todos los repositorios de la organización TilcAI.

**Antes de dar por terminada tu respuesta a un prompt**, añade una entrada al final de
`AGENT_HISTORY.md` con este formato:

```markdown
## <fecha y hora UTC, ISO 8601> · <usuario> · <agente y modelo>

- **Sesión:** <id o enlace de la sesión; `n/d` si el agente no lo expone>
- **Rama:** <rama de trabajo>
- **Repositorios:** <este y los demás que cambió el mismo prompt>

### Prompt

> <el prompt, literal>

### Salida

<la respuesta final del agente>
```

Reglas:

1. **Una entrada por prompt**, también cuando no cambió ningún archivo (una pregunta, una
   revisión, una negativa).
2. **Orden cronológico y solo añadir.** Las entradas nuevas van al final. Las anteriores no se
   editan, reordenan ni borran; para corregir una se añade otra que la cite por su fecha.
3. **Fecha y hora:** el momento en que llegó el prompt, en UTC
   (`date -u +%Y-%m-%dT%H:%M:%SZ`).
4. **Usuario:** el login de GitHub de quien escribe el prompt (`gh api user --jq .login`; sin
   `gh`, el valor de `git config user.name`). Nunca su correo.
5. **Prompt literal:** sin corregir ni resumir. Los adjuntos se describen
   (`[adjunto: captura del tablero]`), no se copian.
6. **Salida:** la respuesta final, literal. Si pasa de unas 60 líneas, un resumen fiel: qué se
   hizo, qué quedó pendiente o falló, y los commits, PR o archivos que lo respaldan. Los
   mensajes intermedios y la salida de las herramientas no se registran.
7. **Sin secretos ni datos personales.** El repositorio es público: claves, tokens,
   contraseñas, contenido de `.env`, correos, teléfonos y cuentas bancarias se sustituyen por
   `[REDACTADO]`, también cuando vienen dentro del prompt.
8. **Varios repositorios:** si un prompt cambia más de uno, cada repositorio recibe su entrada
   con la misma fecha, usuario y sesión, y la salida centrada en lo que cambió ahí.
9. **Commits:** la entrada viaja en el mismo commit o PR que el trabajo que describe. No hagas
   un commit ni un push solo por el historial si nadie los pidió: la entrada queda en el árbol
   de trabajo y sale con el siguiente commit.
10. **Conflictos:** `.gitattributes` declara `merge=union` para el archivo, así que dos ramas
    que añaden entradas se combinan solas. Si aun así hay conflicto, se conservan las dos
    entradas en orden de fecha.
