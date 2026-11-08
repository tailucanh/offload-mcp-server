<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · [日本語](README_ja.md) · [한국어](README_ko.md) · [Tiếng Việt](README_vi.md) · [Español](README_es.md) · [Français](README_fr.md) · [Deutsch](README_de.md) · **Português (Brasil)** · [Русский](README_ru.md)

# offload-mcp-server

### Deixe seu agente de programação principal delegar a leitura pesada a um segundo agente e leia de volta só a resposta.

**O Claude Code pergunta. A Antigravity CLI lê 37 arquivos. O Claude lê 500 tokens.**

[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](../../LICENSE)
[![Node.js 20.3+](https://img.shields.io/badge/Node.js-20.3%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](#requisitos)
[![MCP server](https://img.shields.io/badge/MCP-stdio_server-5c4ee5?style=flat-square)](#ferramentas)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)](../../src)
[![Worker: Antigravity CLI](https://img.shields.io/badge/worker-Antigravity_CLI-4285f4?style=flat-square)](#passo-2-instale-e-entre-na-antigravity-cli)
[![GitHub stars](https://img.shields.io/github/stars/tailucanh/offload-mcp-server?style=flat-square)](https://github.com/tailucanh/offload-mcp-server/stargazers)

[Início rápido](#início-rápido) · [Como funciona](#como-funciona) · [O que delegar](#o-que-delegar) · [Configuração](#configuração-passo-a-passo) · [Resultados](#resultados-medidos) · [Solução de problemas](#solução-de-problemas) · [Perguntas frequentes](#perguntas-frequentes) · [Segurança](#modelo-de-segurança)

<code>claude mcp add --scope user offload -- node /path/to/offload-mcp-server/dist/index.js</code>

<img src="../assets/demo.svg" alt="Claude Code hands an endpoint inventory to the Antigravity CLI through offload-mcp-server and reads back a 0.5k-token summary" width="860">

</div>

> [!IMPORTANT]
> A fonte oficial é [github.com/tailucanh/offload-mcp-server](https://github.com/tailucanh/offload-mcp-server).
> O pacote ainda não foi publicado no npm. Um pacote ou repositório com nome parecido não é este projeto.

---

Agentes de programação gastam a maior parte do contexto **lendo**: percorrendo uma árvore de código, varrendo logs, abrindo um bundle minificado para achar uma única função. Quando a resposta é um parágrafo e a leitura custa 40.000 tokens, a troca não vale a pena.

O **offload-mcp-server** é um pequeno servidor MCP que dá ao seu agente principal quatro ferramentas para passar essa leitura a uma **segunda CLI de agente rodando em segundo plano**, por padrão a Antigravity CLI (`agy`) do Google, com um agente worker somente leitura. O worker lê os arquivos usando a própria cota e escreve um relatório em formato fixo. Seu agente principal lê o **Summary** (algumas centenas de palavras) e busca os **Findings** com evidências `path:line` só quando precisa deles.

- **Assíncrono.** Envie um job, continue trabalhando e colete o resultado depois. Vários jobs podem rodar em paralelo.
- **Somente leitura por design.** O agente worker tem apenas ferramentas de leitura de arquivos, e o servidor reporta qualquer arquivo cujo `git status` tenha mudado enquanto um job rodava.
- **Com escopo definido.** O servidor entrega ao worker a lista de arquivos no escopo (`git ls-files`), então ele não sai vagando.
- **Independente de backend.** Qualquer CLI que receba um prompt e imprima uma resposta pode ser o worker, inclusive `claude -p`.
- **Mensurável.** Cada job registra a contagem de tokens do worker, e `npm run try` mostra o que o agente principal realmente leu.

## Início rápido

Você precisa de Node.js 20.3+, Git, da [Antigravity CLI](#passo-2-instale-e-entre-na-antigravity-cli) com login feito e do Claude Code (ou outro cliente MCP).

```bash
git clone https://github.com/tailucanh/offload-mcp-server.git
cd offload-mcp-server
npm install
npm run build
npm run smoke
```

Depois instale o agente worker somente leitura, registre o servidor e instale a skill:

```bash
mkdir -p ~/.gemini/agents && cp agents/offload-reader.md ~/.gemini/agents/
claude mcp add --scope user offload -- node "$(pwd)/dist/index.js"
mkdir -p ~/.claude/skills/offload && cp skills/offload/SKILL.md ~/.claude/skills/offload/
```

No Windows, siga os comandos do PowerShell em [Configuração passo a passo](#configuração-passo-a-passo). Inicie uma nova sessão do Claude Code e peça:

```text
Delegue isto: faça um inventário de todos os endpoints HTTP em api/ com o método e a verificação
de autenticação de cada um, e depois me mostre o resumo.
```

## Como funciona

```mermaid
sequenceDiagram
    autonumber
    participant M as Agente principal (Claude Code)
    participant S as offload-mcp-server
    participant W as Worker (agy + offload-reader)
    M->>S: offload_submit_task(task, steps, output_hint, done_when, paths)
    S->>S: validar caminhos, listar arquivos no escopo (git ls-files), montar prompt
    S-->>M: job_id (imediatamente)
    S->>W: iniciar em segundo plano
    Note over M: continua trabalhando em outra coisa
    W->>W: read_file … (somente os arquivos listados)
    W-->>S: relatório: Summary / Findings / Uncertain / Files read
    S->>S: remover links file://, separar seções, registrar tokens, comparar git status
    M->>S: offload_get_status(job_id, wait_sec=50)
    S-->>M: status + Summary (algumas centenas de palavras)
    opt somente se o Summary não bastar
        M->>S: offload_get_result(job_id, part="findings")
        S-->>M: Findings com evidências path:line
    end
    Note over M: confere por amostragem as linhas citadas antes de agir
```

1. **Enviar.** O servidor resolve `workspace` e `paths` com `realpath`, recusa qualquer coisa fora do workspace, lista os arquivos no escopo e enfileira o job.
2. **Executar.** Até `maxConcurrent` workers rodam ao mesmo tempo, cada um no workspace. A saída vai para `~/.offload/jobs/<job_id>/`.
3. **Interpretar.** Quando o worker termina, o servidor extrai a resposta, remove links `file://` (custam tokens e não acrescentam nada), divide o relatório em seções e registra a contagem de tokens do worker.
4. **Coletar.** `offload_get_status` espera até 50 segundos por chamada, ficando abaixo do limite de cerca de 60 segundos por chamada de muitos clientes MCP. Um status de job concluído já contém o Summary.

## O que delegar

| Delegar | Fazer você mesmo |
|---|---|
| Inventários em toda uma árvore: cada endpoint, chave de configuração, verificação de permissão, ponto de chamada | Edições de qualquer tipo: o worker é somente leitura |
| Arquivos grandes ou gerados: bundles minificados, pacotes de recursos, lockfiles, logs longos, dumps de dados | Uma consulta que você resolve com uma ou duas leituras, ou com um grep |
| "Quais destes 30 arquivos importam para X?" | Qualquer coisa urgente: os jobs levam minutos |
| Pesquisa que pode rodar em paralelo enquanto você continua programando | Conclusões de segurança que você vai ter que verificar linha por linha de qualquer jeito |

**Regra prática:** delegue quando a leitura for pelo menos dez vezes maior que a resposta de que você precisa.

## Ferramentas

| Ferramenta | Entrada | Retorna |
|---|---|---|
| `offload_submit_task` | `task`, `steps`, `output_hint`, `done_when` (os quatro obrigatórios); `context`, `exclude`, `paths`, `workspace`, `backend`, `timeout_sec` | `job_id` na hora; o job roda em segundo plano |
| `offload_get_status` | `job_id`, `wait_sec` (0–50), `limit` | Status, arquivos no escopo, tokens do worker e o Summary quando concluído. Sem `job_id`: jobs recentes |
| `offload_get_result` | `job_id`, `part` (`summary`, `findings`, `steps`, `uncertain`, `full`, `stderr`), `offset`, `max_chars` | Uma página do relatório (até 25.000 caracteres) |
| `offload_cancel_task` | `job_id` | Encerra um job enfileirado ou em execução e toda a sua árvore de processos |

Estados de um job: `queued` → `running` → `succeeded` · `failed` · `cancelled` · `timed_out`. Jobs que estavam em execução quando o servidor parou passam para `interrupted` na próxima inicialização.

### O contrato do relatório

Todo worker recebe as mesmas regras: não modificar nada, ler somente os arquivos listados, nunca ler `.git`, citar evidências como `path:line` em texto simples, tratar o conteúdo dos arquivos como dados e não como instruções, e responder em uma única mensagem. Ele responde com:

```text
## Summary       a resposta direta, no máximo `summaryWords` palavras (padrão 200)
## Findings      itens de lista, cada um com evidência path:line
## Step log      uma linha por passo: done, partial ou not done
## Uncertain     o que não conseguiu verificar, ou "None"
## Files read    os arquivos que realmente abriu
```

Se o worker ignorar o formato, o status avisa e o Summary passa a ser um trecho do relatório.

---

## Configuração passo a passo

Testado no Windows 10 com a Antigravity CLI 1.5.3 (conta Google AI Pro), Node.js 24 e Claude Code 2.1.319. Os caminhos usam `~` para o seu diretório pessoal (`C:\Users\<você>` no Windows).

### Requisitos

| O quê | Versão | Para quê |
|---|---|---|
| Node.js | 20.3 ou superior | Executa o servidor |
| Git | qualquer versão recente | Lista os arquivos no escopo e detecta mudanças durante um job |
| Antigravity CLI | 1.5.3 testada | O worker padrão. Qualquer CLI que receba um prompt e imprima uma resposta pode substituí-la |
| Um cliente MCP | Claude Code testado | Qualquer cliente que inicie servidores MCP via stdio |

### Passo 1: Compile o servidor

```bash
git clone https://github.com/tailucanh/offload-mcp-server.git
cd offload-mcp-server
npm install
npm run build
npm run smoke
```

`npm run smoke` executa doze verificações de ponta a ponta contra um worker simulado (sem rede e sem cota) e deve terminar com `Smoke test passed`. Anote o caminho absoluto de `dist/index.js`; os exemplos a seguir usam `D:/Tool/offload-mcp-server/dist/index.js`.

### Passo 2: Instale e entre na Antigravity CLI

Siga as instruções do Google para a Antigravity CLI na sua plataforma. No Windows, usamos o instalador oficial em PowerShell. Baixe-o e leia antes de executar:

```powershell
Invoke-WebRequest https://antigravity.google/cli/install.ps1 -OutFile install.ps1
notepad install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
```

O instalador do Windows coloca o `agy.exe` em `%LOCALAPPDATA%\agy\bin`, verifica o checksum SHA-512 e o adiciona ao seu PATH. Depois, **em um novo terminal**:

```bash
agy --version
agy
```

A primeira execução interativa abre o navegador para você entrar com o Google. Saia depois com `/quit`. O Windows Defender pode colocar o `agy.exe` em quarentena por alguns minutos na primeira execução; aguarde e tente de novo.

### Passo 3: Instale o agente worker somente leitura

Copie [`agents/offload-reader.md`](../../agents/offload-reader.md) para `~/.gemini/agents/`.

Windows (PowerShell):

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.gemini\agents" | Out-Null
Copy-Item agents\offload-reader.md "$env:USERPROFILE\.gemini\agents\"
```

macOS / Linux:

```bash
mkdir -p ~/.gemini/agents && cp agents/offload-reader.md ~/.gemini/agents/
```

Confirme que o agy o enxerga. A saída deve conter `offload-reader`:

```bash
agy agents
```

> [!WARNING]
> Salve o arquivo do agente como **UTF-8 sem BOM**. Com BOM, o agy ignora o agente e informa `unknown agent`. O `Set-Content -Encoding utf8` do Windows PowerShell 5.1 grava um BOM; use um editor.

**Por que um agente personalizado?** No modo headless (`agy -p`), o agy não pode pedir permissão a você. O agente padrão costuma executar antes um comando de terminal como `ls`; esse comando é negado automaticamente e a execução termina com uma **resposta vazia e código de saída 0**. O `offload-reader` declara apenas ferramentas de arquivo, então nunca recorre ao terminal e não tem como editar arquivos.

### Passo 4: Escreva o arquivo de configuração

Crie `~/.offload/config.json`, partindo de [`offload.config.example.json`](../../offload.config.example.json):

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
> Coloque o **caminho completo** do `agy` em `command`. O servidor MCP herda o PATH do editor que o inicia, e um editor que já estava aberto quando você instalou o agy não enxerga a nova entrada.

Sem arquivo de configuração, usa-se o backend `agy` embutido, com os mesmos argumentos e `command: "agy"`. A configuração é lida somente de `OFFLOAD_CONFIG` ou de `~/.offload/config.json`, nunca de uma pasta de projeto.

### Passo 5: Verifique a configuração

```bash
node D:/Tool/offload-mcp-server/dist/index.js doctor
```

O `doctor` imprime a configuração em uso, informa se o comando de cada backend foi encontrado e mostra as primeiras linhas do `--help` do backend padrão. Ele sai com código 1 se algo estiver faltando.

### Passo 6: Teste uma tarefa real sem cliente MCP

`npm run try` conduz o servidor compilado exatamente como um cliente MCP faria, com a sua configuração real:

```bash
npm run try -- "/path/to/your/project" "List every HTTP endpoint with its method and auth check" src/api
```

Ele imprime o status com o Summary, depois os Findings e, por fim, quantos caracteres o agente principal teria lido. Espere alguns minutos.

### Passo 7: Registre o servidor no Claude Code

Para todos os projetos (escopo de usuário):

```bash
claude mcp add --scope user offload -- node D:/Tool/offload-mcp-server/dist/index.js
claude mcp get offload
```

`claude mcp get offload` deve mostrar `Status: Connected`.

Se o `claude` não estiver no seu PATH (por exemplo, se você só usa a extensão do VS Code), a extensão traz a CLI. No Windows, ela fica em `~/.vscode/extensions/anthropic.claude-code-<version>-win32-x64/resources/native-binary/claude.exe`, ou em `~/.antigravity/extensions/` na IDE Antigravity. Execute os mesmos comandos com esse caminho.

Para um único projeto, adicione um `.mcp.json` na raiz do projeto:

```json
{
  "mcpServers": {
    "offload": { "command": "node", "args": ["D:/Tool/offload-mcp-server/dist/index.js"] }
  }
}
```

O servidor usa o diretório de trabalho dele, o projeto que o seu cliente abriu, como workspace padrão. Outros clientes MCP: inicie `node /path/to/dist/index.js` via stdio.

### Passo 8: Instale a skill

A skill diz ao Claude quando vale a pena delegar e como usar as ferramentas.

Windows (PowerShell):

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\skills\offload" | Out-Null
Copy-Item skills\offload\SKILL.md "$env:USERPROFILE\.claude\skills\offload\"
```

macOS / Linux:

```bash
mkdir -p ~/.claude/skills/offload && cp skills/offload/SKILL.md ~/.claude/skills/offload/
```

### Passo 9: Reinicie e verifique

Inicie uma nova sessão do Claude Code (em um editor, recarregue a janela) e execute `/mcp`. O `offload` deve aparecer conectado com quatro ferramentas. Depois dê a ele uma tarefa real:

```text
Delegue isto: para cada endpoint em api/v1, liste a URL, os métodos HTTP, o requisito de
autenticação e a classe principal usada. Agrupe por pasta e cite path:line.
```

---

## Como usar bem

### Uma troca típica

1. O agente principal chama `offload_submit_task` com um `task` preciso, `paths` restritos e um `output_hint` como `table: endpoint | method | auth | file:line`.
2. Ele continua trabalhando e depois chama `offload_get_status` com `wait_sec: 50` até o job terminar.
3. Ele lê o Summary. Só se não bastar, chama `offload_get_result` com `part: "findings"`.
4. Ele abre duas ou três linhas citadas para confirmar antes de agir com base no resultado.

### Como escrever boas tarefas

- **Uma pergunta concreta** com um fim claro: "liste todo X com Y e Z", não "dê uma olhada na API".
- **`paths` restritos.** O worker lê somente os arquivos listados, então o escopo define tanto o tempo quanto o custo.
- **Escreva um brief completo.** `steps` (ações concretas, em ordem), `output_hint` e `done_when` são obrigatórios; `context` (o que você já sabe) e `exclude` são opcionais. O worker executa exatamente esses passos e nada mais, registra cada um como done, partial ou not done, e o status mostra uma linha *Brief check* com os passos não concluídos.
- **Peça um formato** em `output_hint`: uma tabela, itens agrupados, um sim/não com evidência.
- **Peça evidências** (`path:line`) para que o resultado possa ser conferido por amostragem.
- **Envie cedo.** Os jobs levam minutos; envie primeiro e faça depois o trabalho que não depende deles.

## Resultados medidos

Tarefa: "faça um inventário de todos os endpoints HTTP em `api/v1`: URL, métodos, requisito de autenticação, classe principal".
Projeto: 37 arquivos PHP, 140 KB.

| Medida | Resultado |
|---|---|
| Tempo do worker | 503 s |
| Tokens do worker (Gemini Flash, na cota do Google) | 192k |
| Agente principal, só o Summary | ~2k caracteres (≈ 0,5k tokens) |
| Agente principal, Summary + Findings | ~26k caracteres (≈ 6,5k tokens) |
| Ler os 37 arquivos diretamente | ≈ 40k tokens |
| Conferência por amostragem | 6 de 6 afirmações amostradas coincidiram exatamente com as linhas citadas |

Antes de o servidor colocar a lista de arquivos no prompt, uma tarefa parecida fazia o worker vagar por arquivos não relacionados (incluindo `.git`) e estourar o tempo depois de mais de 200k tokens. **O escopo é o que faz funcionar.**

## Referência de configuração

Arquivo: `OFFLOAD_CONFIG`, se definido; caso contrário, `~/.offload/config.json`.

| Chave | Padrão | Significado |
|---|---|---|
| `defaultBackend` | `agy` | Backend usado quando uma tarefa não indica nenhum |
| `maxConcurrent` | `2` | Jobs rodando ao mesmo tempo; os demais esperam na fila |
| `jobsDir` | `~/.offload/jobs` | Onde ficam os registros dos jobs e os relatórios |
| `allowedRoots` | `[]` | Diretórios extras que uma tarefa pode usar como `workspace`. O diretório de trabalho do servidor é sempre permitido |
| `summaryWords` | `200` | Limite de palavras para o Summary do worker |
| `manifestLimit` | `400` | Número máximo de arquivos no escopo listados no prompt do worker |
| `backends.<name>.command` | | Nome do executável ou caminho completo |
| `backends.<name>.args` | `[]` | Argumentos. Marcadores: `{prompt}`, `{workspace}`, `{timeoutSec}` |
| `backends.<name>.promptVia` | `arg` | `arg` coloca o prompt em `{prompt}` (ou o acrescenta ao final); `stdin` o grava no stdin |
| `backends.<name>.outputJsonPath` | | Caminho com pontos até a resposta quando a CLI imprime JSON, p. ex. `response` |
| `backends.<name>.usageJsonPath` | | Caminho com pontos até a contagem de tokens do worker, p. ex. `usage.total_tokens` |
| `backends.<name>.env` | `{}` | Variáveis de ambiente extras para o worker |
| `backends.<name>.timeoutSec` | `600` (agy) | Orçamento de tempo; o worker é encerrado 30 s depois dele, para que CLIs com limite próprio parem de forma limpa antes |

## Outros backends

Qualquer CLI que receba um prompt e imprima uma resposta pode ser um worker. Adicione-a em `backends` e depois passe `backend: "<name>"` em uma tarefa ou torne-a o `defaultBackend`. O próprio Claude Code, em modo print:

```json
"claude": {
  "command": "claude",
  "args": ["-p", "--output-format", "json"],
  "promptVia": "stdin",
  "outputJsonPath": "result",
  "timeoutSec": 900
}
```

Ao adaptar uma CLI:

1. Descubra a flag não interativa dela (`-p`, `exec`, `--print`, …) e execute um prompt manualmente.
2. Prefira uma flag de saída em JSON; defina `outputJsonPath` e também `usageJsonPath` se ela informar tokens.
3. Deixe-a somente leitura: um modo de plano ou somente leitura, uma flag de sandbox ou um agente restrito como o `offload-reader`.
4. Verifique o que acontece quando uma ferramenta precisa de aprovação no modo headless. Se a CLI retornar vazio em silêncio, restrinja as ferramentas dela como no Passo 3.
5. No Windows, um comando `.cmd`/`.bat` não consegue receber um prompt de várias linhas como argumento (o cmd.exe para na primeira quebra de linha). Use `"promptVia": "stdin"` ou aponte `command` para o `.exe`. O servidor recusa essa combinação em vez de enviar um prompt truncado.

## Solução de problemas

| Sintoma | Causa | Correção |
|---|---|---|
| `failed`: "gave no answer, often because a tool permission was denied", a saída mostra `denied_actions` | O worker tentou usar uma ferramenta que exige aprovação, geralmente um comando de terminal | Use o agente `offload-reader` (Passo 3); confira se `args` contém `--agent offload-reader` |
| `unknown agent "offload-reader"` | Arquivo do agente ausente, na pasta errada ou salvo com BOM | Coloque-o em `~/.gemini/agents/` como UTF-8 sem BOM; confira com `agy agents` |
| `--agent` com um caminho de arquivo falha | O agy recebe o **nome** de um agente, não um caminho | Instale o arquivo (Passo 3) e passe o nome |
| `failed`: backend command "agy" was not found | O PATH do editor é anterior à instalação do agy | Use o caminho completo em `command` (Passo 4) ou reinicie o editor |
| `timed_out`, ou o agy informa `print timeout … partial` | Escopo grande demais para o orçamento de tempo | Restrinja `paths` ou passe um `timeout_sec` maior |
| O worker lê arquivos não relacionados | Não há uma lista de arquivos útil no prompt | Passe `paths`; confira "N file(s) in scope" no status |
| Recusado: `.cmd/.bat` cannot receive a multi-line prompt | Limitação do cmd.exe no Windows | `"promptVia": "stdin"`, ou aponte `command` para o `.exe` |
| `--settings must be a JSON object` ao testar o agy manualmente no PowerShell 5.1 | O PowerShell remove as aspas internas de JSON inline | Grave o JSON em um arquivo e passe o caminho dele |
| Ferramentas `offload_*` ausentes no Claude Code | Servidor não registrado, ou falhou ao iniciar | `claude mcp get offload`, depois `node dist/index.js doctor` |
| O status avisa que o git status mudou durante o job | Algo gravou no workspace enquanto o job rodava | Confira `git status` / `git diff`; podem ser edições suas |
| Erros de limite de taxa ou de cota do agy | Cota do modelo no seu plano do Google | Reduza `maxConcurrent`, tente mais tarde ou adicione `--model` a `args` |

Cada job guarda seus arquivos em `~/.offload/jobs/<job_id>/`: `prompt.md` (exatamente o que o worker recebeu), `stdout.log`, `stderr.log`, `report.md` e `job.json`.

## Modelo de segurança

- **Somente leitura pela escolha de ferramentas e por contrato, não por sandbox.** O `offload-reader` tem apenas ferramentas de leitura de arquivos e o prompt proíbe escrita, mas o worker roda como o seu usuário. Para um isolamento mais forte, use o sandbox do backend (o `--sandbox` do agy exige Windows 11 24H2 ou posterior, macOS ou Linux), um contêiner ou um usuário de sistema separado.
- **Detecção de mudanças.** O `git status` é comparado antes e depois de cada job; arquivos alterados são reportados. É um esforço de melhor tentativa e não distingue as gravações do worker das suas.
- **Contenção de caminhos.** `workspace` e `paths` são resolvidos com `realpath`; os caminhos precisam ficar dentro do workspace, e o workspace precisa ser o diretório de trabalho do servidor ou estar dentro de `allowedRoots`.
- **A configuração nunca vem de um projeto.** Ela é lida somente de `OFFLOAD_CONFIG` ou do diretório pessoal, então um repositório clonado não consegue fazer o servidor executar um comando de sua escolha.
- **Sem shell.** Os workers são iniciados com um array de argumentos (via `cross-spawn`), nunca com uma string de shell.
- **A saída do worker não é confiável.** Os arquivos podem conter prompt injection. O worker é instruído a tratar o conteúdo dos arquivos como dados, as ferramentas apresentam os resultados como pistas a verificar e a skill diz ao agente principal para abrir as linhas citadas antes de agir.
- **Seus arquivos saem da sua máquina.** O worker envia o que lê ao provedor do modelo dele (o Google, no caso do agy). Não delegue trabalho sobre arquivos que você não possa compartilhar com esse provedor.

## Perguntas frequentes

<details>
<summary><b>Por que não usar simplesmente os subagentes do Claude Code?</b></summary>

Os subagentes rodam no mesmo provedor de modelo e na mesma cota do agente principal, então a leitura continua custando tokens do Claude. O offload move a leitura para a cota de outro provedor, aqui o seu plano do Google, e devolve apenas o resultado.
</details>

<details>
<summary><b>Isso economiza dinheiro?</b></summary>

Ele move a leitura para a cota do worker e reduz o que o agente principal lê, muitas vezes em uma ordem de grandeza em tarefas de inventário. O próprio worker pode usar muitos tokens (192k no exemplo acima), então se isso sai "mais barato" depende dos seus planos nos dois lados.
</details>

<details>
<summary><b>O worker pode editar meus arquivos?</b></summary>

O agente `offload-reader` não tem ferramentas de edição nem de terminal, e o prompt proíbe alterações. Ainda assim, o worker roda como o seu usuário, então trate isso como uma convenção forte, não como um sandbox. O servidor avisa se o `git status` mudar durante um job.
</details>

<details>
<summary><b>Por que é lento?</b></summary>

O worker lê cada arquivo relevante por inteiro, uma chamada de ferramenta por vez; 37 arquivos levaram cerca de oito minutos. Envie cedo e continue trabalhando. `paths` mais restritos deixam tudo mais rápido.
</details>

<details>
<summary><b>Posso usar a Gemini CLI no lugar?</b></summary>

O Google migrou as contas individuais para a Antigravity CLI, então este projeto tem o `agy` como alvo. Qualquer CLI com modo não interativo funciona como backend; veja [Outros backends](#outros-backends).
</details>

<details>
<summary><b>Quais plataformas são suportadas?</b></summary>

O servidor é Node.js puro e roda no Windows, macOS e Linux. A configuração completa foi testada no Windows 10. O cancelamento da árvore de processos usa `taskkill` no Windows e grupos de processos nos demais.
</details>

<details>
<summary><b>Quais clientes MCP funcionam?</b></summary>

Qualquer cliente que inicie servidores MCP via stdio. As instruções de configuração aqui são para o Claude Code; o arquivo da skill é específico do Claude Code, as ferramentas não.
</details>

## Desenvolvimento

```bash
npm run build
npm run smoke
npm test
npm run doctor
npm run try -- <workspace> "<task>" [path ...]
npx @modelcontextprotocol/inspector node dist/index.js
```

O `npm test` compila, executa o smoke test e verifica se cada README traduzido mantém os blocos de código deste. O worker simulado (`scripts/mock-agent.mjs`) reage a marcadores na tarefa: `SLOW_MODE` dorme 60 s, `BAD_FORMAT` ignora o formato do relatório, `WRITE_FILE` grava no workspace.

### Estrutura do projeto

```text
src/
  index.ts      ponto de entrada: servidor MCP via stdio, ou `doctor`
  config.ts     esquema de configuração, padrões, backend agy embutido
  tools.ts      as quatro ferramentas MCP, verificação de caminhos, formatação do status
  jobs.ts       fila, criação de processos, timeouts, cancelamento, interpretação de resultados, detecção de mudanças
  manifest.ts   arquivos no escopo (git ls-files ou varredura de diretório)
  report.ts     prompt do worker, interpretação do relatório, extração de JSON, remoção de links
  doctor.ts     verificações de configuração
agents/offload-reader.md     agente worker somente leitura para o agy
skills/offload/SKILL.md      skill do Claude Code: quando e como delegar
scripts/smoke.ts             teste de ponta a ponta contra o worker simulado
scripts/mock-agent.mjs       worker de teste
scripts/try.ts               executa uma tarefa real pelo servidor
scripts/check-readmes.mjs    mantém os READMEs traduzidos sincronizados
docs/readme/                 READMEs traduzidos
```

## Roadmap

- Comando de instalação via `npx` que instala o agente, a configuração, o registro do MCP e a skill em uma única etapa
- Pacote npm
- Uma ferramenta de busca para o worker agy quando agentes personalizados em modo headless puderem usar uma
- Receitas testadas para mais CLIs de worker
- Seleção de modelo por tarefa

## Contribuindo

Issues e pull requests são bem-vindos. Execute `npm test` antes de abrir um pull request. Ao alterar este README, atualize as traduções em `docs/readme/` ou abra uma issue para que elas possam ser atualizadas; a verificação do README falha se os blocos de código de uma tradução divergirem deste arquivo.

## Licença

[MIT](../../LICENSE)
