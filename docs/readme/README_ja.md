<div align="center">

[English](../../README.md) · [简体中文](README_zh.md) · [繁體中文](README_zh-TW.md) · **日本語** · [한국어](README_ko.md) · [Tiếng Việt](README_vi.md) · [Español](README_es.md) · [Français](README_fr.md) · [Deutsch](README_de.md) · [Português (Brasil)](README_pt-BR.md) · [Русский](README_ru.md)

# offload-mcp-server

### 重い読み込み作業はサブのエージェントに任せ、メインのコーディングエージェントは答えだけを読む。

**Claude Code が依頼し、Antigravity CLI が 37 ファイルを読み、Claude が読むのは 500 トークン。**

[![npm](https://img.shields.io/npm/v/offload-mcp-server?style=flat-square&color=cb3837&logo=npm)](https://www.npmjs.com/package/offload-mcp-server)
[![MIT license](https://img.shields.io/badge/license-MIT-f4c430?style=flat-square)](../../LICENSE)
[![Node.js 20.3+](https://img.shields.io/badge/Node.js-20.3%2B-339933?style=flat-square&logo=nodedotjs&logoColor=white)](#要件)
[![MCP server](https://img.shields.io/badge/MCP-stdio_server-5c4ee5?style=flat-square)](#ツール)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)](../../src)
[![Worker: Antigravity CLI](https://img.shields.io/badge/worker-Antigravity_CLI-4285f4?style=flat-square)](#ステップ-2-antigravity-cli-のインストールとサインイン)
[![GitHub stars](https://img.shields.io/github/stars/tailucanh/offload-mcp-server?style=flat-square)](https://github.com/tailucanh/offload-mcp-server/stargazers)

[クイックスタート](#クイックスタート) · [仕組み](#仕組み) · [オフロードの対象](#オフロードの対象) · [セットアップ](#セットアップ手順) · [計測結果](#計測結果) · [トラブルシューティング](#トラブルシューティング) · [FAQ](#faq) · [セキュリティ](#セキュリティモデル)

<code>npx -y offload-mcp-server setup</code>

<img src="../assets/demo.svg" alt="Claude Code hands an endpoint inventory to the Antigravity CLI through offload-mcp-server and reads back a 0.5k-token summary" width="860">

</div>

> [!IMPORTANT]
> 公式のソースは [github.com/tailucanh/offload-mcp-server](https://github.com/tailucanh/offload-mcp-server) です。
> npm パッケージは [`offload-mcp-server`](https://www.npmjs.com/package/offload-mcp-server) です。似た名前のパッケージやリポジトリは本プロジェクトではありません。

---

コーディングエージェントはコンテキストの大半を**読み込み**に費やします。ソースツリーをたどり、ログを走査し、
minify されたバンドルを開いて関数をひとつ探す、といった具合です。答えが一段落で済むのに、読み込みに
4 万トークンもかかるのは割に合いません。

**offload-mcp-server** は小さな MCP サーバーで、メインのエージェントに 4 つのツールを提供します。これらを使って、
その読み込み作業を**バックグラウンドで動くもうひとつのエージェント CLI** に任せます。デフォルトでは Google の
Antigravity CLI (`agy`) と、読み取り専用のワーカーエージェントを使います。ワーカーは自分のクォータでファイルを読み、
決まった形式のレポートを書き出します。メインのエージェントが読むのは **Summary** (数百語) だけで、
`path:line` の根拠が付いた **Findings** は必要なときにだけ取得します。

- **非同期。** ジョブを投入したら作業を続け、あとで結果を受け取ります。複数のジョブを並列に実行できます。
- **設計上、読み取り専用。** ワーカーエージェントはファイル読み取りツールしか持たず、ジョブの実行中に
  `git status` が変化したファイルがあれば、サーバーがそれを報告します。
- **スコープ限定。** サーバーが対象ファイルの一覧 (`git ls-files`) をワーカーに渡すので、ワーカーが無関係なファイルを
  読み回ることはありません。
- **バックエンド非依存。** プロンプトを受け取って回答を出力する CLI なら何でもワーカーにできます。`claude -p` も使えます。
- **計測可能。** 各ジョブはワーカーのトークン数を記録し、`npm run try` でメインのエージェントが実際に読んだ量を確認できます。
- **ライブで確認できる。** `npx -y offload-mcp-server dashboard` でローカルのページが開き、すべてのジョブをリアルタイムに表示します。ワーカーが開いたファイル、カバレッジ、ブリーフ、レポートが見られます。

## クイックスタート

Node.js 20.3+、インストールしてサインイン済みの [Antigravity CLI](#ステップ-2-antigravity-cli-のインストールとサインイン)、Claude Code（または他の MCP クライアント）が必要です。次に実行します:

```bash
npx -y offload-mcp-server setup
```

`setup` は Antigravity CLI を探し、読み取り専用のワーカーエージェント（`~/.gemini/agents/`）と Claude Code のスキル（`~/.claude/skills/offload/`）をインストールし、`~/.offload/config.json` がなければ作成して、サーバーを Claude Code に登録します。更新後に再実行しても安全です。変更されたファイルは先に `.bak` として保存されます。`--dry-run` を付けると、何をするかを確認できます。

新しい Claude Code セッションを開始（またはエディタのウィンドウを再読み込み）して、次のように頼みます:

```text
これをオフロードして: api/ 配下のすべての HTTP エンドポイントについて、メソッドと認証チェックを一覧にし、
そのあとで summary を見せて。
```

開発用にクローンから実行する場合:

```bash
git clone https://github.com/tailucanh/offload-mcp-server.git
cd offload-mcp-server
npm install
npm run build
node dist/index.js setup
```

[セットアップ手順](#セットアップ手順) で各部分と手動での手順を説明しています。

## 仕組み

```mermaid
sequenceDiagram
    autonumber
    participant M as メインエージェント (Claude Code)
    participant S as offload-mcp-server
    participant W as ワーカー (agy + offload-reader)
    M->>S: offload_submit_task(task, steps, output_hint, done_when, paths)
    S->>S: パスを検証し、対象ファイルを列挙 (git ls-files)、プロンプトを構築
    S-->>M: job_id (即座に返す)
    S->>W: バックグラウンドで起動
    Note over M: 別の作業を続ける
    W->>W: read_file … (列挙されたファイルのみ)
    W-->>S: レポート: Summary / Findings / Uncertain / Files read
    S->>S: file:// リンクを除去し、セクションを解析、トークンを記録、git status を比較
    M->>S: offload_get_status(job_id, wait_sec=50)
    S-->>M: ステータス + Summary (数百語)
    opt Summary だけでは足りない場合のみ
        M->>S: offload_get_result(job_id, part="findings")
        S-->>M: path:line の根拠付き Findings
    end
    Note over M: 作業に移る前に、引用された行を抜き取り確認する
```

1. **投入。** サーバーは `workspace` と `paths` を `realpath` で解決し、ワークスペース外のものは拒否し、
   対象ファイルを列挙してジョブをキューに入れます。
2. **実行。** 最大 `maxConcurrent` 個のワーカーが同時に動き、それぞれワークスペース内で実行されます。出力は
   `~/.offload/jobs/<job_id>/` に保存されます。
3. **解析。** ワーカーが終了すると、サーバーは回答を取り出し、`file://` リンク (トークンを消費するだけで
   価値がありません) を除去し、レポートをセクションに分割し、ワーカーのトークン数を記録します。
4. **回収。** `offload_get_status` は 1 回の呼び出しで最大 50 秒待ちます。多くの MCP クライアントの
   1 回あたり約 60 秒という制限を下回る値です。完了したステータスには、すでに Summary が含まれています。

## オフロードの対象

| オフロードする | 自分でやる |
|---|---|
| ツリー全体にわたる一覧化: すべてのエンドポイント、設定キー、権限チェック、呼び出し箇所 | あらゆる編集: ワーカーは読み取り専用です |
| 大きなファイルや生成ファイル: minify されたバンドル、リソースパック、ロックファイル、長いログ、データダンプ | 1〜2 回の読み込みか grep 1 回で答えられる調べ物 |
| 「この 30 ファイルのうち X に関係するのはどれか」 | 急ぎの用件: ジョブには数分かかります |
| コーディングを続けながら並列で進められる調査 | どのみち 1 行ずつ自分で検証が必要なセキュリティ上の結論 |

**目安:** 必要な答えよりも読み込む量が 10 倍以上大きいときにオフロードします。

## ツール

| ツール | 入力 | 戻り値 |
|---|---|---|
| `offload_submit_task` | `task`, `steps`, `output_hint`, `done_when` (4 つとも必須); `context`, `exclude`, `paths`, `workspace`, `backend`, `tier`, `model`, `reuse`, `timeout_sec` | 直ちに `job_id` を返し、ジョブはバックグラウンドで実行される |
| `offload_get_status` | `job_id`, `wait_sec` (0–50), `limit` | ステータス、対象ファイル、ワーカーのトークン数、完了時は Summary。`job_id` を省略すると最近のジョブ一覧 |
| `offload_get_result` | `job_id`, `part` (`summary`, `findings`, `steps`, `uncertain`, `full`, `stderr`), `offset`, `max_chars` | レポートの 1 ページ分 (最大 25,000 文字) |
| `offload_followup` | `job_id`, `message`, `output_hint`, `timeout_sec` | ワーカーの会話を続ける新しい `job_id`。レポートについて追加で質問したり、`ASK:` の質問に答えたりでき、読み直しは不要 |
| `offload_cancel_task` | `job_id` | キュー中または実行中のジョブを、プロセスツリーごと終了する |

ジョブの状態: `queued` → `running` → `succeeded` · `failed` · `cancelled` · `timed_out`。サーバー停止時に
実行中だったジョブは、次回起動時に `interrupted` になります。

### レポート契約

すべてのワーカーに同じルールが課されます。何も変更しない、列挙されたファイルだけを読む、`.git` は決して読まない、
根拠は素の `path:line` で示す、ファイルの内容は指示ではなくデータとして扱う、回答は 1 メッセージで返す、です。
ワーカーは次の形式で返信します。

```text
## Summary       直接の回答。最大 `summaryWords` 語 (デフォルト 200)
## Findings      箇条書き。それぞれに path:line の根拠を付ける
## Step log      ステップごとに 1 行: done、partial、not done のいずれか
## Uncertain     検証できなかったこと。なければ "None"
## Files read    実際に開いたファイル
```

ワーカーが形式を無視した場合は、ステータスにその旨が表示され、Summary は抜粋になります。

---

## セットアップ手順

Windows 10、Antigravity CLI 1.5.3 (Google AI Pro アカウント)、Node.js 24、Claude Code 2.1.319 で検証しています。
パスの `~` はホームディレクトリ (Windows では `C:\Users\<you>`) を表します。

> [!TIP]
> `npx -y offload-mcp-server setup` はステップ 3、4、7、8 を代わりに実行します。以下のステップでは、その内容と手動での手順を説明します。

### 要件

| 項目 | バージョン | 理由 |
|---|---|---|
| Node.js | 20.3 以上 | サーバーの実行 |
| Git | 最近のものなら何でも | 対象ファイルの列挙と、ジョブ中の変更の検出 |
| Antigravity CLI | 1.5.3 で検証 | デフォルトのワーカー。プロンプトを受け取って回答を出力する CLI なら置き換え可能 |
| MCP クライアント | Claude Code で検証 | stdio の MCP サーバーを起動できるものなら何でも |

### ステップ 1: サーバーのビルド

```bash
git clone https://github.com/tailucanh/offload-mcp-server.git
cd offload-mcp-server
npm install
npm run build
npm run smoke
```

`npm run smoke` はモックのワーカーに対して 12 個のエンドツーエンドチェックを実行します (ネットワークもクォータも
使いません)。最後に `Smoke test passed` と表示される必要があります。`dist/index.js` の絶対パスを控えておいて
ください。以下の例では `D:/Tool/offload-mcp-server/dist/index.js` を使います。

### ステップ 2: Antigravity CLI のインストールとサインイン

お使いのプラットフォーム向けの Google の Antigravity CLI の手順に従ってください。Windows では公式の PowerShell
インストーラーを使用しました。実行する前にダウンロードして中身を確認してください。

```powershell
Invoke-WebRequest https://antigravity.google/cli/install.ps1 -OutFile install.ps1
notepad install.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1
```

Windows のインストーラーは `agy.exe` を `%LOCALAPPDATA%\agy\bin` に配置し、SHA-512 チェックサムを検証して、
PATH に追加します。その後、**新しいターミナルで**次を実行します。

```bash
agy --version
agy
```

最初の対話実行でブラウザが開き、Google アカウントでサインインします。サインイン後は `/quit` で終了します。
初回起動時、Windows Defender が `agy.exe` を数分間隔離することがあります。少し待ってからやり直してください。

### ステップ 3: 読み取り専用ワーカーエージェントのインストール

[`agents/offload-reader.md`](../../agents/offload-reader.md) を `~/.gemini/agents/` にコピーします。

Windows (PowerShell):

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.gemini\agents" | Out-Null
Copy-Item agents\offload-reader.md "$env:USERPROFILE\.gemini\agents\"
```

macOS / Linux:

```bash
mkdir -p ~/.gemini/agents && cp agents/offload-reader.md ~/.gemini/agents/
```

agy から認識されていることを確認します。出力に `offload-reader` が含まれている必要があります。

```bash
agy agents
```

> [!WARNING]
> エージェントファイルは **BOM なしの UTF-8** で保存してください。BOM があると、agy はそのエージェントを無視し、
> `unknown agent` と報告します。Windows PowerShell 5.1 の `Set-Content -Encoding utf8` は BOM を書き込むので、
> 代わりにエディターを使ってください。

**なぜカスタムエージェントなのか。** ヘッドレスモード (`agy -p`) では、agy は許可を求めることができません。デフォルトの
エージェントは最初に `ls` などのターミナルコマンドを実行しがちで、そのコマンドは自動的に拒否され、実行は
**空の回答と終了コード 0** で終わります。`offload-reader` はファイルツールだけを宣言しているので、ターミナルに
手を伸ばすことがなく、ファイルを編集する手段もありません。

### ステップ 4: 設定ファイルの作成

[`offload.config.example.json`](../../offload.config.example.json) をひな形にして、`~/.offload/config.json` を作成します。

```json
{
  "defaultBackend": "agy",
  "maxConcurrent": 2,
  "summaryWords": 200,
  "backends": {
    "agy": {
      "command": "C:/Users/<you>/AppData/Local/agy/bin/agy.exe",
      "args": ["--agent", "offload-reader", "--output-format", "stream-json", "--disable-slash-commands", "--print-timeout", "{timeoutSec}s", "-p", "{prompt}"],
      "promptVia": "arg",
      "streamFormat": "agy",
      "resumeArgs": ["--conversation", "{conversationId}"],
      "modelArgs": ["--model", "{model}"],
      "tiers": { "low": "gemini-3.8-flash-low", "medium": "gemini-3.8-flash-medium", "high": "gemini-3.8-flash-high" },
      "timeoutSec": 600
    }
  }
}
```

> [!TIP]
> `command` には `agy` への**フルパス**を指定してください。MCP サーバーは、それを起動したエディターの PATH を
> 引き継ぎます。agy をインストールする前から開いていたエディターには、新しい PATH エントリが見えません。

設定ファイルがない場合は、組み込みの `agy` バックエンドが同じ引数と `command: "agy"` で使われます。
設定は `OFFLOAD_CONFIG` または `~/.offload/config.json` からのみ読み込まれ、プロジェクトのフォルダーからは
決して読み込まれません。

### ステップ 5: セットアップの確認

```bash
node D:/Tool/offload-mcp-server/dist/index.js doctor
```

`doctor` は、使用中の設定、各バックエンドのコマンドが見つかったかどうか、デフォルトバックエンドの `--help` の
冒頭数行を出力します。何かが不足していれば終了コード 1 で終了します。

### ステップ 6: MCP クライアントなしで実タスクを試す

`npm run try` は、ビルド済みのサーバーを、実際の設定を使って MCP クライアントとまったく同じように動かします。

```bash
npm run try -- "/path/to/your/project" "List every HTTP endpoint with its method and auth check" src/api
```

ステータスと Summary、続いて Findings、そしてメインのエージェントが読むことになる文字数を出力します。数分かかります。

### ステップ 7: Claude Code にサーバーを登録

すべてのプロジェクトで使う場合 (ユーザースコープ):

```bash
claude mcp add --scope user offload -- node D:/Tool/offload-mcp-server/dist/index.js
claude mcp get offload
```

`claude mcp get offload` が `Status: Connected` と報告するはずです。

`claude` が PATH にない場合 (たとえば VS Code 拡張機能だけを使っている場合) は、拡張機能に CLI が同梱されています。
Windows では
`~/.vscode/extensions/anthropic.claude-code-<version>-win32-x64/resources/native-binary/claude.exe`
にあり、Antigravity IDE の場合は `~/.antigravity/extensions/` 配下です。同じコマンドをそのパスで実行してください。

1 つのプロジェクトだけで使う場合は、代わりにプロジェクトのルートに `.mcp.json` を追加します。

```json
{
  "mcpServers": {
    "offload": { "command": "node", "args": ["D:/Tool/offload-mcp-server/dist/index.js"] }
  }
}
```

サーバーは、自身の作業ディレクトリ (クライアントが開いているプロジェクト) をデフォルトのワークスペースとして使います。
ほかの MCP クライアントでは、stdio 経由で `node /path/to/dist/index.js` を起動してください。

### ステップ 8: スキルのインストール

スキルは、オフロードが有効な場面と、ツールの使い方を Claude に伝えます。

Windows (PowerShell):

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.claude\skills\offload" | Out-Null
Copy-Item skills\offload\SKILL.md "$env:USERPROFILE\.claude\skills\offload\"
```

macOS / Linux:

```bash
mkdir -p ~/.claude/skills/offload && cp skills/offload/SKILL.md ~/.claude/skills/offload/
```

### ステップ 9: 再起動と動作確認

新しい Claude Code セッションを開始し (エディターではウィンドウを再読み込みし)、`/mcp` を実行します。`offload` が
4 つのツールとともに接続されているはずです。そのうえで、実際のタスクを与えてみましょう。

```text
これをオフロードして: api/v1 配下の各エンドポイントについて、URL、HTTP メソッド、認証要件、
主に使われているクラスを一覧にして。フォルダーごとにまとめ、path:line を引用して。
```

---

## 使いこなすために

### 典型的なやり取り

1. メインのエージェントが、的確な `task`、絞り込んだ `paths`、そして
   `table: endpoint | method | auth | file:line` のような `output_hint` を付けて `offload_submit_task` を呼びます。
2. 作業を続けながら、ジョブが完了するまで `wait_sec: 50` で `offload_get_status` を呼びます。
3. Summary を読みます。それで足りないときだけ、`part: "findings"` で `offload_get_result` を呼びます。
4. 結果に基づいて動く前に、引用された行を 2〜3 か所開いて確認します。

### よいタスクの書き方

- **終わりが明確な、具体的な質問をひとつ。** 「API を見て」ではなく、「X をすべて、Y と Z とともに列挙して」のように。
- **`paths` は絞る。** ワーカーは列挙されたファイルだけを読むので、スコープが時間とコストの両方を決めます。
- **完全なブリーフを書く。** `steps`（順序付きの具体的な操作）、`output_hint`、`done_when` は必須、`context`（既に分かっていること）と `exclude` は任意です。ワーカーはそのステップだけを実行して他のことはせず、各ステップを done / partial / not done で記録します。ステータスの *Brief check* 行に未完了のステップが表示されます。
- **ステータスを読み、追加で質問する。** ジョブの実行中、ステータスにはワーカーの最新のツール呼び出しが表示されます。終了すると *Coverage* にワーカーが開かなかった範囲内のファイルが並び、最後の `ASK:` 行はあなたへの質問になります。追加の質問は `offload_followup` で行います。ワーカーは読んだ内容を保持しています。機械的な棚卸しには `tier: "low"`、難しい読解には `"high"` を使います。完了済みジョブと同じ brief で、ファイルが変わっていなければそのジョブを返します（`reuse: false` で再実行）。
- **`output_hint` で形を指定する。** 表、グループ化した箇条書き、根拠付きの yes/no など。
- **根拠 (`path:line`) を求める。** 結果を抜き取りで検証できるようにします。
- **早めに投入する。** ジョブには数分かかります。先に投入して、ジョブに依存しない作業を進めましょう。

### ダッシュボードでジョブを確認する

```bash
npx -y offload-mcp-server dashboard
```

このコマンドは、すべてのセッションのジョブを表示するローカルの Web ページを開きます。状態と経過時間、ワーカーが開いた各ファイル (その場で表示)、スコープ内ファイルのカバレッジ、ワーカーからの質問、警告、ワーカーが受け取ったブリーフ、整形済みのレポートが表示され、各 `path:line` は VS Code で開けます。実行中のジョブはページから取り消せます。設定に `"dashboard": { "autoOpen": true }` を入れると最初のジョブと同時にダッシュボードが起動し、送信結果でそのリンクが Claude に渡され、あなたに伝えられます。 ページはこの README と同じ 11 言語に対応しています。ブラウザーの言語に合わせて表示され、ヘッダーの選択欄で切り替えられます。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/dashboard-dark.png">
  <img src="../assets/dashboard-light.png" alt="offload ダッシュボード: 左にジョブ一覧、右に実行中のジョブとカバレッジバー、ワーカーが開くファイルのライブタイムライン" width="860">
</picture>

## 計測結果

タスク: 「`api/v1` 配下のすべての HTTP エンドポイントを一覧化する: URL、メソッド、認証要件、主なクラス」。
プロジェクト: PHP ファイル 37 個、140 KB。

| 指標 | 結果 |
|---|---|
| ワーカーの所要時間 | 503 秒 |
| ワーカーのトークン数 (Gemini Flash、Google のクォータ) | 192k |
| メインエージェント、Summary のみ | 約 2k 文字 (≈ 0.5k トークン) |
| メインエージェント、Summary + Findings | 約 26k 文字 (≈ 6.5k トークン) |
| 37 ファイルを直接読む場合 | ≈ 40k トークン |
| 抜き取り確認 | 抽出した 6 件の主張すべてが、引用された行と完全に一致 |

サーバーがファイル一覧をプロンプトに入れるようになる前は、同様のタスクでワーカーが無関係なファイル (`.git` を含む)
を読み回り、200k トークン超を使ってタイムアウトしました。**スコープこそが、これを機能させる鍵です。**

## 設定リファレンス

ファイル: `OFFLOAD_CONFIG` が設定されていればそれ、なければ `~/.offload/config.json`。

| キー | デフォルト | 意味 |
|---|---|---|
| `defaultBackend` | `agy` | タスクでバックエンドが指定されないときに使うバックエンド |
| `maxConcurrent` | `2` | 同時に実行するジョブ数。残りはキューで待機する |
| `jobsDir` | `~/.offload/jobs` | ジョブの記録とレポートの保存先 |
| `allowedRoots` | `[]` | タスクが `workspace` として使える追加のディレクトリ。サーバーの作業ディレクトリは常に許可される |
| `summaryWords` | `200` | ワーカーの Summary の語数上限 |
| `manifestLimit` | `400` | ワーカーのプロンプトに列挙する対象ファイルの最大数 |
| `scopeWarnKB` | `600` | 範囲内のファイルがこのサイズ（KB）を超えると、送信時に警告する |
| `dashboard.port` | `7431` | `offload-mcp-server dashboard` のポート (使用中なら次の空きポート) |
| `dashboard.autoOpen` | `false` | ジョブの送信時にダッシュボードを起動してブラウザを開く |
| `backends.<name>.command` | | 実行ファイル名またはフルパス |
| `backends.<name>.args` | `[]` | 引数。プレースホルダー: `{prompt}`, `{workspace}`, `{timeoutSec}` |
| `backends.<name>.promptVia` | `arg` | `arg` はプロンプトを `{prompt}` の位置に置く (なければ末尾に追加)。`stdin` は標準入力に書き込む |
| `backends.<name>.outputJsonPath` | | CLI が JSON を出力する場合の、回答へのドットパス。例: `response` |
| `backends.<name>.usageJsonPath` | | ワーカーのトークン数へのドットパス。例: `usage.total_tokens` |
| `backends.<name>.env` | `{}` | ワーカーに渡す追加の環境変数 |
| `backends.<name>.timeoutSec` | `600` (agy) | 時間の上限。ワーカーはその 30 秒後に強制終了されるので、独自の制限を持つ CLI は先にきれいに停止する |
| `backends.<name>.streamFormat` | `agy` (agy) | `agy`: Antigravity CLI の stream-json を読み、進捗、カバレッジ、会話 ID を得る |
| `backends.<name>.resumeArgs` | `--conversation {conversationId}` (agy) | `offload_followup` のために追加される引数 |
| `backends.<name>.modelArgs` | `--model {model}` (agy) | ジョブが `tier` か `model` を選んだときに追加される引数 |
| `backends.<name>.tiers` | `setup` が設定 | `tier` 用のモデル ID: `low`、`medium`、`high` |
| `backends.<name>.stallSec` | `300` | ストリーム型バックエンド: この時間イベントがなければジョブを止める（`0` = 止めない） |

## 他のバックエンド

プロンプトを受け取って回答を出力する CLI なら、何でもワーカーにできます。`backends` の下に追加し、タスクで
`backend: "<name>"` を渡すか、`defaultBackend` にしてください。Claude Code 自体をプリントモードで使う例:

```json
"claude": {
  "command": "claude",
  "args": ["-p", "--output-format", "json"],
  "promptVia": "stdin",
  "outputJsonPath": "result",
  "timeoutSec": 900
}
```

CLI を適合させるときは次の手順で進めます。

1. 非対話のフラグ (`-p`, `exec`, `--print` など) を見つけ、プロンプトを 1 つ手動で実行してみる。
2. JSON 出力のフラグを優先する。`outputJsonPath` を設定し、トークン数を報告する場合は `usageJsonPath` も設定する。
3. 読み取り専用にする。プランモードや読み取り専用モード、サンドボックスのフラグ、または `offload-reader` のような制限付きエージェントを使う。
4. ヘッドレスモードでツールが承認を必要としたときの挙動を確認する。CLI が何も返さずに終わる場合は、
   ステップ 3 のようにツールを制限する。
5. Windows では、`.cmd`/`.bat` のコマンドは複数行のプロンプトを引数として受け取れません (cmd.exe は最初の
   改行で止まります)。`"promptVia": "stdin"` を使うか、`command` を `.exe` に向けてください。サーバーは、
   切り詰められたプロンプトを送る代わりに、この組み合わせを拒否します。

## トラブルシューティング

| 症状 | 原因 | 対処 |
|---|---|---|
| `failed`: "gave no answer, often because a tool permission was denied"、出力に `denied_actions` が表示される | ワーカーが承認を必要とするツール (多くはターミナルコマンド) を使おうとした | `offload-reader` エージェントを使う (ステップ 3)。`args` に `--agent offload-reader` が含まれているか確認する |
| `unknown agent "offload-reader"` | エージェントファイルがない、置き場所が違う、または BOM 付きで保存されている | BOM なしの UTF-8 で `~/.gemini/agents/` に置く。`agy agents` で確認する |
| `--agent` にファイルパスを渡すと失敗する | agy が受け取るのはパスではなくエージェントの**名前** | ファイルをインストールし (ステップ 3)、名前を渡す |
| `failed`: backend command "agy" was not found | エディターの PATH が agy のインストールより前のもの | `command` にフルパスを指定する (ステップ 4)、またはエディターを再起動する |
| `timed_out`、または agy が `print timeout … partial` を報告する | 時間の上限に対してスコープが大きすぎる | `paths` を絞るか、`timeout_sec` を大きくする |
| ワーカーが無関係なファイルを読む | プロンプトに有用なファイル一覧がない | `paths` を渡す。ステータスの "N file(s) in scope" を確認する |
| 拒否される: `.cmd/.bat` cannot receive a multi-line prompt | Windows の cmd.exe の制限 | `"promptVia": "stdin"` にするか、`command` を `.exe` に向ける |
| PowerShell 5.1 で agy を手動テストすると `--settings must be a JSON object` になる | PowerShell がインライン JSON 内の引用符を取り除く | JSON をファイルに書き、そのパスを渡す |
| Claude Code に `offload_*` ツールが表示されない | サーバーが登録されていないか、起動に失敗した | `claude mcp get offload` を実行し、続けて `node dist/index.js doctor` を実行する |
| ジョブ中に git status が変化したという警告がステータスに出る | ジョブの実行中に何かがワークスペースへ書き込んだ | `git status` / `git diff` を確認する。自分の編集かもしれない |
| `timed_out`: "the worker sent no event for N s" | ワーカーが止まっている。ヘッドレスではできないことを待っていることが多い | タスクを絞り、`part: "stderr"` を読む。本当に遅い作業のときだけ `stallSec` を上げる |
| `failed`: "quota or rate limit was reached" | ワーカーのプランのクォータが尽きた | 止めて後で再試行する。従量課金の Google Cloud アカウントには日次上限がない |
| "nested delegation is refused" | サーバーが offload のワーカー内で動いている（`OFFLOAD_CHILD=1`） | 想定どおり: ワーカーは自分で読む |
| agy からレート制限やクォータのエラーが返る | Google のプランのモデルクォータ | `maxConcurrent` を下げる、時間をおいて再試行する、または `args` に `--model` を追加する |

各ジョブのファイルは `~/.offload/jobs/<job_id>/` に保存されます。`prompt.md` (ワーカーが受け取った内容そのまま)、
`stdout.log`、`stderr.log`、`report.md`、`job.json` です。

## セキュリティモデル

- **読み取り専用は、サンドボックスではなくツールの選択と契約で実現している。** `offload-reader` はファイル読み取り
  ツールしか持たず、プロンプトも書き込みを禁じていますが、ワーカーはあなたのユーザー権限で動きます。より強い
  分離が必要なら、バックエンドのサンドボックス (agy の `--sandbox` は Windows 11 24H2 以降、macOS、Linux が必要)、
  コンテナー、または別の OS ユーザーを使ってください。
- **変更の検出。** 各ジョブの前後で `git status` を比較し、変更されたファイルを報告します。これはベストエフォートで、
  ワーカーによる書き込みとあなた自身の書き込みを区別することはできません。
- **パスの封じ込め。** `workspace` と `paths` は `realpath` で解決されます。パスはワークスペース内に収まる必要があり、
  ワークスペースはサーバーの作業ディレクトリか `allowedRoots` の内側でなければなりません。
- **設定がプロジェクトから読み込まれることはない。** 設定は `OFFLOAD_CONFIG` またはホームディレクトリからのみ読み込まれる
  ので、クローンしたリポジトリがサーバーに任意のコマンドを実行させることはできません。
- **シェルを使わない。** ワーカーは (`cross-spawn` を介して) 引数の配列で起動され、シェルの文字列は使いません。
- **レポートの衛生。** API キーや秘密鍵に見える値は先頭 6 文字だけ残して伏せ、指示のように読める文（"ignore previous instructions"、シェルへパイプするコマンド）はステータスで警告します。ワーカーは `OFFLOAD_CHILD=1` で動くため、さらに委任することはできません。agy はどのエージェントでも `init` イベントに約 60 個のツールを並べますが、テストでは `offload-reader` はファイル読み取りツールしか使わず、頼まれてもファイルを書きませんでした。
- **ワーカーの出力は信頼しない。** ファイルにはプロンプトインジェクションが含まれている可能性があります。ワーカーには
  ファイルの内容をデータとして扱うよう指示し、ツールは結果を検証すべき手がかりとして提示し、スキルはメインのエージェントに
  行動する前に引用された行を開くよう指示します。
- **ファイルはあなたのマシンの外へ出る。** ワーカーは読んだ内容をそのモデルプロバイダー (agy の場合は Google) に送信します。
  そのプロバイダーと共有してはならないファイルに対して、オフロードを行わないでください。
- **ダッシュボードはローカル限定。** 127.0.0.1 でのみ待ち受け、表示されたリンクのランダムなトークン (`SameSite=Strict` の cookie に保存) が必要です。別の `Host` ヘッダーのリクエストは拒否され、取り消しにはページ自身の `Origin` と独自ヘッダーも必要なため、他の Web サイトからジョブを読んだり取り消したりはできません。

## FAQ

<details>
<summary><b>Claude Code のサブエージェントでは駄目なのですか。</b></summary>

サブエージェントはメインのエージェントと同じモデルプロバイダーとクォータで動くので、読み込みには依然として
Claude のトークンがかかります。offload は読み込みを別のプロバイダーのクォータ (ここではあなたの Google プラン) に移し、
結果だけを返します。
</details>

<details>
<summary><b>Claude にシェルから <code>agy -p</code> を直接実行させればよいのでは？</b></summary>

それでも動きますし、このプロジェクトもそこから始まりました。サーバーは素のシェル呼び出しにないものを加えます。Claude のコンテキストに入るのは出力全体ではなく Summary だけ、権限拒否による空の回答は失敗として報告、ワーカーには範囲内のファイル一覧を渡すので迷わない、ジョブはタイムアウト、停止検知、プロセスツリーごとのキャンセル付きでバックグラウンド並列実行、brief は必須でチェックされる（step log、カバレッジ）、追加の質問はワーカーの会話を再利用します。
</details>

<details>
<summary><b>お金の節約になりますか。</b></summary>

読み込みをワーカーのクォータに移し、メインのエージェントが読む量を減らします。一覧化のようなタスクでは、桁がひとつ
変わることも珍しくありません。ただしワーカー自身は多くのトークンを使うことがある (上の例では 192k) ので、
「安くなる」かどうかは、両側のプラン次第です。
</details>

<details>
<summary><b>ワーカーは私のファイルを編集できますか。</b></summary>

`offload-reader` エージェントには編集ツールもターミナルツールもなく、プロンプトも変更を禁じています。ただしワーカーは
あなたのユーザー権限で動くので、サンドボックスではなく強い取り決めと考えてください。ジョブ中に `git status` が変化すると、
サーバーが警告します。
</details>

<details>
<summary><b>なぜ遅いのですか。</b></summary>

ワーカーは関連するすべてのファイルを、ツール呼び出しを 1 回ずつ行いながら全文読みます。37 ファイルで約 8 分かかりました。
早めに投入して作業を続けてください。`paths` を絞れば速くなります。
</details>

<details>
<summary><b>代わりに Gemini CLI を使えますか。</b></summary>

Google は個人アカウントを Antigravity CLI に移行したため、このプロジェクトは `agy` を対象としています。非対話モードを
持つ CLI なら、バックエンドとして使えます。[他のバックエンド](#他のバックエンド)を参照してください。
</details>

<details>
<summary><b>どのプラットフォームに対応していますか。</b></summary>

サーバーは素の Node.js で、Windows、macOS、Linux で動作します。完全なセットアップは Windows 10 で検証しました。
プロセスツリーのキャンセルは、Windows では `taskkill`、それ以外ではプロセスグループを使います。
</details>

<details>
<summary><b>どの MCP クライアントが使えますか。</b></summary>

stdio の MCP サーバーを起動できるクライアントなら何でも使えます。ここでのセットアップ手順は Claude Code 向けです。
スキルファイルは Claude Code 専用ですが、ツールはそうではありません。
</details>

## 開発

```bash
npm run build
npm run smoke
npm test
npm run doctor
npm run try -- <workspace> "<task>" [path ...]
npx @modelcontextprotocol/inspector node dist/index.js
```

`npm test` はビルドし、スモークテストを実行し、翻訳された各 README が英語版のコードブロックを保っているかを確認します。
モックのワーカー (`scripts/mock-agent.mjs`) は、タスク中のマーカーに反応します。`SLOW_MODE` は 60 秒スリープし、
`BAD_FORMAT` はレポート形式を無視し、`WRITE_FILE` はワークスペースに書き込みます。

### プロジェクト構成

```text
src/
  index.ts      エントリーポイント: stdio 上の MCP サーバー、または `doctor`
  config.ts     設定スキーマ、デフォルト値、組み込みの agy バックエンド
  tools.ts      4 つの MCP ツール、パスの検証、ステータスの整形
  jobs.ts       キュー、起動、タイムアウト、キャンセル、結果の解析、変更の検出
  manifest.ts   対象ファイル (git ls-files またはディレクトリの走査)
  report.ts     ワーカーのプロンプト、レポートの解析、JSON の抽出、リンクの除去
  stream.ts     agy stream-json パーサー: 進捗、開いたファイル、タイムライン
  sanitize.ts   シークレットのマスク、インジェクション検出、カバレッジ
  dashboard.ts  ローカル Web ダッシュボードのサーバー (127.0.0.1、トークン)
  doctor.ts     セットアップのチェック
dashboard/                   ダッシュボードのページ (HTML、CSS、JS。ビルド不要)
agents/offload-reader.md     agy 用の読み取り専用ワーカーエージェント
skills/offload/SKILL.md      Claude Code のスキル: いつ、どのようにオフロードするか
scripts/smoke.ts             モックのワーカーに対するエンドツーエンドテスト
scripts/mock-agent.mjs       代用のワーカー
scripts/try.ts               実際のタスクをサーバー経由で 1 件実行する
scripts/check-readmes.mjs    翻訳された README を同期させる
docs/readme/                 翻訳された README
```

## ロードマップ

- ヘッドレスのカスタムエージェントが検索ツールを使えるようになった時点での、agy ワーカー向け検索ツール
- より多くのワーカー CLI についての、検証済みレシピ

## コントリビューション

Issue とプルリクエストを歓迎します。プルリクエストを開く前に `npm test` を実行してください。この README を変更するときは、
`docs/readme/` の翻訳も更新するか、更新できるように Issue を立ててください。翻訳のコードブロックがこのファイルから
ずれていると、README のチェックは失敗します。

## ライセンス

[MIT](../../LICENSE)
