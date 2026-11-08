#!/usr/bin/env node
// Keeps the translated READMEs in docs/readme/ in sync with README.md.
//   node scripts/check-readmes.mjs          check every translation
//   node scripts/check-readmes.mjs vi ja    check only these
// Checks: file exists; language bar links every language; same number of "## " headings;
// every bash/powershell/json code block is byte-identical to the English one; in-page #anchors
// resolve to a heading; relative links point at files that exist.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LANGUAGES = [
  ["zh", "简体中文"], ["zh-TW", "繁體中文"], ["ja", "日本語"], ["ko", "한국어"], ["vi", "Tiếng Việt"],
  ["es", "Español"], ["fr", "Français"], ["de", "Deutsch"], ["pt-BR", "Português (Brasil)"], ["ru", "Русский"]
];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const english = read(path.join(root, "README.md"));
const VERBATIM = new Set(["bash", "powershell", "json"]);

function read(file) {
  return readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

function codeBlocks(text) {
  return [...text.matchAll(/^```(\w*)\n([\s\S]*?)^```$/gm)].map(m => ({ lang: m[1], body: m[2] }));
}

function withoutCode(text) {
  return text.replace(/^```[\s\S]*?^```$/gm, "");
}

function headings(text) {
  return withoutCode(text).split("\n").filter(line => /^#{1,6} /.test(line));
}

// GitHub's heading anchor algorithm: lowercase, drop punctuation, spaces to hyphens, de-duplicate.
function slugs(text) {
  const seen = new Map();
  const result = new Set();
  for (const line of headings(text)) {
    const plain = line.replace(/^#+ /, "").replace(/<[^>]+>/g, "").replace(/[*_`]/g, "").trim();
    const base = plain.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s-]/gu, "").replace(/\s/g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    result.add(n === 0 ? base : `${base}-${n}`);
  }
  return result;
}

function check(code) {
  const problems = [];
  const file = path.join(root, "docs", "readme", `README_${code}.md`);
  if (!existsSync(file)) return [`missing ${path.relative(root, file)}`];
  const text = read(file);

  // Language bar: links to English and every other translation.
  const bar = text.split("\n").slice(0, 8).join("\n");
  if (!bar.includes("](../../README.md)")) problems.push("language bar: no link to ../../README.md");
  for (const [other] of LANGUAGES) {
    if (other !== code && !bar.includes(`](README_${other}.md)`)) problems.push(`language bar: no link to README_${other}.md`);
  }

  const h2en = headings(english).filter(h => h.startsWith("## ")).length;
  const h2 = headings(text).filter(h => h.startsWith("## ")).length;
  if (h2 !== h2en) problems.push(`"## " headings: ${h2}, English has ${h2en}`);

  const theirs = codeBlocks(text).filter(b => VERBATIM.has(b.lang)).map(b => b.body);
  for (const block of codeBlocks(english).filter(b => VERBATIM.has(b.lang))) {
    if (!theirs.includes(block.body)) problems.push(`code block changed or missing:\n${block.body.split("\n")[0]} …`);
  }

  const anchors = slugs(text);
  const prose = withoutCode(text);
  for (const m of prose.matchAll(/\]\(#([^)]+)\)/g)) {
    if (!anchors.has(decodeURIComponent(m[1]))) problems.push(`anchor #${m[1]} matches no heading`);
  }
  for (const m of prose.matchAll(/\]\((?!https?:|#|mailto:)([^)#\s]+)(#[^)]*)?\)/g)) {
    if (!existsSync(path.resolve(path.dirname(file), m[1]))) problems.push(`relative link ${m[1]} does not exist`);
  }
  return problems;
}

const wanted = process.argv.slice(2);
const codes = wanted.length ? wanted : LANGUAGES.map(([code]) => code);
let failed = 0;
for (const code of codes) {
  const problems = check(code);
  if (problems.length) {
    failed++;
    console.log(`✗ README_${code}.md`);
    for (const problem of problems) console.log(`    ${problem}`);
  } else {
    console.log(`✓ README_${code}.md`);
  }
}
const englishAnchors = slugs(english);
for (const m of withoutCode(english).matchAll(/\]\(#([^)]+)\)/g)) {
  if (!englishAnchors.has(m[1])) {
    failed++;
    console.log(`✗ README.md: anchor #${m[1]} matches no heading`);
  }
}
process.exit(failed ? 1 : 0);
