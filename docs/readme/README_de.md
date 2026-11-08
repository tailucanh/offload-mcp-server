<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Tiếng Việt](README_vi.md) · [Español](README_es.md) · [Français](README_fr.md) · **Deutsch** · [Português (Brasil)](README_pt-BR.md) · [Русский](README_ru.md)

# offload-mcp-server

### Lass deinen Haupt-Coding-Agenten das aufwendige Lesen an einen zweiten Agenten delegieren und lies nur die Antwort.

**Claude Code fragt. Die Antigravity CLI liest 37 Dateien. Claude liest 500 Tokens.**

[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](../../LICENSE)
[![Node.js 20.3+](https://img.shields.io/badge/Node.js-20.3%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](#voraussetzungen)
[![MCP server](https://img.shields.io/badge/MCP-stdio_server-5c4ee5?style=flat-square)](#werkzeuge)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)](../../src)
[![Worker: Antigravity CLI](https://img.shields.io/badge/worker-Antigravity_CLI-4285f4?style=flat-square)](#schritt-2-antigravity-cli-installieren-und-anmelden)
[![GitHub stars](https://img.shields.io/github/stars/tailucanh/offload-mcp-server?style=flat-square)](https://github.com/tailucanh/offload-mcp-server/stargazers)

[Schnellstart](#schnellstart) · [Funktionsweise](#funktionsweise) · [Was sich auslagern lässt](#was-sich-auslagern-lässt) · [Einrichtung](#einrichtung-schritt-für-schritt) · [Ergebnisse](#gemessene-ergebnisse) · [Fehlerbehebung](#fehlerbehebung) · [FAQ](#faq) · [Sicherheit](#sicherheitsmodell)

<code>claude mcp add --scope user offload -- node /path/to/offload-mcp-server/dist/index.js</code>

</div>

> [!IMPORTANT]
> Die offizielle Quelle ist [github.com/tailucanh/offload-mcp-server](https://github.com/tailucanh/offload-mcp-server).
> Das Paket ist noch nicht auf npm veröffentlicht. Ein Paket oder Repository mit ähnlichem Namen ist nicht dieses Projekt.

---

Coding-Agenten verbrauchen den größten Teil ihres Kontexts mit **Lesen**: einen Quellbaum durchwandern,
Logs durchsuchen, ein minifiziertes Bundle öffnen, um eine einzige Funktion zu finden. Wenn die Antwort
ein Absatz ist und das Lesen 40.000 Tokens kostet, ist das ein schlechtes Geschäft.

**offload-mcp-server** ist ein kleiner MCP-Server, der deinem Hauptagenten vier Werkzeuge gibt, um dieses
Lesen an eine **zweite Agenten-CLI im Hintergrund** zu übergeben, standardmäßig Googles Antigravity CLI
(`agy`) mit einem schreibgeschützten Worker-Agenten. Der Worker liest die Dateien auf seinem eigenen
Kontingent und schreibt einen Bericht in festem Format. Dein Hauptagent liest die **Summary** (wenige
hundert Wörter) und holt sich die **Findings** mit `path:line`-Belegen nur dann, wenn er sie braucht.

- **Asynchron.** Einen Job abschicken, weiterarbeiten, ihn später abholen. Mehrere Jobs können parallel laufen.
- **Schreibgeschützt von Grund auf.** Der Worker-Agent hat nur Werkzeuge zum Lesen von Dateien, und der
  Server meldet jede Datei, deren `git status` sich während eines Jobs geändert hat.
- **Begrenzter Umfang.** Der Server übergibt dem Worker die Liste der Dateien im Scope (`git ls-files`),
  sodass er nicht abschweift.
- **Backend-unabhängig.** Jede CLI, die einen Prompt entgegennimmt und eine Antwort ausgibt, kann der Worker
  sein, auch `claude -p`.
- **Messbar.** Jeder Job speichert die Token-Anzahl des Workers, und `npm run try` zeigt, was der Hauptagent
  tatsächlich gelesen hat.

## Schnellstart

Du brauchst Node.js 20.3+, Git, die angemeldete [Antigravity CLI](#schritt-2-antigravity-cli-installieren-und-anmelden)
und Claude Code (oder einen anderen MCP-Client).

```bash
git clone https://github.com/tailucanh/offload-mcp-server.git
cd offload-mcp-server
npm install
npm run build
npm run smoke
```

Installiere dann den schreibgeschützten Worker-Agenten, registriere den Server und installiere die Skill:

```bash
mkdir -p ~/.gemini/agents && cp agents/offload-reader.md ~/.gemini/agents/
claude mcp add --scope user offload -- node "$(pwd)/dist/index.js"
mkdir -p ~/.claude/skills/offload && cp skills/offload/SKILL.md ~/.claude/skills/offload/
```

Unter Windows folgst du den PowerShell-Befehlen in [Einrichtung Schritt für Schritt](#einrichtung-schritt-für-schritt).
Starte eine neue Claude-Code-Sitzung und frage:

```text
Lagere das aus: Erstelle ein Inventar aller HTTP-Endpunkte unter api/ mit Methode und Authentifizierungsprüfung
und zeig mir dann die Zusammenfassung.
```

## Funktionsweise

```mermaid
sequenceDiagram
    autonumber
    participant M as Hauptagent (Claude Code)
    participant S as offload-mcp-server
    participant W as Worker (agy + offload-reader)
    M->>S: offload_submit_task(task, steps, output_hint, done_when, paths)
    S->>S: Pfade prüfen, Dateien im Scope auflisten (git ls-files), Prompt bauen
    S-->>M: job_id (sofort)
    S->>W: im Hintergrund starten
    Note over M: arbeitet an etwas anderem weiter
    W->>W: read_file … (nur die aufgelisteten Dateien)
    W-->>S: Bericht: Summary / Findings / Uncertain / Files read
    S->>S: file://-Links entfernen, Abschnitte parsen, Tokens erfassen, git status vergleichen
    M->>S: offload_get_status(job_id, wait_sec=50)
    S-->>M: Status + Summary (wenige hundert Wörter)
    opt nur wenn die Summary nicht reicht
        M->>S: offload_get_result(job_id, part="findings")
        S-->>M: Findings mit path:line-Belegen
    end
    Note over M: prüft die zitierten Zeilen stichprobenartig, bevor er handelt
```

1. **Abschicken.** Der Server löst `workspace` und `paths` mit `realpath` auf, lehnt alles außerhalb des
   Workspace ab, listet die Dateien im Scope auf und stellt den Job in die Warteschlange.
2. **Ausführen.** Bis zu `maxConcurrent` Worker laufen gleichzeitig, jeder im Workspace. Die Ausgabe landet in
   `~/.offload/jobs/<job_id>/`.
3. **Auswerten.** Wenn der Worker beendet ist, extrahiert der Server die Antwort, entfernt `file://`-Links
   (sie kosten Tokens und bringen nichts), teilt den Bericht in Abschnitte und erfasst die Token-Anzahl des Workers.
4. **Abholen.** `offload_get_status` wartet pro Aufruf bis zu 50 Sekunden und bleibt damit unter dem
   Limit von etwa 60 Sekunden pro Aufruf, das viele MCP-Clients haben. Ein Status für einen beendeten Job
   enthält bereits die Summary.

## Was sich auslagern lässt

| Auslagern | Selbst erledigen |
|---|---|
| Inventare über einen ganzen Baum: jeder Endpunkt, Konfigurationsschlüssel, jede Berechtigungsprüfung, jede Aufrufstelle | Änderungen jeder Art: Der Worker ist schreibgeschützt |
| Große oder generierte Dateien: minifizierte Bundles, Ressourcenpakete, Lockfiles, lange Logs, Datenexporte | Eine Nachschlage-Frage, die sich mit ein oder zwei Lesevorgängen oder einem grep beantworten lässt |
| „Welche dieser 30 Dateien sind für X relevant?" | Alles Dringende: Jobs dauern Minuten |
| Recherche, die parallel laufen kann, während du weiter programmierst | Sicherheitsfolgerungen, die du ohnehin Zeile für Zeile prüfen musst |

**Faustregel:** Lagere aus, wenn das Lesen mindestens zehnmal umfangreicher ist als die Antwort, die du brauchst.

## Werkzeuge

| Werkzeug | Eingabe | Rückgabe |
|---|---|---|
| `offload_submit_task` | `task`, `steps`, `output_hint`, `done_when` (alle vier erforderlich); `context`, `exclude`, `paths`, `workspace`, `backend`, `timeout_sec` | sofort `job_id`; der Job läuft im Hintergrund |
| `offload_get_status` | `job_id`, `wait_sec` (0–50), `limit` | Status, Dateien im Scope, Worker-Tokens und nach Abschluss die Summary. Ohne `job_id`: die letzten Jobs |
| `offload_get_result` | `job_id`, `part` (`summary`, `findings`, `steps`, `uncertain`, `full`, `stderr`), `offset`, `max_chars` | Eine Seite des Berichts (bis zu 25.000 Zeichen) |
| `offload_cancel_task` | `job_id` | Beendet einen wartenden oder laufenden Job samt seinem gesamten Prozessbaum |

Job-Zustände: `queued` → `running` → `succeeded` · `failed` · `cancelled` · `timed_out`. Jobs, die beim
Stoppen des Servers liefen, werden beim nächsten Start zu `interrupted`.

### Der Berichtsvertrag

Jeder Worker bekommt dieselben Regeln: nichts ändern, nur die aufgelisteten Dateien lesen, nie `.git` lesen,
Belege als einfaches `path:line` angeben, Dateiinhalte als Daten und nicht als Anweisungen behandeln, in einer
einzigen Nachricht antworten. Er antwortet mit:

```text
## Summary       die direkte Antwort, höchstens `summaryWords` Wörter (Standard 200)
## Findings      Stichpunkte, jeweils mit path:line-Beleg
## Step log      eine Zeile pro Schritt: done, partial oder not done
## Uncertain     was er nicht überprüfen konnte, oder „None"
## Files read    die Dateien, die er tatsächlich geöffnet hat
```

Hält sich der Worker nicht an das Format, weist der Status darauf hin, und die Summary wird zu einem Auszug.

---

## Einrichtung Schritt für Schritt

Getestet unter Windows 10 mit Antigravity CLI 1.5.3 (Google-AI-Pro-Konto), Node.js 24 und Claude Code
2.1.319. Pfade verwenden `~` für dein Home-Verzeichnis (`C:\Users\<you>` unter Windows).

### Voraussetzungen

| Was | Version | Wozu |
|---|---|---|
| Node.js | 20.3 oder neuer | Führt den Server aus |
| Git | jede aktuelle | Listet Dateien im Scope auf, erkennt Änderungen während eines Jobs |
| Antigravity CLI | 1.5.3 getestet | Der Standard-Worker. Jede CLI, die einen Prompt entgegennimmt und eine Antwort ausgibt, kann sie ersetzen |
| Ein MCP-Client | Claude Code getestet | Alles, was stdio-MCP-Server starten kann |

### Schritt 1: Server bauen

```bash
git clone https://github.com/tailucanh/offload-mcp-server.git
cd offload-mcp-server
npm install
npm run build
npm run smoke
```

`npm run smoke` führt zwölf Ende-zu-Ende-Prüfungen gegen einen Mock-Worker aus (kein Netzwerk, kein Kontingent)
und muss mit `Smoke test passed` enden. Notiere dir den absoluten Pfad von `dist/index.js`; die folgenden
Beispiele verwenden `D:/Tool/offload-mcp-server/dist/index.js`.

### Schritt 2: Antigravity CLI installieren und anmelden

Folge Googles Anleitung für die Antigravity CLI auf deiner Plattform. Unter Windows haben wir den offiziellen
PowerShell-Installer verwendet. Lade ihn herunter und lies ihn, bevor du ihn ausführst:

```powershell
Invoke-WebRequest https://antigravity.google/cli/install.ps1 -OutFile install.ps1
notepad install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
```

Der Windows-Installer legt `agy.exe` in `%LOCALAPPDATA%\agy\bin` ab, prüft seine SHA-512-Prüfsumme und
fügt es deinem PATH hinzu. Danach, **in einem neuen Terminal**:

```bash
agy --version
agy
```

Beim ersten interaktiven Start öffnet sich der Browser zur Anmeldung mit Google. Beende danach mit `/quit`.
Windows Defender stellt `agy.exe` beim ersten Start möglicherweise für einige Minuten unter Quarantäne; warte und versuche es erneut.

### Schritt 3: Den schreibgeschützten Worker-Agenten installieren

Kopiere [`agents/offload-reader.md`](../../agents/offload-reader.md) nach `~/.gemini/agents/`.

Windows (PowerShell):

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.gemini\agents" | Out-Null
Copy-Item agents\offload-reader.md "$env:USERPROFILE\.gemini\agents\"
```

macOS / Linux:

```bash
mkdir -p ~/.gemini/agents && cp agents/offload-reader.md ~/.gemini/agents/
```

Prüfe, ob agy ihn sieht. Die Ausgabe muss `offload-reader` enthalten:

```bash
agy agents
```

> [!WARNING]
> Speichere die Agentendatei als **UTF-8 ohne BOM**. Mit BOM ignoriert agy den Agenten und meldet
> `unknown agent`. `Set-Content -Encoding utf8` in Windows PowerShell 5.1 schreibt ein BOM; verwende stattdessen
> einen Editor.

**Warum ein eigener Agent?** Im Headless-Modus (`agy -p`) kann agy dich nicht um Erlaubnis fragen. Der
Standardagent führt oft zuerst einen Terminalbefehl wie `ls` aus; dieser Befehl wird automatisch abgelehnt,
und der Lauf endet mit einer **leeren Antwort und Exit-Code 0**. `offload-reader` deklariert nur Dateiwerkzeuge,
greift also nie zum Terminal und hat keine Möglichkeit, Dateien zu ändern.

### Schritt 4: Die Konfigurationsdatei schreiben

Lege `~/.offload/config.json` an, ausgehend von
[`offload.config.example.json`](../../offload.config.example.json):

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
> Trage in `command` den **vollständigen Pfad** zu `agy` ein. Der MCP-Server erbt den PATH des Editors, der ihn
> startet, und ein Editor, der schon beim Installieren von agy geöffnet war, sieht den neuen Eintrag nicht.

Ohne Konfigurationsdatei wird das eingebaute `agy`-Backend verwendet, mit denselben Argumenten und `command: "agy"`.
Die Konfiguration wird nur aus `OFFLOAD_CONFIG` oder `~/.offload/config.json` gelesen, nie aus einem Projektordner.

### Schritt 5: Die Einrichtung prüfen

```bash
node D:/Tool/offload-mcp-server/dist/index.js doctor
```

`doctor` gibt die verwendete Konfiguration aus, zeigt, ob der Befehl jedes Backends gefunden wird, und gibt die
ersten Zeilen des `--help` des Standard-Backends aus. Fehlt etwas, endet es mit Exit-Code 1.

### Schritt 6: Eine echte Aufgabe ohne MCP-Client ausprobieren

`npm run try` steuert den gebauten Server genau wie ein MCP-Client an, mit deiner echten Konfiguration:

```bash
npm run try -- "/path/to/your/project" "List every HTTP endpoint with its method and auth check" src/api
```

Es gibt den Status mit der Summary aus, dann die Findings und schließlich, wie viele Zeichen der Hauptagent
gelesen hätte. Rechne mit einigen Minuten.

### Schritt 7: Den Server bei Claude Code registrieren

Für jedes Projekt (User-Scope):

```bash
claude mcp add --scope user offload -- node D:/Tool/offload-mcp-server/dist/index.js
claude mcp get offload
```

`claude mcp get offload` sollte `Status: Connected` melden.

Ist `claude` nicht in deinem PATH (zum Beispiel, wenn du nur die VS-Code-Erweiterung nutzt), bringt die
Erweiterung die CLI mit. Unter Windows liegt sie in
`~/.vscode/extensions/anthropic.claude-code-<version>-win32-x64/resources/native-binary/claude.exe`,
oder in der Antigravity IDE unter `~/.antigravity/extensions/`. Führe dieselben Befehle mit diesem Pfad aus.

Für nur ein Projekt legst du stattdessen eine `.mcp.json` im Projektstamm an:

```json
{
  "mcpServers": {
    "offload": { "command": "node", "args": ["D:/Tool/offload-mcp-server/dist/index.js"] }
  }
}
```

Der Server verwendet sein Arbeitsverzeichnis, also das Projekt, das dein Client geöffnet hat, als Standard-Workspace.
Andere MCP-Clients: Starte `node /path/to/dist/index.js` über stdio.

### Schritt 8: Die Skill installieren

Die Skill sagt Claude, wann sich das Auslagern lohnt und wie die Werkzeuge zu verwenden sind.

Windows (PowerShell):

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\skills\offload" | Out-Null
Copy-Item skills\offload\SKILL.md "$env:USERPROFILE\.claude\skills\offload\"
```

macOS / Linux:

```bash
mkdir -p ~/.claude/skills/offload && cp skills/offload/SKILL.md ~/.claude/skills/offload/
```

### Schritt 9: Neu starten und prüfen

Starte eine neue Claude-Code-Sitzung (in einem Editor: Fenster neu laden) und führe `/mcp` aus. `offload` sollte
mit vier Werkzeugen verbunden sein. Gib ihm dann eine echte Aufgabe:

```text
Lagere das aus: Liste für jeden Endpunkt unter api/v1 die URL, die HTTP-Methoden, die Authentifizierungsanforderung
und die verwendete Hauptklasse auf. Gruppiere nach Ordner und zitiere path:line.
```

---

## Richtig einsetzen

### Ein typischer Ablauf

1. Der Hauptagent ruft `offload_submit_task` mit einem präzisen `task`, eng gefassten `paths` und einem
   `output_hint` wie `table: endpoint | method | auth | file:line` auf.
2. Er arbeitet weiter und ruft dann `offload_get_status` mit `wait_sec: 50` auf, bis der Job beendet ist.
3. Er liest die Summary. Nur wenn sie nicht reicht, ruft er `offload_get_result` mit
   `part: "findings"` auf.
4. Er öffnet zwei oder drei zitierte Zeilen zur Bestätigung, bevor er auf dem Ergebnis aufbaut.

### Gute Aufgaben formulieren

- **Eine konkrete Frage** mit klarem Ende: „liste jedes X mit Y und Z auf", nicht „sieh dir die API an".
- **Enge `paths`.** Der Worker liest nur die aufgelisteten Dateien, der Scope bestimmt also Dauer und Kosten.
- **Schreibe ein vollständiges Briefing.** `steps` (konkrete Aktionen in Reihenfolge), `output_hint` und `done_when` sind erforderlich; `context` (was du schon weißt) und `exclude` sind optional. Der Worker führt genau diese Schritte aus und sonst nichts, protokolliert jeden als done, partial oder not done, und der Status zeigt eine *Brief check*-Zeile mit den nicht erledigten Schritten.
- **Verlange eine Form** in `output_hint`: eine Tabelle, gruppierte Stichpunkte, ein Ja/Nein mit Beleg.
- **Verlange Belege** (`path:line`), damit sich das Ergebnis stichprobenartig prüfen lässt.
- **Früh abschicken.** Jobs dauern Minuten; schicke zuerst ab und erledige dann die Arbeit, die nicht von ihnen abhängt.

## Gemessene Ergebnisse

Aufgabe: „Inventar aller HTTP-Endpunkte unter `api/v1`: URL, Methoden, Authentifizierungsanforderung, Hauptklasse".
Projekt: 37 PHP-Dateien, 140 KB.

| Messgröße | Ergebnis |
|---|---|
| Laufzeit des Workers | 503 s |
| Worker-Tokens (Gemini Flash, auf dem Google-Kontingent) | 192k |
| Hauptagent, nur Summary | ~2k Zeichen (≈ 0,5k Tokens) |
| Hauptagent, Summary + Findings | ~26k Zeichen (≈ 6,5k Tokens) |
| Die 37 Dateien direkt lesen | ≈ 40k Tokens |
| Stichprobe | 6 von 6 geprüften Aussagen stimmten exakt mit den zitierten Zeilen überein |

Bevor der Server die Dateiliste in den Prompt aufnahm, ließ eine ähnliche Aufgabe den Worker durch
fachfremde Dateien (auch `.git`) wandern und nach mehr als 200k Tokens in ein Timeout laufen.
**Der Scope ist es, der das Ganze funktionieren lässt.**

## Konfigurationsreferenz

Datei: `OFFLOAD_CONFIG`, falls gesetzt, sonst `~/.offload/config.json`.

| Schlüssel | Standard | Bedeutung |
|---|---|---|
| `defaultBackend` | `agy` | Backend, das verwendet wird, wenn eine Aufgabe keines nennt |
| `maxConcurrent` | `2` | Gleichzeitig laufende Jobs; die übrigen warten in einer Warteschlange |
| `jobsDir` | `~/.offload/jobs` | Wo Job-Aufzeichnungen und Berichte gespeichert werden |
| `allowedRoots` | `[]` | Zusätzliche Verzeichnisse, die eine Aufgabe als `workspace` verwenden darf. Das Arbeitsverzeichnis des Servers ist immer erlaubt |
| `summaryWords` | `200` | Wortbudget für die Summary des Workers |
| `manifestLimit` | `400` | Maximale Anzahl der Dateien im Scope, die im Worker-Prompt aufgelistet werden |
| `backends.<name>.command` | | Name der ausführbaren Datei oder vollständiger Pfad |
| `backends.<name>.args` | `[]` | Argumente. Platzhalter: `{prompt}`, `{workspace}`, `{timeoutSec}` |
| `backends.<name>.promptVia` | `arg` | `arg` setzt den Prompt an `{prompt}` (oder hängt ihn an); `stdin` schreibt ihn auf stdin |
| `backends.<name>.outputJsonPath` | | Punkt-Pfad zur Antwort, wenn die CLI JSON ausgibt, z. B. `response` |
| `backends.<name>.usageJsonPath` | | Punkt-Pfad zur Token-Anzahl des Workers, z. B. `usage.total_tokens` |
| `backends.<name>.env` | `{}` | Zusätzliche Umgebungsvariablen für den Worker |
| `backends.<name>.timeoutSec` | `600` (agy) | Zeitbudget; der Worker wird 30 s danach beendet, damit CLIs mit eigenem Limit vorher sauber stoppen |

## Andere Backends

Jede CLI, die einen Prompt entgegennimmt und eine Antwort ausgibt, kann ein Worker sein. Trage sie unter
`backends` ein und übergib dann `backend: "<name>"` in einer Aufgabe oder mach sie zum `defaultBackend`.
Claude Code selbst, im Print-Modus:

```json
"claude": {
  "command": "claude",
  "args": ["-p", "--output-format", "json"],
  "promptVia": "stdin",
  "outputJsonPath": "result",
  "timeoutSec": 900
}
```

So passt du eine CLI an:

1. Finde ihr nicht interaktives Flag (`-p`, `exec`, `--print`, …) und führe einen Prompt von Hand aus.
2. Bevorzuge ein JSON-Ausgabe-Flag; setze `outputJsonPath` und `usageJsonPath`, falls sie Tokens meldet.
3. Mach sie schreibgeschützt: ein Plan- oder Nur-Lese-Modus, ein Sandbox-Flag oder ein eingeschränkter Agent wie `offload-reader`.
4. Prüfe, was im Headless-Modus passiert, wenn ein Werkzeug eine Freigabe braucht. Gibt die CLI stillschweigend
   nichts zurück, schränke ihre Werkzeuge ein wie in Schritt 3.
5. Unter Windows kann ein `.cmd`-/`.bat`-Befehl keinen mehrzeiligen Prompt als Argument übernehmen (cmd.exe
   bricht beim ersten Zeilenumbruch ab). Verwende `"promptVia": "stdin"` oder lass `command` auf die `.exe`
   zeigen. Der Server lehnt diese Kombination ab, statt einen abgeschnittenen Prompt zu senden.

## Fehlerbehebung

| Symptom | Ursache | Lösung |
|---|---|---|
| `failed`: „gave no answer, often because a tool permission was denied", die Ausgabe zeigt `denied_actions` | Der Worker hat ein Werkzeug versucht, das eine Freigabe braucht, meist einen Terminalbefehl | Verwende den Agenten `offload-reader` (Schritt 3); prüfe, ob `args` `--agent offload-reader` enthält |
| `unknown agent "offload-reader"` | Agentendatei fehlt, liegt im falschen Ordner oder wurde mit BOM gespeichert | Lege sie als UTF-8 ohne BOM in `~/.gemini/agents/` ab; prüfe mit `agy agents` |
| `--agent` mit einem Dateipfad schlägt fehl | agy erwartet einen Agenten-**Namen**, keinen Pfad | Installiere die Datei (Schritt 3) und übergib den Namen |
| `failed`: backend command "agy" was not found | Der PATH des Editors stammt aus der Zeit vor der agy-Installation | Verwende den vollständigen Pfad in `command` (Schritt 4) oder starte den Editor neu |
| `timed_out`, oder agy meldet `print timeout … partial` | Scope zu groß für das Zeitbudget | Verengere `paths` oder übergib ein größeres `timeout_sec` |
| Der Worker liest fachfremde Dateien | Keine brauchbare Dateiliste im Prompt | Übergib `paths`; prüfe „N file(s) in scope" im Status |
| Abgelehnt: `.cmd/.bat` cannot receive a multi-line prompt | Einschränkung von cmd.exe unter Windows | `"promptVia": "stdin"`, oder lass `command` auf die `.exe` zeigen |
| `--settings must be a JSON object` beim manuellen Testen von agy in PowerShell 5.1 | PowerShell entfernt die inneren Anführungszeichen von Inline-JSON | Schreibe das JSON in eine Datei und übergib deren Pfad |
| `offload_*`-Werkzeuge fehlen in Claude Code | Server nicht registriert oder Start fehlgeschlagen | `claude mcp get offload`, dann `node dist/index.js doctor` |
| Der Status warnt, dass sich git status während des Jobs geändert hat | Etwas hat in den Workspace geschrieben, während der Job lief | Prüfe `git status` / `git diff`; es können deine eigenen Änderungen sein |
| Ratenlimit- oder Kontingentfehler von agy | Modellkontingent deines Google-Tarifs | Senke `maxConcurrent`, versuche es später erneut oder füge `--model` zu `args` hinzu |

Jeder Job behält seine Dateien in `~/.offload/jobs/<job_id>/`: `prompt.md` (genau das, was der Worker erhalten hat),
`stdout.log`, `stderr.log`, `report.md` und `job.json`.

## Sicherheitsmodell

- **Schreibgeschützt durch Werkzeugauswahl und einen Vertrag, nicht durch eine Sandbox.** `offload-reader` hat
  nur Werkzeuge zum Lesen von Dateien, und der Prompt verbietet Schreibzugriffe, aber der Worker läuft als dein
  Benutzer. Für stärkere Isolation nutze die Sandbox des Backends (agys `--sandbox` benötigt Windows 11 24H2
  oder neuer, macOS oder Linux), einen Container oder einen separaten Betriebssystembenutzer.
- **Änderungserkennung.** `git status` wird vor und nach jedem Job verglichen; geänderte Dateien werden gemeldet.
  Das ist ein Best-Effort-Verfahren und kann Schreibzugriffe des Workers nicht von deinen eigenen unterscheiden.
- **Pfadbegrenzung.** `workspace` und `paths` werden mit `realpath` aufgelöst; Pfade müssen im Workspace bleiben,
  und der Workspace muss das Arbeitsverzeichnis des Servers sein oder innerhalb von `allowedRoots` liegen.
- **Die Konfiguration stammt nie aus einem Projekt.** Sie wird nur aus `OFFLOAD_CONFIG` oder dem
  Home-Verzeichnis gelesen, sodass ein geklontes Repository den Server keinen Befehl seiner Wahl ausführen lassen kann.
- **Keine Shell.** Worker werden mit einem Argument-Array gestartet (über `cross-spawn`), nie mit einem Shell-String.
- **Worker-Ausgaben sind nicht vertrauenswürdig.** Dateien können Prompt Injection enthalten. Dem Worker wird gesagt,
  Dateiinhalte als Daten zu behandeln, die Werkzeuge präsentieren Ergebnisse als Hinweise, die zu prüfen sind,
  und die Skill weist den Hauptagenten an, zitierte Zeilen zu öffnen, bevor er handelt.
- **Deine Dateien verlassen deinen Rechner.** Der Worker sendet, was er liest, an seinen Modellanbieter (bei agy
  Google). Lagere keine Arbeit über Dateien aus, die du mit diesem Anbieter nicht teilen darfst.

## FAQ

<details>
<summary><b>Warum nicht einfach Claude-Code-Subagents nutzen?</b></summary>

Subagents laufen beim selben Modellanbieter und auf demselben Kontingent wie der Hauptagent, das Lesen kostet
also weiterhin Claude-Tokens. offload verlagert das Lesen auf das Kontingent eines anderen Anbieters, hier deines
Google-Tarifs, und gibt nur das Ergebnis zurück.
</details>

<details>
<summary><b>Spart es Geld?</b></summary>

Es verlagert das Lesen auf das Kontingent des Workers und verkleinert, was der Hauptagent liest, bei
Inventar-Aufgaben oft um eine Größenordnung. Der Worker selbst kann viele Tokens verbrauchen (192k im obigen
Beispiel), ob es also „günstiger" ist, hängt von deinen Tarifen auf beiden Seiten ab.
</details>

<details>
<summary><b>Kann der Worker meine Dateien bearbeiten?</b></summary>

Der Agent `offload-reader` hat weder Bearbeitungs- noch Terminalwerkzeuge, und der Prompt verbietet Änderungen.
Der Worker läuft trotzdem als dein Benutzer, betrachte das also als starke Konvention und nicht als Sandbox.
Der Server warnt, wenn sich `git status` während eines Jobs ändert.
</details>

<details>
<summary><b>Warum ist es langsam?</b></summary>

Der Worker liest jede relevante Datei vollständig, einen Werkzeugaufruf nach dem anderen; 37 Dateien dauerten etwa acht Minuten.
Schick früh ab und arbeite weiter. Engere `paths` machen es schneller.
</details>

<details>
<summary><b>Kann ich stattdessen die Gemini CLI verwenden?</b></summary>

Google hat private Konten auf die Antigravity CLI umgestellt, daher zielt dieses Projekt auf `agy`. Jede CLI mit
nicht interaktivem Modus funktioniert als Backend; siehe [Andere Backends](#andere-backends).
</details>

<details>
<summary><b>Welche Plattformen werden unterstützt?</b></summary>

Der Server ist schlichtes Node.js und läuft unter Windows, macOS und Linux. Die vollständige Einrichtung wurde unter Windows 10 getestet.
Das Abbrechen des Prozessbaums nutzt unter Windows `taskkill` und sonst Prozessgruppen.
</details>

<details>
<summary><b>Welche MCP-Clients funktionieren?</b></summary>

Jeder Client, der stdio-MCP-Server startet. Die Einrichtungsanleitung hier gilt für Claude Code; die Skill-Datei ist
Claude-Code-spezifisch, die Werkzeuge sind es nicht.
</details>

## Entwicklung

```bash
npm run build
npm run smoke
npm test
npm run doctor
npm run try -- <workspace> "<task>" [path ...]
npx @modelcontextprotocol/inspector node dist/index.js
```

`npm test` baut, führt den Smoke-Test aus und prüft, dass jede übersetzte README die Codeblöcke dieser
README beibehält. Der Mock-Worker (`scripts/mock-agent.mjs`) reagiert auf Marker in der Aufgabe: `SLOW_MODE` schläft
60 s, `BAD_FORMAT` ignoriert das Berichtsformat, `WRITE_FILE` schreibt in den Workspace.

### Projektstruktur

```text
src/
  index.ts      Einstiegspunkt: MCP-Server über stdio, oder `doctor`
  config.ts     Konfigurationsschema, Standardwerte, eingebautes agy-Backend
  tools.ts      die vier MCP-Werkzeuge, Pfadprüfungen, Statusformatierung
  jobs.ts       Warteschlange, Starten, Timeouts, Abbrechen, Ergebnisauswertung, Änderungserkennung
  manifest.ts   Dateien im Scope (git ls-files oder Verzeichnisdurchlauf)
  report.ts     Worker-Prompt, Berichtsauswertung, JSON-Extraktion, Link-Entfernung
  doctor.ts     Einrichtungsprüfungen
agents/offload-reader.md     schreibgeschützter Worker-Agent für agy
skills/offload/SKILL.md      Claude-Code-Skill: wann und wie ausgelagert wird
scripts/smoke.ts             Ende-zu-Ende-Test gegen den Mock-Worker
scripts/mock-agent.mjs       Ersatz-Worker
scripts/try.ts               eine echte Aufgabe über den Server ausführen
scripts/check-readmes.mjs    hält übersetzte READMEs synchron
docs/readme/                 übersetzte READMEs
```

## Roadmap

- `npx`-Einrichtungsbefehl, der Agent, Konfiguration, MCP-Registrierung und Skill in einem Schritt installiert
- npm-Paket
- Ein Suchwerkzeug für den agy-Worker, sobald benutzerdefinierte Headless-Agenten eines nutzen können
- Getestete Rezepte für weitere Worker-CLIs
- Modellauswahl pro Aufgabe

## Mitwirken

Issues und Pull Requests sind willkommen. Bitte führe `npm test` aus, bevor du einen Pull Request öffnest. Wenn du
diese README änderst, aktualisiere die Übersetzungen in `docs/readme/` oder eröffne ein Issue, damit sie aktualisiert werden können;
die README-Prüfung schlägt fehl, wenn die Codeblöcke einer Übersetzung von dieser Datei abweichen.

## Lizenz

[MIT](../../LICENSE)
