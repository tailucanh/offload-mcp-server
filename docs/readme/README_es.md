<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Tiếng Việt](README_vi.md) · **Español** · [Français](README_fr.md) · [Deutsch](README_de.md) · [Português (Brasil)](README_pt-BR.md) · [Русский](README_ru.md)

# offload-mcp-server

### Deja que tu agente de programación principal delegue la lectura pesada a un segundo agente y lee solo la respuesta.

**Claude Code pregunta. El CLI de Antigravity lee 37 archivos. Claude lee 500 tokens.**

[![npm](https://img.shields.io/npm/v/offload-mcp-server?style=flat-square&color=cb3837&logo=npm)](https://www.npmjs.com/package/offload-mcp-server)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](../../LICENSE)
[![Node.js 20.3+](https://img.shields.io/badge/Node.js-20.3%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](#requisitos)
[![MCP server](https://img.shields.io/badge/MCP-stdio_server-5c4ee5?style=flat-square)](#herramientas)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)](../../src)
[![Worker: Antigravity CLI](https://img.shields.io/badge/worker-Antigravity_CLI-4285f4?style=flat-square)](#paso-2-instala-el-cli-de-antigravity-e-inicia-sesión)
[![GitHub stars](https://img.shields.io/github/stars/tailucanh/offload-mcp-server?style=flat-square)](https://github.com/tailucanh/offload-mcp-server/stargazers)

[Inicio rápido](#inicio-rápido) · [Cómo funciona](#cómo-funciona) · [Qué delegar](#qué-delegar) · [Instalación](#instalación-paso-a-paso) · [Resultados](#resultados-medidos) · [Solución de problemas](#solución-de-problemas) · [Preguntas frecuentes](#preguntas-frecuentes) · [Seguridad](#modelo-de-seguridad)

<code>npx -y offload-mcp-server setup</code>

<img src="../assets/demo.svg" alt="Claude Code hands an endpoint inventory to the Antigravity CLI through offload-mcp-server and reads back a 0.5k-token summary" width="860">

</div>

> [!IMPORTANT]
> La fuente oficial es [github.com/tailucanh/offload-mcp-server](https://github.com/tailucanh/offload-mcp-server).
> El paquete de npm es [`offload-mcp-server`](https://www.npmjs.com/package/offload-mcp-server). Un paquete o repositorio con un nombre parecido no es este proyecto.

---

Los agentes de programación gastan la mayor parte de su contexto en **leer**: recorrer un árbol de código, revisar logs, abrir un bundle minificado para encontrar una sola función. Cuando la respuesta es un párrafo y la lectura son 40 000 tokens, el intercambio no compensa.

**offload-mcp-server** es un pequeño servidor MCP que le da a tu agente principal cuatro herramientas para pasar esa lectura a un **segundo CLI de agente que se ejecuta en segundo plano**; por defecto, el CLI de Antigravity de Google (`agy`) con un agente de solo lectura. El worker lee los archivos con su propia cuota y escribe un informe con formato fijo. Tu agente principal lee el **Summary** (unos cientos de palabras) y solo recupera los **Findings** con evidencia `path:line` cuando los necesita.

- **Asíncrono.** Envías un trabajo, sigues con lo tuyo y lo recoges después. Varios trabajos pueden correr en paralelo.
- **De solo lectura por diseño.** El agente worker solo tiene herramientas de lectura de archivos, y el servidor informa de cualquier archivo cuyo `git status` haya cambiado mientras corría un trabajo.
- **Con alcance acotado.** El servidor le da al worker la lista de archivos dentro del alcance (`git ls-files`), de modo que no se dispersa.
- **Independiente del backend.** Cualquier CLI que reciba un prompt e imprima una respuesta puede ser el worker, incluido `claude -p`.
- **Medible.** Cada trabajo registra el número de tokens del worker, y `npm run try` muestra lo que el agente principal leyó en realidad.

## Inicio rápido

Necesitas Node.js 20.3+, la [CLI de Antigravity](#paso-2-instala-el-cli-de-antigravity-e-inicia-sesión) instalada y con sesión iniciada, y Claude Code (u otro cliente MCP). Después ejecuta:

```bash
npx -y offload-mcp-server setup
```

`setup` busca la Antigravity CLI, instala el agente worker de solo lectura (`~/.gemini/agents/`) y el skill de Claude Code (`~/.claude/skills/offload/`), crea `~/.offload/config.json` si no existe y registra el servidor en Claude Code. Es seguro volver a ejecutarlo tras una actualización: un archivo que cambió se guarda antes como `.bak`. Añade `--dry-run` para ver lo que haría.

Abre una nueva sesión de Claude Code (o recarga la ventana del editor) y pide:

```text
Delega esto: haz un inventario de todos los endpoints HTTP bajo api/ con su método y su comprobación
de autenticación, y luego muéstrame el resumen.
```

Para ejecutarlo desde un clon, para desarrollo:

```bash
git clone https://github.com/tailucanh/offload-mcp-server.git
cd offload-mcp-server
npm install
npm run build
node dist/index.js setup
```

[Instalación paso a paso](#instalación-paso-a-paso) explica cada parte y cómo hacerla a mano.

## Cómo funciona

```mermaid
sequenceDiagram
    autonumber
    participant M as Agente principal (Claude Code)
    participant S as offload-mcp-server
    participant W as Worker (agy + offload-reader)
    M->>S: offload_submit_task(task, steps, output_hint, done_when, paths)
    S->>S: validar rutas, listar archivos del alcance (git ls-files), construir prompt
    S-->>M: job_id (de inmediato)
    S->>W: lanzar en segundo plano
    Note over M: sigue trabajando en otra cosa
    W->>W: read_file … (solo los archivos listados)
    W-->>S: informe: Summary / Findings / Uncertain / Files read
    S->>S: quitar enlaces file://, analizar secciones, registrar tokens, comparar git status
    M->>S: offload_get_status(job_id, wait_sec=50)
    S-->>M: estado + Summary (unos cientos de palabras)
    opt solo si el Summary no basta
        M->>S: offload_get_result(job_id, part="findings")
        S-->>M: Findings con evidencia path:line
    end
    Note over M: comprueba por muestreo las líneas citadas antes de actuar
```

1. **Enviar.** El servidor resuelve `workspace` y `paths` con `realpath`, rechaza todo lo que quede fuera del workspace, lista los archivos del alcance y encola el trabajo.
2. **Ejecutar.** Corren hasta `maxConcurrent` workers a la vez, cada uno dentro del workspace. La salida va a `~/.offload/jobs/<job_id>/`.
3. **Analizar.** Cuando el worker termina, el servidor extrae la respuesta, quita los enlaces `file://` (cuestan tokens y no aportan nada), divide el informe en secciones y registra el número de tokens del worker.
4. **Recoger.** `offload_get_status` espera hasta 50 segundos por llamada, por debajo del límite de unos 60 segundos por llamada de muchos clientes MCP. Un estado de trabajo terminado ya incluye el Summary.

## Qué delegar

| Delegar | Hacerlo tú mismo |
|---|---|
| Inventarios sobre un árbol completo: cada endpoint, clave de configuración, comprobación de permisos, punto de llamada | Ediciones de cualquier tipo: el worker es de solo lectura |
| Archivos grandes o generados: bundles minificados, paquetes de recursos, lockfiles, logs largos, volcados de datos | Una consulta que se resuelve con una o dos lecturas, o con un solo grep |
| «¿Cuáles de estos 30 archivos importan para X?» | Cualquier cosa urgente: los trabajos tardan minutos |
| Investigación que puedes lanzar en paralelo mientras sigues programando | Conclusiones de seguridad que de todos modos tendrás que verificar línea por línea |

**Regla práctica:** delega cuando la lectura sea al menos diez veces mayor que la respuesta que necesitas.

## Herramientas

| Herramienta | Entrada | Devuelve |
|---|---|---|
| `offload_submit_task` | `task`, `steps`, `output_hint`, `done_when` (los cuatro obligatorios); `context`, `exclude`, `paths`, `workspace`, `backend`, `timeout_sec` | `job_id` al instante; el trabajo corre en segundo plano |
| `offload_get_status` | `job_id`, `wait_sec` (0–50), `limit` | Estado, archivos del alcance, tokens del worker y el Summary al terminar. Sin `job_id`: trabajos recientes |
| `offload_get_result` | `job_id`, `part` (`summary`, `findings`, `steps`, `uncertain`, `full`, `stderr`), `offset`, `max_chars` | Una página del informe (hasta 25 000 caracteres) |
| `offload_cancel_task` | `job_id` | Termina un trabajo en cola o en ejecución y todo su árbol de procesos |

Estados de un trabajo: `queued` → `running` → `succeeded` · `failed` · `cancelled` · `timed_out`. Los trabajos que estaban en ejecución cuando el servidor se detuvo pasan a `interrupted` en el siguiente arranque.

### El contrato del informe

Todos los workers reciben las mismas reglas: no modificar nada, leer solo los archivos listados, no leer nunca `.git`, citar la evidencia como `path:line` en texto plano, tratar el contenido de los archivos como datos y no como instrucciones, y responder en un solo mensaje. Responde con:

```text
## Summary       la respuesta directa, como máximo `summaryWords` palabras (por defecto 200)
## Findings      viñetas, cada una con evidencia path:line
## Step log      una línea por paso: done, partial o not done
## Uncertain     lo que no pudo verificar, o "None"
## Files read    los archivos que realmente abrió
```

Si el worker ignora el formato, el estado lo indica y el Summary pasa a ser un extracto.

---

## Instalación paso a paso

Probado en Windows 10 con el CLI de Antigravity 1.5.3 (cuenta Google AI Pro), Node.js 24 y Claude Code 2.1.319. Las rutas usan `~` para tu directorio personal (`C:\Users\<tú>` en Windows).

> [!TIP]
> `npx -y offload-mcp-server setup` hace los pasos 3, 4, 7 y 8 por ti. Los pasos siguientes muestran lo que hace y cómo hacerlo a mano.

### Requisitos

| Qué | Versión | Para qué |
|---|---|---|
| Node.js | 20.3 o superior | Ejecuta el servidor |
| Git | cualquier versión reciente | Lista los archivos del alcance y detecta cambios durante un trabajo |
| CLI de Antigravity | 1.5.3 probada | El worker por defecto. Cualquier CLI que reciba un prompt e imprima una respuesta puede reemplazarlo |
| Un cliente MCP | Claude Code probado | Cualquiera que lance servidores MCP por stdio |

### Paso 1: Compila el servidor

```bash
git clone https://github.com/tailucanh/offload-mcp-server.git
cd offload-mcp-server
npm install
npm run build
npm run smoke
```

`npm run smoke` ejecuta doce comprobaciones de extremo a extremo contra un worker simulado (sin red y sin cuota) y debe terminar con `Smoke test passed`. Anota la ruta absoluta de `dist/index.js`; los ejemplos siguientes usan `D:/Tool/offload-mcp-server/dist/index.js`.

### Paso 2: Instala el CLI de Antigravity e inicia sesión

Sigue las instrucciones de Google para el CLI de Antigravity en tu plataforma. En Windows usamos el instalador oficial de PowerShell. Descárgalo y léelo antes de ejecutarlo:

```powershell
Invoke-WebRequest https://antigravity.google/cli/install.ps1 -OutFile install.ps1
notepad install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
```

El instalador de Windows coloca `agy.exe` en `%LOCALAPPDATA%\agy\bin`, verifica su suma de comprobación SHA-512 y lo añade al PATH. Después, **en una terminal nueva**:

```bash
agy --version
agy
```

La primera ejecución interactiva abre el navegador para iniciar sesión con Google. Después sal con `/quit`. Windows Defender puede poner `agy.exe` en cuarentena unos minutos durante el primer arranque; espera e inténtalo de nuevo.

### Paso 3: Instala el agente worker de solo lectura

Copia [`agents/offload-reader.md`](../../agents/offload-reader.md) en `~/.gemini/agents/`.

Windows (PowerShell):

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.gemini\agents" | Out-Null
Copy-Item agents\offload-reader.md "$env:USERPROFILE\.gemini\agents\"
```

macOS / Linux:

```bash
mkdir -p ~/.gemini/agents && cp agents/offload-reader.md ~/.gemini/agents/
```

Comprueba que agy lo ve. La salida debe contener `offload-reader`:

```bash
agy agents
```

> [!WARNING]
> Guarda el archivo del agente como **UTF-8 sin BOM**. Con BOM, agy ignora el agente e informa `unknown agent`. `Set-Content -Encoding utf8` de Windows PowerShell 5.1 escribe un BOM; usa un editor en su lugar.

**¿Por qué un agente personalizado?** En modo headless (`agy -p`), agy no puede pedirte permiso. El agente por defecto suele ejecutar primero un comando de terminal como `ls`; ese comando se deniega automáticamente y la ejecución termina con una **respuesta vacía y código de salida 0**. `offload-reader` declara solo herramientas de archivos, así que nunca recurre a la terminal y no tiene forma de editar archivos.

### Paso 4: Escribe el archivo de configuración

Crea `~/.offload/config.json` a partir de [`offload.config.example.json`](../../offload.config.example.json):

```json
{
  "defaultBackend": "agy",
  "maxConcurrent": 2,
  "summaryWords": 200,
  "backends": {
    "agy": {
      "command": "C:/Users/<you>/AppData/Local/agy/bin/agy.exe",
      "args": ["--agent", "offload-reader", "--output-format", "json", "--print-timeout", "{timeoutSec}s", "-p", "{prompt}"],
      "promptVia": "arg",
      "outputJsonPath": "response",
      "usageJsonPath": "usage.total_tokens",
      "timeoutSec": 600
    }
  }
}
```

> [!TIP]
> Pon la **ruta completa** de `agy` en `command`. El servidor MCP hereda el PATH del editor que lo lanza, y un editor que ya estaba abierto cuando instalaste agy no ve la nueva entrada.

Sin archivo de configuración se usa el backend `agy` integrado, con los mismos argumentos y `command: "agy"`. La configuración se lee solo de `OFFLOAD_CONFIG` o de `~/.offload/config.json`, nunca de una carpeta de proyecto.

### Paso 5: Comprueba la instalación

```bash
node D:/Tool/offload-mcp-server/dist/index.js doctor
```

`doctor` imprime la configuración en uso, si se encuentra el comando de cada backend y las primeras líneas del `--help` del backend por defecto. Termina con código 1 si falta algo.

### Paso 6: Prueba una tarea real sin cliente MCP

`npm run try` maneja el servidor compilado exactamente como lo haría un cliente MCP, con tu configuración real:

```bash
npm run try -- "/path/to/your/project" "List every HTTP endpoint with its method and auth check" src/api
```

Imprime el estado con el Summary, luego los Findings y después cuántos caracteres habría leído el agente principal. Espera unos minutos.

### Paso 7: Registra el servidor en Claude Code

Para todos los proyectos (ámbito de usuario):

```bash
claude mcp add --scope user offload -- node D:/Tool/offload-mcp-server/dist/index.js
claude mcp get offload
```

`claude mcp get offload` debería mostrar `Status: Connected`.

Si `claude` no está en tu PATH (por ejemplo, porque solo usas la extensión de VS Code), la extensión incluye el CLI. En Windows está en `~/.vscode/extensions/anthropic.claude-code-<version>-win32-x64/resources/native-binary/claude.exe`, o bajo `~/.antigravity/extensions/` en el IDE Antigravity. Ejecuta los mismos comandos con esa ruta.

Para un solo proyecto, añade en su lugar un `.mcp.json` en la raíz del proyecto:

```json
{
  "mcpServers": {
    "offload": { "command": "node", "args": ["D:/Tool/offload-mcp-server/dist/index.js"] }
  }
}
```

El servidor usa su directorio de trabajo, el proyecto que abrió tu cliente, como workspace por defecto. Otros clientes MCP: lanza `node /path/to/dist/index.js` por stdio.

### Paso 8: Instala el skill

El skill le indica a Claude cuándo compensa delegar y cómo usar las herramientas.

Windows (PowerShell):

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\skills\offload" | Out-Null
Copy-Item skills\offload\SKILL.md "$env:USERPROFILE\.claude\skills\offload\"
```

macOS / Linux:

```bash
mkdir -p ~/.claude/skills/offload && cp skills/offload/SKILL.md ~/.claude/skills/offload/
```

### Paso 9: Reinicia y verifica

Inicia una sesión nueva de Claude Code (en un editor, recarga la ventana) y ejecuta `/mcp`. `offload` debería aparecer conectado con cuatro herramientas. Luego dale una tarea real:

```text
Delega esto: para cada endpoint bajo api/v1, lista la URL, los métodos HTTP, el requisito de
autenticación y la clase principal que usa. Agrupa por carpeta y cita path:line.
```

---

## Cómo sacarle partido

### Un intercambio típico

1. El agente principal llama a `offload_submit_task` con un `task` preciso, `paths` acotados y un `output_hint` como `table: endpoint | method | auth | file:line`.
2. Sigue trabajando y luego llama a `offload_get_status` con `wait_sec: 50` hasta que el trabajo termina.
3. Lee el Summary. Solo si no basta, llama a `offload_get_result` con `part: "findings"`.
4. Abre dos o tres líneas citadas para confirmar antes de actuar sobre el resultado.

### Cómo escribir buenas tareas

- **Una pregunta concreta** con un final claro: «lista cada X con Y y Z», no «mira la API».
- **`paths` acotados.** El worker lee solo los archivos listados, así que el alcance determina tanto el tiempo como el costo.
- **Escribe un brief completo.** `steps` (acciones concretas y en orden), `output_hint` y `done_when` son obligatorios; `context` (lo que ya sabes) y `exclude` son opcionales. El worker hace exactamente esos pasos y nada más, marca cada uno como done, partial o not done, y el estado muestra una línea *Brief check* con los pasos que no terminó.
- **Pide una forma** en `output_hint`: una tabla, viñetas agrupadas, un sí/no con evidencia.
- **Pide evidencia** (`path:line`) para poder comprobar el resultado por muestreo.
- **Envía pronto.** Los trabajos tardan minutos; envía primero y haz después el trabajo que no depende de ellos.

## Resultados medidos

Tarea: «haz un inventario de cada endpoint HTTP bajo `api/v1`: URL, métodos, requisito de autenticación, clase principal».
Proyecto: 37 archivos PHP, 140 KB.

| Medida | Resultado |
|---|---|
| Tiempo del worker | 503 s |
| Tokens del worker (Gemini Flash, con la cuota de Google) | 192k |
| Agente principal, solo Summary | ~2k caracteres (≈ 0,5k tokens) |
| Agente principal, Summary + Findings | ~26k caracteres (≈ 6,5k tokens) |
| Leer los 37 archivos directamente | ≈ 40k tokens |
| Comprobación por muestreo | 6 de 6 afirmaciones revisadas coincidían exactamente con las líneas citadas |

Antes de que el servidor incluyera la lista de archivos en el prompt, una tarea similar hacía que el worker deambulara por archivos ajenos (incluido `.git`) y agotara el tiempo tras más de 200k tokens. **El alcance es lo que hace que funcione.**

## Referencia de configuración

Archivo: `OFFLOAD_CONFIG` si está definido; si no, `~/.offload/config.json`.

| Clave | Por defecto | Significado |
|---|---|---|
| `defaultBackend` | `agy` | Backend que se usa cuando una tarea no indica ninguno |
| `maxConcurrent` | `2` | Trabajos en ejecución a la vez; el resto espera en cola |
| `jobsDir` | `~/.offload/jobs` | Dónde se guardan los registros de trabajos y los informes |
| `allowedRoots` | `[]` | Directorios adicionales que una tarea puede usar como `workspace`. El directorio de trabajo del servidor siempre está permitido |
| `summaryWords` | `200` | Límite de palabras para el Summary del worker |
| `manifestLimit` | `400` | Número máximo de archivos del alcance listados en el prompt del worker |
| `backends.<name>.command` | | Nombre del ejecutable o ruta completa |
| `backends.<name>.args` | `[]` | Argumentos. Marcadores: `{prompt}`, `{workspace}`, `{timeoutSec}` |
| `backends.<name>.promptVia` | `arg` | `arg` coloca el prompt en `{prompt}` (o lo añade al final); `stdin` lo escribe por stdin |
| `backends.<name>.outputJsonPath` | | Ruta con puntos hasta la respuesta cuando el CLI imprime JSON, p. ej. `response` |
| `backends.<name>.usageJsonPath` | | Ruta con puntos hasta el número de tokens del worker, p. ej. `usage.total_tokens` |
| `backends.<name>.env` | `{}` | Variables de entorno adicionales para el worker |
| `backends.<name>.timeoutSec` | `600` (agy) | Presupuesto de tiempo; el worker se termina 30 s después, de modo que los CLI con límite propio se detengan limpiamente antes |

## Otros backends

Cualquier CLI que reciba un prompt e imprima una respuesta puede ser un worker. Añádelo en `backends` y luego pasa `backend: "<name>"` en una tarea o conviértelo en el `defaultBackend`. Claude Code mismo, en modo print:

```json
"claude": {
  "command": "claude",
  "args": ["-p", "--output-format", "json"],
  "promptVia": "stdin",
  "outputJsonPath": "result",
  "timeoutSec": 900
}
```

Al adaptar un CLI:

1. Busca su opción no interactiva (`-p`, `exec`, `--print`, …) y ejecuta un prompt a mano.
2. Prefiere una opción de salida JSON; define `outputJsonPath` y también `usageJsonPath` si informa de tokens.
3. Hazlo de solo lectura: un modo de plan o de solo lectura, una opción de sandbox o un agente restringido como `offload-reader`.
4. Comprueba qué ocurre cuando una herramienta necesita aprobación en modo headless. Si el CLI no devuelve nada en silencio, restringe sus herramientas como en el Paso 3.
5. En Windows, un comando `.cmd`/`.bat` no puede recibir un prompt de varias líneas como argumento (cmd.exe se detiene en el primer salto de línea). Usa `"promptVia": "stdin"` o apunta `command` al `.exe`. El servidor rechaza esa combinación en lugar de enviar un prompt truncado.

## Solución de problemas

| Síntoma | Causa | Solución |
|---|---|---|
| `failed`: "gave no answer, often because a tool permission was denied", la salida muestra `denied_actions` | El worker intentó usar una herramienta que requiere aprobación, normalmente un comando de terminal | Usa el agente `offload-reader` (Paso 3); comprueba que `args` contenga `--agent offload-reader` |
| `unknown agent "offload-reader"` | Falta el archivo del agente, está en la carpeta equivocada o se guardó con BOM | Colócalo en `~/.gemini/agents/` como UTF-8 sin BOM; revisa `agy agents` |
| `--agent` con una ruta de archivo falla | agy recibe el **nombre** de un agente, no una ruta | Instala el archivo (Paso 3) y pasa el nombre |
| `failed`: backend command "agy" was not found | El PATH del editor es anterior a la instalación de agy | Usa la ruta completa en `command` (Paso 4) o reinicia el editor |
| `timed_out`, o agy informa `print timeout … partial` | Alcance demasiado grande para el presupuesto de tiempo | Acota `paths` o pasa un `timeout_sec` mayor |
| El worker lee archivos ajenos | No hay una lista de archivos útil en el prompt | Pasa `paths`; revisa «N file(s) in scope» en el estado |
| Rechazado: `.cmd/.bat` cannot receive a multi-line prompt | Limitación de cmd.exe en Windows | `"promptVia": "stdin"`, o apunta `command` al `.exe` |
| `--settings must be a JSON object` al probar agy a mano en PowerShell 5.1 | PowerShell elimina las comillas internas del JSON en línea | Escribe el JSON en un archivo y pasa su ruta |
| Faltan las herramientas `offload_*` en Claude Code | El servidor no está registrado o no pudo arrancar | `claude mcp get offload`, luego `node dist/index.js doctor` |
| El estado avisa de que git status cambió durante el trabajo | Algo escribió en el workspace mientras corría el trabajo | Revisa `git status` / `git diff`; pueden ser tus propias ediciones |
| Errores de límite de tasa o de cuota de agy | Cuota del modelo en tu plan de Google | Reduce `maxConcurrent`, reintenta más tarde o añade `--model` a `args` |

Cada trabajo guarda sus archivos en `~/.offload/jobs/<job_id>/`: `prompt.md` (exactamente lo que recibió el worker), `stdout.log`, `stderr.log`, `report.md` y `job.json`.

## Modelo de seguridad

- **Solo lectura por elección de herramientas y por contrato, no por sandbox.** `offload-reader` tiene únicamente herramientas de lectura de archivos y el prompt prohíbe escribir, pero el worker se ejecuta con tu usuario. Para un aislamiento más fuerte usa el sandbox del backend (`--sandbox` de agy requiere Windows 11 24H2 o posterior, macOS o Linux), un contenedor o un usuario del sistema aparte.
- **Detección de cambios.** Se compara `git status` antes y después de cada trabajo; los archivos modificados se reportan. Es un esfuerzo razonable, no infalible, y no distingue las escrituras del worker de las tuyas.
- **Contención de rutas.** `workspace` y `paths` se resuelven con `realpath`; las rutas deben quedarse dentro del workspace, y el workspace debe ser el directorio de trabajo del servidor o estar dentro de `allowedRoots`.
- **La configuración nunca viene de un proyecto.** Se lee solo de `OFFLOAD_CONFIG` o del directorio personal, de modo que un repositorio clonado no puede hacer que el servidor ejecute un comando a su elección.
- **Sin shell.** Los workers se lanzan con un arreglo de argumentos (mediante `cross-spawn`), nunca con una cadena de shell.
- **La salida del worker no es de confianza.** Los archivos pueden contener inyección de prompts. Al worker se le indica que trate el contenido de los archivos como datos, las herramientas presentan los resultados como pistas por verificar y el skill le dice al agente principal que abra las líneas citadas antes de actuar.
- **Tus archivos salen de tu máquina.** El worker envía lo que lee a su proveedor de modelos (Google, en el caso de agy). No delegues trabajo sobre archivos que no puedas compartir con ese proveedor.

## Preguntas frecuentes

<details>
<summary><b>¿Por qué no usar simplemente los subagentes de Claude Code?</b></summary>

Los subagentes usan el mismo proveedor de modelos y la misma cuota que el agente principal, así que la lectura sigue costando tokens de Claude. offload traslada la lectura a la cuota de otro proveedor, aquí tu plan de Google, y devuelve solo el resultado.
</details>

<details>
<summary><b>¿Ahorra dinero?</b></summary>

Traslada la lectura a la cuota del worker y reduce lo que lee el agente principal, a menudo en un orden de magnitud en tareas de tipo inventario. El worker en sí puede usar muchos tokens (192k en el ejemplo anterior), así que si resulta «más barato» depende de tus planes en ambos lados.
</details>

<details>
<summary><b>¿Puede el worker editar mis archivos?</b></summary>

El agente `offload-reader` no tiene herramientas de edición ni de terminal, y el prompt prohíbe los cambios. Aun así, el worker se ejecuta con tu usuario, así que trátalo como una convención sólida y no como un sandbox. El servidor avisa si `git status` cambia durante un trabajo.
</details>

<details>
<summary><b>¿Por qué es lento?</b></summary>

El worker lee cada archivo relevante completo, una llamada de herramienta a la vez; 37 archivos tardaron unos ocho minutos. Envía pronto y sigue trabajando. Con `paths` más acotados es más rápido.
</details>

<details>
<summary><b>¿Puedo usar el CLI de Gemini en su lugar?</b></summary>

Google ha pasado las cuentas individuales al CLI de Antigravity, por lo que este proyecto apunta a `agy`. Cualquier CLI con modo no interactivo sirve como backend; consulta [Otros backends](#otros-backends).
</details>

<details>
<summary><b>¿Qué plataformas son compatibles?</b></summary>

El servidor es Node.js puro y funciona en Windows, macOS y Linux. La instalación completa se probó en Windows 10. La cancelación del árbol de procesos usa `taskkill` en Windows y grupos de procesos en el resto.
</details>

<details>
<summary><b>¿Qué clientes MCP funcionan?</b></summary>

Cualquier cliente que lance servidores MCP por stdio. Las instrucciones de instalación de aquí son para Claude Code; el archivo del skill es específico de Claude Code, las herramientas no.
</details>

## Desarrollo

```bash
npm run build
npm run smoke
npm test
npm run doctor
npm run try -- <workspace> "<task>" [path ...]
npx @modelcontextprotocol/inspector node dist/index.js
```

`npm test` compila, ejecuta la prueba smoke y comprueba que cada README traducido conserve los bloques de código de este. El worker simulado (`scripts/mock-agent.mjs`) reacciona a marcadores en la tarea: `SLOW_MODE` duerme 60 s, `BAD_FORMAT` ignora el formato del informe, `WRITE_FILE` escribe en el workspace.

### Estructura del proyecto

```text
src/
  index.ts      punto de entrada: servidor MCP por stdio, o `doctor`
  config.ts     esquema de configuración, valores por defecto, backend agy integrado
  tools.ts      las cuatro herramientas MCP, validación de rutas, formato del estado
  jobs.ts       cola, lanzamiento de procesos, timeouts, cancelación, análisis de resultados, detección de cambios
  manifest.ts   archivos del alcance (git ls-files o recorrido de directorios)
  report.ts     prompt del worker, análisis del informe, extracción de JSON, eliminación de enlaces
  doctor.ts     comprobaciones de instalación
agents/offload-reader.md     agente worker de solo lectura para agy
skills/offload/SKILL.md      skill de Claude Code: cuándo y cómo delegar
scripts/smoke.ts             prueba de extremo a extremo contra el worker simulado
scripts/mock-agent.mjs       worker de reemplazo
scripts/try.ts               ejecuta una tarea real a través del servidor
scripts/check-readmes.mjs    mantiene sincronizados los README traducidos
docs/readme/                 README traducidos
```

## Hoja de ruta

- Una herramienta de búsqueda para el worker agy cuando los agentes personalizados en modo headless puedan usar una
- Recetas probadas para más CLI worker
- Selección de modelo por tarea

## Contribuir

Las issues y los pull requests son bienvenidos. Ejecuta `npm test` antes de abrir un pull request. Si cambias este README, actualiza las traducciones en `docs/readme/` o abre una issue para que puedan actualizarse; la comprobación del README falla si los bloques de código de una traducción se desvían de este archivo.

## Licencia

[MIT](../../LICENSE)
