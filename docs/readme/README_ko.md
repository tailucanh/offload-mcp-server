<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · **한국어** · [Tiếng Việt](README_vi.md) · [Español](README_es.md) · [Français](README_fr.md) · [Deutsch](README_de.md) · [Português (Brasil)](README_pt-BR.md) · [Русский](README_ru.md)

# offload-mcp-server

### 무거운 읽기 작업은 두 번째 에이전트에게 맡기고, 메인 코딩 에이전트는 답만 읽게 하세요.

**Claude Code가 요청하고, Antigravity CLI가 37개 파일을 읽고, Claude는 500 토큰만 읽습니다.**

[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](../../LICENSE)
[![Node.js 20.3+](https://img.shields.io/badge/Node.js-20.3%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](#요구-사항)
[![MCP server](https://img.shields.io/badge/MCP-stdio_server-5c4ee5?style=flat-square)](#도구)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)](../../src)
[![Worker: Antigravity CLI](https://img.shields.io/badge/worker-Antigravity_CLI-4285f4?style=flat-square)](#2단계-antigravity-cli-설치-및-로그인)
[![GitHub stars](https://img.shields.io/github/stars/tailucanh/offload-mcp-server?style=flat-square)](https://github.com/tailucanh/offload-mcp-server/stargazers)

[빠른 시작](#빠른-시작) · [동작 방식](#동작-방식) · [오프로드 대상](#오프로드-대상) · [설정](#설정-단계별-안내) · [측정 결과](#측정-결과) · [문제 해결](#문제-해결) · [FAQ](#faq) · [보안](#보안-모델)

<code>claude mcp add --scope user offload -- node /path/to/offload-mcp-server/dist/index.js</code>

</div>

> [!IMPORTANT]
> 공식 소스는 [github.com/tailucanh/offload-mcp-server](https://github.com/tailucanh/offload-mcp-server)입니다.
> 이 패키지는 아직 npm에 배포되지 않았습니다. 이름이 비슷한 패키지나 저장소는 이 프로젝트가 아닙니다.

---

코딩 에이전트는 컨텍스트의 대부분을 **읽기**에 씁니다. 소스 트리를 훑고, 로그를 살피고, 압축된(minified)
번들을 열어 함수 하나를 찾는 식입니다. 답은 한 문단인데 읽는 데 4만 토큰이 든다면 남는 장사가 아닙니다.

**offload-mcp-server**는 작은 MCP 서버로, 메인 에이전트에게 도구 네 가지를 제공합니다. 이 도구로 그 읽기 작업을
**백그라운드에서 실행되는 두 번째 에이전트 CLI**에 넘길 수 있습니다. 기본값은 Google의 Antigravity CLI(`agy`)와
읽기 전용 워커 에이전트입니다. 워커는 자신의 할당량으로 파일을 읽고 정해진 형식의 보고서를 작성합니다.
메인 에이전트는 **Summary**(수백 단어)만 읽고, `path:line` 근거가 담긴 **Findings**는 필요할 때만 가져옵니다.

- **비동기.** 작업을 제출하고, 다른 일을 계속하다가, 나중에 결과를 받습니다. 여러 작업을 병렬로 실행할 수 있습니다.
- **설계상 읽기 전용.** 워커 에이전트는 파일 읽기 도구만 갖고 있으며, 작업이 실행되는 동안 `git status`가 바뀐
  파일이 있으면 서버가 이를 보고합니다.
- **범위 한정.** 서버가 대상 파일 목록(`git ls-files`)을 워커에 전달하므로 워커가 엉뚱한 파일을 헤매지 않습니다.
- **백엔드 독립.** 프롬프트를 받아 답을 출력하는 CLI라면 무엇이든 워커가 될 수 있습니다. `claude -p`도 가능합니다.
- **측정 가능.** 각 작업은 워커의 토큰 수를 기록하며, `npm run try`로 메인 에이전트가 실제로 읽은 양을 확인할 수 있습니다.

## 빠른 시작

Node.js 20.3 이상, Git, 로그인된 [Antigravity CLI](#2단계-antigravity-cli-설치-및-로그인), 그리고
Claude Code(또는 다른 MCP 클라이언트)가 필요합니다.

```bash
git clone https://github.com/tailucanh/offload-mcp-server.git
cd offload-mcp-server
npm install
npm run build
npm run smoke
```

그다음 읽기 전용 워커 에이전트를 설치하고, 서버를 등록하고, 스킬을 설치합니다.

```bash
mkdir -p ~/.gemini/agents && cp agents/offload-reader.md ~/.gemini/agents/
claude mcp add --scope user offload -- node "$(pwd)/dist/index.js"
mkdir -p ~/.claude/skills/offload && cp skills/offload/SKILL.md ~/.claude/skills/offload/
```

Windows에서는 [설정 단계별 안내](#설정-단계별-안내)의 PowerShell 명령을 따르세요. 새 Claude Code 세션을
시작하고 이렇게 요청해 보세요.

```text
이걸 오프로드해 줘: api/ 아래의 모든 HTTP 엔드포인트를 메서드와 인증 검사 여부와 함께 목록으로 만들고,
summary를 보여 줘.
```

## 동작 방식

```mermaid
sequenceDiagram
    autonumber
    participant M as 메인 에이전트 (Claude Code)
    participant S as offload-mcp-server
    participant W as 워커 (agy + offload-reader)
    M->>S: offload_submit_task(task, steps, output_hint, done_when, paths)
    S->>S: 경로 검사, 대상 파일 목록 작성 (git ls-files), 프롬프트 생성
    S-->>M: job_id (즉시 반환)
    S->>W: 백그라운드에서 실행
    Note over M: 다른 작업을 계속 진행
    W->>W: read_file … (목록의 파일만)
    W-->>S: 보고서: Summary / Findings / Uncertain / Files read
    S->>S: file:// 링크 제거, 섹션 파싱, 토큰 기록, git status 비교
    M->>S: offload_get_status(job_id, wait_sec=50)
    S-->>M: 상태 + Summary (수백 단어)
    opt Summary만으로 부족할 때만
        M->>S: offload_get_result(job_id, part="findings")
        S-->>M: path:line 근거가 담긴 Findings
    end
    Note over M: 조치하기 전에 인용된 줄을 표본 확인
```

1. **제출.** 서버는 `workspace`와 `paths`를 `realpath`로 해석하고, 워크스페이스 밖의 경로는 거부하며,
   대상 파일 목록을 만든 뒤 작업을 큐에 넣습니다.
2. **실행.** 최대 `maxConcurrent`개의 워커가 동시에 실행되며, 각각 워크스페이스 안에서 동작합니다. 출력은
   `~/.offload/jobs/<job_id>/`에 저장됩니다.
3. **파싱.** 워커가 종료되면 서버는 답을 추출하고, `file://` 링크(토큰만 소모하고 쓸모가 없습니다)를 제거하고,
   보고서를 섹션별로 나누고, 워커의 토큰 수를 기록합니다.
4. **수거.** `offload_get_status`는 호출당 최대 50초까지 기다립니다. 많은 MCP 클라이언트의 호출당 약 60초
   제한보다 짧은 값입니다. 완료된 상태에는 이미 Summary가 들어 있습니다.

## 오프로드 대상

| 오프로드하세요 | 직접 하세요 |
|---|---|
| 트리 전체에 걸친 목록화: 모든 엔드포인트, 설정 키, 권한 검사, 호출 위치 | 모든 종류의 편집: 워커는 읽기 전용입니다 |
| 크거나 생성된 파일: 압축된 번들, 리소스 팩, 락 파일, 긴 로그, 데이터 덤프 | 한두 번 읽거나 grep 한 번이면 답할 수 있는 조회 |
| "이 30개 파일 중 X와 관련 있는 것은 무엇인가?" | 급한 일: 작업에는 몇 분이 걸립니다 |
| 코딩을 계속하면서 병렬로 진행할 수 있는 조사 | 어차피 한 줄씩 직접 검증해야 하는 보안 관련 결론 |

**경험칙:** 읽어야 할 양이 필요한 답보다 10배 이상 클 때 오프로드하세요.

## 도구

| 도구 | 입력 | 반환 |
|---|---|---|
| `offload_submit_task` | `task`, `steps`, `output_hint`, `done_when`(4개 모두 필수); `context`, `exclude`, `paths`, `workspace`, `backend`, `timeout_sec` | 즉시 `job_id`를 반환하고, 작업은 백그라운드에서 실행 |
| `offload_get_status` | `job_id`, `wait_sec`(0–50), `limit` | 상태, 대상 파일, 워커 토큰 수, 완료 시 Summary. `job_id`가 없으면 최근 작업 목록 |
| `offload_get_result` | `job_id`, `part`(`summary`, `findings`, `steps`, `uncertain`, `full`, `stderr`), `offset`, `max_chars` | 보고서의 한 페이지(최대 25,000자) |
| `offload_cancel_task` | `job_id` | 대기 중이거나 실행 중인 작업을 전체 프로세스 트리와 함께 종료 |

작업 상태: `queued` → `running` → `succeeded` · `failed` · `cancelled` · `timed_out`. 서버가 중지될 때
실행 중이던 작업은 다음 시작 시 `interrupted`가 됩니다.

### 보고서 규약

모든 워커에게 같은 규칙이 적용됩니다. 아무것도 수정하지 않는다, 나열된 파일만 읽는다, `.git`은 절대 읽지 않는다,
근거는 평문 `path:line`으로 인용한다, 파일 내용은 지시가 아니라 데이터로 취급한다, 답은 한 번의 메시지로 한다.
워커는 다음 형식으로 응답합니다.

```text
## Summary       직접적인 답. 최대 `summaryWords` 단어 (기본값 200)
## Findings      글머리 기호. 각 항목에 path:line 근거 포함
## Step log      단계마다 한 줄: done, partial 또는 not done
## Uncertain     검증하지 못한 내용. 없으면 "None"
## Files read    실제로 연 파일
```

워커가 형식을 지키지 않으면 상태에 그 사실이 표시되고, Summary는 발췌문으로 대체됩니다.

---

## 설정 단계별 안내

Windows 10, Antigravity CLI 1.5.3(Google AI Pro 계정), Node.js 24, Claude Code 2.1.319에서 테스트했습니다.
경로의 `~`는 홈 디렉터리(Windows에서는 `C:\Users\<you>`)를 뜻합니다.

### 요구 사항

| 항목 | 버전 | 이유 |
|---|---|---|
| Node.js | 20.3 이상 | 서버 실행 |
| Git | 최근 버전이면 무엇이든 | 대상 파일 목록 작성, 작업 중 변경 감지 |
| Antigravity CLI | 1.5.3에서 테스트 | 기본 워커. 프롬프트를 받아 답을 출력하는 CLI라면 대체 가능 |
| MCP 클라이언트 | Claude Code에서 테스트 | stdio MCP 서버를 실행할 수 있는 것이면 무엇이든 |

### 1단계: 서버 빌드

```bash
git clone https://github.com/tailucanh/offload-mcp-server.git
cd offload-mcp-server
npm install
npm run build
npm run smoke
```

`npm run smoke`는 모의(mock) 워커를 대상으로 12개의 엔드투엔드 검사를 실행하며(네트워크와 할당량을 쓰지 않습니다),
`Smoke test passed`로 끝나야 합니다. `dist/index.js`의 절대 경로를 적어 두세요. 아래 예시에서는
`D:/Tool/offload-mcp-server/dist/index.js`를 사용합니다.

### 2단계: Antigravity CLI 설치 및 로그인

사용 중인 플랫폼에 맞는 Google의 Antigravity CLI 안내를 따르세요. Windows에서는 공식 PowerShell 설치
스크립트를 사용했습니다. 실행하기 전에 내려받아 내용을 먼저 읽어 보세요.

```powershell
Invoke-WebRequest https://antigravity.google/cli/install.ps1 -OutFile install.ps1
notepad install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
```

Windows 설치 프로그램은 `agy.exe`를 `%LOCALAPPDATA%\agy\bin`에 설치하고, SHA-512 체크섬을 검증한 뒤
PATH에 추가합니다. 그런 다음 **새 터미널에서** 다음을 실행하세요.

```bash
agy --version
agy
```

처음 대화형으로 실행하면 브라우저가 열리고 Google 계정으로 로그인합니다. 로그인 후에는 `/quit`으로 종료하세요.
Windows Defender가 첫 실행 때 `agy.exe`를 몇 분간 격리할 수 있습니다. 잠시 기다린 뒤 다시 시도하세요.

### 3단계: 읽기 전용 워커 에이전트 설치

[`agents/offload-reader.md`](../../agents/offload-reader.md)를 `~/.gemini/agents/`에 복사하세요.

Windows(PowerShell):

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.gemini\agents" | Out-Null
Copy-Item agents\offload-reader.md "$env:USERPROFILE\.gemini\agents\"
```

macOS / Linux:

```bash
mkdir -p ~/.gemini/agents && cp agents/offload-reader.md ~/.gemini/agents/
```

agy가 이 에이전트를 인식하는지 확인하세요. 출력에 `offload-reader`가 포함되어야 합니다.

```bash
agy agents
```

> [!WARNING]
> 에이전트 파일은 **BOM 없는 UTF-8**로 저장하세요. BOM이 있으면 agy가 에이전트를 무시하고
> `unknown agent`를 보고합니다. Windows PowerShell 5.1의 `Set-Content -Encoding utf8`은 BOM을 쓰므로,
> 대신 편집기를 사용하세요.

**왜 커스텀 에이전트가 필요한가요?** 헤드리스 모드(`agy -p`)에서 agy는 사용자에게 권한을 물어볼 수 없습니다. 기본
에이전트는 `ls` 같은 터미널 명령을 먼저 실행하려는 경우가 많은데, 그 명령은 자동으로 거부되고 실행은
**빈 답변과 종료 코드 0**으로 끝납니다. `offload-reader`는 파일 도구만 선언하므로 터미널에 손을 뻗지 않으며,
파일을 편집할 방법도 없습니다.

### 4단계: 설정 파일 작성

[`offload.config.example.json`](../../offload.config.example.json)을 바탕으로 `~/.offload/config.json`을
만드세요.

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
> `command`에는 `agy`의 **전체 경로**를 넣으세요. MCP 서버는 자신을 실행한 편집기의 PATH를 그대로 물려받는데,
> agy를 설치하기 전에 이미 열려 있던 편집기는 새 PATH 항목을 보지 못합니다.

설정 파일이 없으면 내장 `agy` 백엔드가 같은 인수와 `command: "agy"`로 사용됩니다. 설정은 `OFFLOAD_CONFIG`
또는 `~/.offload/config.json`에서만 읽으며, 프로젝트 폴더에서는 절대 읽지 않습니다.

### 5단계: 설정 확인

```bash
node D:/Tool/offload-mcp-server/dist/index.js doctor
```

`doctor`는 사용 중인 설정, 각 백엔드 명령을 찾았는지 여부, 기본 백엔드의 `--help` 첫 몇 줄을 출력합니다.
빠진 것이 있으면 종료 코드 1로 끝납니다.

### 6단계: MCP 클라이언트 없이 실제 작업 시험하기

`npm run try`는 빌드된 서버를 실제 설정으로 MCP 클라이언트와 똑같이 구동합니다.

```bash
npm run try -- "/path/to/your/project" "List every HTTP endpoint with its method and auth check" src/api
```

상태와 Summary, 이어서 Findings, 그리고 메인 에이전트가 읽게 될 글자 수를 출력합니다. 몇 분 정도 걸립니다.

### 7단계: Claude Code에 서버 등록

모든 프로젝트에 적용하려면(사용자 범위):

```bash
claude mcp add --scope user offload -- node D:/Tool/offload-mcp-server/dist/index.js
claude mcp get offload
```

`claude mcp get offload`가 `Status: Connected`를 보고해야 합니다.

`claude`가 PATH에 없는 경우(예: VS Code 확장만 사용하는 경우) 확장에 CLI가 포함되어 있습니다. Windows에서는
`~/.vscode/extensions/anthropic.claude-code-<version>-win32-x64/resources/native-binary/claude.exe`에 있고,
Antigravity IDE에서는 `~/.antigravity/extensions/` 아래에 있습니다. 같은 명령을 그 경로로 실행하세요.

한 프로젝트에서만 쓰려면 대신 프로젝트 루트에 `.mcp.json`을 추가하세요.

```json
{
  "mcpServers": {
    "offload": { "command": "node", "args": ["D:/Tool/offload-mcp-server/dist/index.js"] }
  }
}
```

서버는 자신의 작업 디렉터리, 즉 클라이언트가 연 프로젝트를 기본 워크스페이스로 사용합니다.
다른 MCP 클라이언트에서는 stdio로 `node /path/to/dist/index.js`를 실행하세요.

### 8단계: 스킬 설치

스킬은 오프로드가 언제 효과적인지, 도구를 어떻게 쓰는지 Claude에게 알려 줍니다.

Windows(PowerShell):

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\skills\offload" | Out-Null
Copy-Item skills\offload\SKILL.md "$env:USERPROFILE\.claude\skills\offload\"
```

macOS / Linux:

```bash
mkdir -p ~/.claude/skills/offload && cp skills/offload/SKILL.md ~/.claude/skills/offload/
```

### 9단계: 재시작 및 확인

새 Claude Code 세션을 시작하고(편집기에서는 창을 다시 불러오고) `/mcp`를 실행하세요. `offload`가 도구 네 개와 함께
연결되어 있어야 합니다. 그런 다음 실제 작업을 맡겨 보세요.

```text
이걸 오프로드해 줘: api/v1 아래의 각 엔드포인트에 대해 URL, HTTP 메서드, 인증 요구 사항,
주로 사용하는 클래스를 나열해 줘. 폴더별로 묶고 path:line을 인용해 줘.
```

---

## 잘 활용하기

### 일반적인 흐름

1. 메인 에이전트가 정확한 `task`, 좁힌 `paths`, 그리고 `table: endpoint | method | auth | file:line` 같은
   `output_hint`와 함께 `offload_submit_task`를 호출합니다.
2. 다른 작업을 계속하다가, 작업이 끝날 때까지 `wait_sec: 50`으로 `offload_get_status`를 호출합니다.
3. Summary를 읽습니다. 그것으로 부족할 때만 `part: "findings"`로 `offload_get_result`를 호출합니다.
4. 결과대로 조치하기 전에, 인용된 줄을 두세 군데 열어 확인합니다.

### 좋은 작업 작성법

- **끝이 분명한 구체적인 질문 하나.** "API를 살펴봐"가 아니라 "Y와 Z를 가진 모든 X를 나열해 줘"처럼 씁니다.
- **`paths`를 좁게.** 워커는 나열된 파일만 읽으므로, 범위가 시간과 비용을 모두 결정합니다.
- **완전한 브리프를 작성하세요.** `steps`(순서가 있는 구체적인 작업), `output_hint`, `done_when`은 필수이고 `context`(이미 알고 있는 내용)와 `exclude`는 선택입니다. 워커는 그 단계만 수행하고 다른 일은 하지 않으며, 각 단계를 done, partial, not done으로 기록합니다. 상태의 *Brief check* 줄에 끝내지 못한 단계가 표시됩니다.
- **`output_hint`로 형태를 요청하세요.** 표, 묶은 글머리 기호, 근거가 있는 예/아니오 등.
- **근거(`path:line`)를 요청하세요.** 결과를 표본 검증할 수 있습니다.
- **일찍 제출하세요.** 작업에는 몇 분이 걸립니다. 먼저 제출하고, 그 결과에 의존하지 않는 일을 하세요.

## 측정 결과

작업: "`api/v1` 아래의 모든 HTTP 엔드포인트 목록화: URL, 메서드, 인증 요구 사항, 주요 클래스".
프로젝트: PHP 파일 37개, 140 KB.

| 항목 | 결과 |
|---|---|
| 워커 소요 시간 | 503초 |
| 워커 토큰 (Gemini Flash, Google 할당량 사용) | 192k |
| 메인 에이전트, Summary만 | 약 2k자 (≈ 0.5k 토큰) |
| 메인 에이전트, Summary + Findings | 약 26k자 (≈ 6.5k 토큰) |
| 37개 파일을 직접 읽는 경우 | ≈ 40k 토큰 |
| 표본 확인 | 추출한 주장 6건 모두 인용된 줄과 정확히 일치 |

서버가 파일 목록을 프롬프트에 넣기 전에는, 비슷한 작업에서 워커가 관련 없는 파일(`.git` 포함)을 헤매다가
200k 토큰 넘게 쓰고 시간 초과가 났습니다. **범위 한정이 이 방식을 동작하게 만드는 핵심입니다.**

## 설정 레퍼런스

파일: `OFFLOAD_CONFIG`가 설정되어 있으면 그 파일, 아니면 `~/.offload/config.json`.

| 키 | 기본값 | 의미 |
|---|---|---|
| `defaultBackend` | `agy` | 작업에서 백엔드를 지정하지 않았을 때 사용하는 백엔드 |
| `maxConcurrent` | `2` | 동시에 실행하는 작업 수. 나머지는 큐에서 대기 |
| `jobsDir` | `~/.offload/jobs` | 작업 기록과 보고서를 저장하는 위치 |
| `allowedRoots` | `[]` | 작업이 `workspace`로 쓸 수 있는 추가 디렉터리. 서버의 작업 디렉터리는 항상 허용 |
| `summaryWords` | `200` | 워커의 Summary 단어 수 한도 |
| `manifestLimit` | `400` | 워커 프롬프트에 나열하는 대상 파일의 최대 개수 |
| `backends.<name>.command` | | 실행 파일 이름 또는 전체 경로 |
| `backends.<name>.args` | `[]` | 인수. 플레이스홀더: `{prompt}`, `{workspace}`, `{timeoutSec}` |
| `backends.<name>.promptVia` | `arg` | `arg`는 프롬프트를 `{prompt}` 위치에 넣음(없으면 끝에 덧붙임). `stdin`은 표준 입력으로 전달 |
| `backends.<name>.outputJsonPath` | | CLI가 JSON을 출력할 때 답에 이르는 점(.) 경로. 예: `response` |
| `backends.<name>.usageJsonPath` | | 워커의 토큰 수에 이르는 점(.) 경로. 예: `usage.total_tokens` |
| `backends.<name>.env` | `{}` | 워커에 전달할 추가 환경 변수 |
| `backends.<name>.timeoutSec` | `600` (agy) | 시간 한도. 워커는 그 30초 뒤에 강제 종료되므로, 자체 제한이 있는 CLI는 그보다 먼저 깔끔하게 멈춤 |

## 다른 백엔드

프롬프트를 받아 답을 출력하는 CLI라면 무엇이든 워커가 될 수 있습니다. `backends` 아래에 추가한 다음, 작업에서
`backend: "<name>"`을 넘기거나 `defaultBackend`로 지정하세요. Claude Code 자체를 print 모드로 쓰는 예시:

```json
"claude": {
  "command": "claude",
  "args": ["-p", "--output-format", "json"],
  "promptVia": "stdin",
  "outputJsonPath": "result",
  "timeoutSec": 900
}
```

CLI를 맞춰 넣을 때는 다음 순서를 따르세요.

1. 비대화형 플래그(`-p`, `exec`, `--print` 등)를 찾아 프롬프트 하나를 직접 실행해 봅니다.
2. JSON 출력 플래그를 우선 사용합니다. `outputJsonPath`를 설정하고, 토큰 수를 보고한다면 `usageJsonPath`도 설정합니다.
3. 읽기 전용으로 만듭니다. 계획(plan) 모드나 읽기 전용 모드, 샌드박스 플래그, 또는 `offload-reader` 같은 제한된 에이전트를 사용하세요.
4. 헤드리스 모드에서 도구가 승인을 요구하면 어떻게 되는지 확인합니다. CLI가 아무 말 없이 빈 결과를 반환한다면
   3단계처럼 도구를 제한하세요.
5. Windows에서 `.cmd`/`.bat` 명령은 여러 줄 프롬프트를 인수로 받을 수 없습니다(cmd.exe는 첫 줄바꿈에서 멈춥니다).
   `"promptVia": "stdin"`을 쓰거나 `command`가 `.exe`를 가리키게 하세요. 서버는 잘린 프롬프트를 보내는 대신
   이 조합을 거부합니다.

## 문제 해결

| 증상 | 원인 | 해결 |
|---|---|---|
| `failed`: "gave no answer, often because a tool permission was denied", 출력에 `denied_actions`가 표시됨 | 워커가 승인이 필요한 도구, 보통은 터미널 명령을 시도함 | `offload-reader` 에이전트를 사용(3단계). `args`에 `--agent offload-reader`가 있는지 확인 |
| `unknown agent "offload-reader"` | 에이전트 파일이 없거나, 폴더가 틀렸거나, BOM이 있는 상태로 저장됨 | BOM 없는 UTF-8로 `~/.gemini/agents/`에 두고 `agy agents`로 확인 |
| `--agent`에 파일 경로를 주면 실패함 | agy는 경로가 아니라 에이전트 **이름**을 받음 | 파일을 설치하고(3단계) 이름을 전달 |
| `failed`: backend command "agy" was not found | 편집기의 PATH가 agy 설치 이전의 것임 | `command`에 전체 경로를 사용(4단계)하거나 편집기를 다시 시작 |
| `timed_out`, 또는 agy가 `print timeout … partial`을 보고함 | 시간 한도에 비해 범위가 너무 큼 | `paths`를 좁히거나 더 큰 `timeout_sec`를 전달 |
| 워커가 관련 없는 파일을 읽음 | 프롬프트에 쓸 만한 파일 목록이 없음 | `paths`를 전달하고, 상태의 "N file(s) in scope"를 확인 |
| 거부됨: `.cmd/.bat` cannot receive a multi-line prompt | Windows cmd.exe의 제한 | `"promptVia": "stdin"`을 쓰거나 `command`가 `.exe`를 가리키게 함 |
| PowerShell 5.1에서 agy를 직접 테스트할 때 `--settings must be a JSON object` 발생 | PowerShell이 인라인 JSON 안의 따옴표를 제거함 | JSON을 파일로 저장하고 그 경로를 전달 |
| Claude Code에서 `offload_*` 도구가 보이지 않음 | 서버가 등록되지 않았거나 시작에 실패함 | `claude mcp get offload`를 실행한 뒤 `node dist/index.js doctor`를 실행 |
| 작업 중 git status가 바뀌었다는 경고가 상태에 표시됨 | 작업이 실행되는 동안 무언가가 워크스페이스에 썼음 | `git status` / `git diff`를 확인. 본인이 직접 수정한 내용일 수 있음 |
| agy에서 속도 제한 또는 할당량 오류가 발생 | Google 요금제의 모델 할당량 | `maxConcurrent`를 낮추거나, 나중에 다시 시도하거나, `args`에 `--model`을 추가 |

각 작업의 파일은 `~/.offload/jobs/<job_id>/`에 저장됩니다. `prompt.md`(워커가 받은 내용 그대로),
`stdout.log`, `stderr.log`, `report.md`, `job.json`입니다.

## 보안 모델

- **읽기 전용은 샌드박스가 아니라 도구 선택과 규약으로 보장합니다.** `offload-reader`는 파일 읽기 도구만 갖고 있고
  프롬프트도 쓰기를 금지하지만, 워커는 사용자 권한으로 실행됩니다. 더 강한 격리가 필요하면 백엔드의 샌드박스
  (agy의 `--sandbox`는 Windows 11 24H2 이상, macOS, Linux가 필요), 컨테이너, 또는 별도의 OS 사용자를 사용하세요.
- **변경 감지.** 각 작업 전후로 `git status`를 비교하여 바뀐 파일을 보고합니다. 최선의 노력(best effort) 방식이라
  워커가 쓴 내용과 사용자가 쓴 내용을 구분하지는 못합니다.
- **경로 제한.** `workspace`와 `paths`는 `realpath`로 해석됩니다. 경로는 워크스페이스 안에 있어야 하고,
  워크스페이스는 서버의 작업 디렉터리이거나 `allowedRoots` 안에 있어야 합니다.
- **설정은 프로젝트에서 읽지 않습니다.** 설정은 `OFFLOAD_CONFIG` 또는 홈 디렉터리에서만 읽으므로, 복제한 저장소가
  서버로 하여금 임의의 명령을 실행하게 만들 수 없습니다.
- **셸을 쓰지 않습니다.** 워커는 (`cross-spawn`을 통해) 인수 배열로 실행되며, 셸 문자열은 절대 쓰지 않습니다.
- **워커 출력은 신뢰하지 않습니다.** 파일에는 프롬프트 인젝션이 들어 있을 수 있습니다. 워커에게는 파일 내용을 데이터로
  취급하라고 지시하고, 도구는 결과를 검증해야 할 단서로 제시하며, 스킬은 메인 에이전트가 조치하기 전에 인용된 줄을
  열어 보게 합니다.
- **파일이 내 컴퓨터 밖으로 나갑니다.** 워커는 읽은 내용을 자신의 모델 제공자(agy의 경우 Google)에 전송합니다.
  그 제공자와 공유해서는 안 되는 파일에 대해서는 오프로드하지 마세요.

## FAQ

<details>
<summary><b>그냥 Claude Code 서브에이전트를 쓰면 안 되나요?</b></summary>

서브에이전트는 메인 에이전트와 같은 모델 제공자와 할당량으로 실행되므로, 읽기에도 여전히 Claude 토큰이 듭니다.
offload는 읽기 작업을 다른 제공자의 할당량(여기서는 Google 요금제)으로 옮기고, 결과만 돌려줍니다.
</details>

<details>
<summary><b>비용이 절약되나요?</b></summary>

읽기 작업을 워커의 할당량으로 옮기고 메인 에이전트가 읽는 양을 줄여 줍니다. 목록화 같은 작업에서는 종종
자릿수가 달라질 정도입니다. 다만 워커 자체가 많은 토큰을 쓸 수 있으므로(위 예시에서는 192k), "더 저렴한지"는
양쪽 요금제에 따라 달라집니다.
</details>

<details>
<summary><b>워커가 내 파일을 수정할 수 있나요?</b></summary>

`offload-reader` 에이전트에는 편집 도구도 터미널 도구도 없고, 프롬프트도 변경을 금지합니다. 그래도 워커는 사용자
권한으로 실행되므로, 샌드박스가 아니라 강한 약속 정도로 생각하세요. 작업 중 `git status`가 바뀌면 서버가 경고합니다.
</details>

<details>
<summary><b>왜 느린가요?</b></summary>

워커는 관련 파일을 모두 전체 내용으로, 도구 호출을 한 번에 하나씩 읽습니다. 37개 파일에 약 8분이 걸렸습니다.
일찍 제출하고 다른 작업을 계속하세요. `paths`를 좁히면 더 빨라집니다.
</details>

<details>
<summary><b>Gemini CLI를 대신 쓸 수 있나요?</b></summary>

Google이 개인 계정을 Antigravity CLI로 옮겼기 때문에, 이 프로젝트는 `agy`를 대상으로 합니다. 비대화형 모드가 있는
CLI라면 백엔드로 쓸 수 있습니다. [다른 백엔드](#다른-백엔드)를 참고하세요.
</details>

<details>
<summary><b>어떤 플랫폼을 지원하나요?</b></summary>

서버는 순수 Node.js이며 Windows, macOS, Linux에서 실행됩니다. 전체 설정은 Windows 10에서 테스트했습니다.
프로세스 트리 취소는 Windows에서는 `taskkill`을, 그 외에서는 프로세스 그룹을 사용합니다.
</details>

<details>
<summary><b>어떤 MCP 클라이언트에서 동작하나요?</b></summary>

stdio MCP 서버를 실행하는 클라이언트라면 모두 가능합니다. 여기의 설정 안내는 Claude Code 기준입니다.
스킬 파일은 Claude Code 전용이지만, 도구는 그렇지 않습니다.
</details>

## 개발

```bash
npm run build
npm run smoke
npm test
npm run doctor
npm run try -- <workspace> "<task>" [path ...]
npx @modelcontextprotocol/inspector node dist/index.js
```

`npm test`는 빌드하고, 스모크 테스트를 실행하고, 번역된 모든 README가 영어 README의 코드 블록을 그대로 유지하는지
확인합니다. 모의 워커(`scripts/mock-agent.mjs`)는 작업 안의 마커에 반응합니다. `SLOW_MODE`는 60초 동안 대기하고,
`BAD_FORMAT`은 보고서 형식을 무시하고, `WRITE_FILE`은 워크스페이스에 파일을 씁니다.

### 프로젝트 구조

```text
src/
  index.ts      진입점: stdio 기반 MCP 서버 또는 `doctor`
  config.ts     설정 스키마, 기본값, 내장 agy 백엔드
  tools.ts      MCP 도구 네 가지, 경로 검사, 상태 포맷팅
  jobs.ts       큐, 프로세스 실행, 시간 제한, 취소, 결과 파싱, 변경 감지
  manifest.ts   대상 파일 (git ls-files 또는 디렉터리 탐색)
  report.ts     워커 프롬프트, 보고서 파싱, JSON 추출, 링크 제거
  doctor.ts     설정 점검
agents/offload-reader.md     agy용 읽기 전용 워커 에이전트
skills/offload/SKILL.md      Claude Code 스킬: 언제, 어떻게 오프로드할지
scripts/smoke.ts             모의 워커를 대상으로 한 엔드투엔드 테스트
scripts/mock-agent.mjs       대역 워커
scripts/try.ts               서버를 통해 실제 작업 하나를 실행
scripts/check-readmes.mjs    번역된 README를 동기화 상태로 유지
docs/readme/                 번역된 README
```

## 로드맵

- 에이전트, 설정, MCP 등록, 스킬을 한 번에 설치하는 `npx` 설정 명령
- npm 패키지
- 헤드리스 커스텀 에이전트가 검색 도구를 쓸 수 있게 되면 agy 워커용 검색 도구 추가
- 더 많은 워커 CLI에 대한 검증된 레시피
- 작업별 모델 선택

## 기여하기

이슈와 풀 리퀘스트를 환영합니다. 풀 리퀘스트를 열기 전에 `npm test`를 실행해 주세요. 이 README를 수정할 때는
`docs/readme/`의 번역도 함께 업데이트하거나, 번역을 갱신할 수 있도록 이슈를 열어 주세요. 번역본의 코드 블록이
이 파일과 어긋나면 README 검사가 실패합니다.

## 라이선스

[MIT](../../LICENSE)
