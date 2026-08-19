#!/usr/bin/env node
/**
 * Frontend drift audit. The counterpart to the backend's `npm run audit:codes`.
 *
 * Every check here exists because the corresponding bug actually shipped in this
 * repo and was caught late — by a browser test, or by a user, rather than by the
 * compiler. TypeScript cannot see any of them: a missing translation key is a
 * runtime string lookup, an uncalled data function is valid code, and a route table
 * is just an array of strings.
 *
 *   1. MESSAGES   every t() key resolves in every locale.
 *                 `audit.action.user.role_changed` rendered as a raw path on the
 *                 audit screen because next-intl treats "." as a namespace
 *                 separator and the key was flat.
 *
 *   2. REACHABLE  every exported data-layer capability has a caller.
 *                 `checkInPatient()` existed from Phase 2 with no caller, so a
 *                 registered patient could never reach the queue.
 *
 * Route access is covered by `e2e/rbac.spec.ts` instead — see the note where that
 * check used to be, and why.
 *
 * Exits non-zero on any finding so it can gate CI.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LOCALES = ["en", "hi", "gu"];

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".next" || entry === ".auth") {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if ([".ts", ".tsx"].includes(extname(full))) out.push(full);
  }
  return out;
}

function rel(path) {
  return path.slice(WEB.length + 1).replace(/\\/g, "/");
}

/** Resolve a dotted path against a nested messages object. */
function lookup(messages, path) {
  let node = messages;
  for (const part of path.split(".")) {
    if (node === null || typeof node !== "object" || !(part in node)) {
      return undefined;
    }
    node = node[part];
  }
  return node;
}

const findings = [];
function report(check, message) {
  findings.push({ check, message });
}

/* -------------------------------------------------------------------------- */
/* 1. messages                                                                */
/* -------------------------------------------------------------------------- */

const messages = {};
for (const locale of LOCALES) {
  messages[locale] = JSON.parse(
    readFileSync(join(WEB, "messages", `${locale}.json`), "utf8"),
  );
}

// A dot inside a key can never resolve — next-intl reads it as a separator.
(function checkNoDottedKeys() {
  const visit = (node, path, locale) => {
    if (node === null || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      if (key.includes(".")) {
        report(
          "MESSAGES",
          `${locale}.json: key "${path}${key}" contains a dot. next-intl treats it as a namespace separator, so it can never resolve — nest it instead.`,
        );
      }
      visit(value, `${path}${key}.`, locale);
    }
  };
  for (const locale of LOCALES) visit(messages[locale], "", locale);
})();

const sourceFiles = [
  ...walk(join(WEB, "app")),
  ...walk(join(WEB, "components")),
  ...walk(join(WEB, "lib")),
  ...walk(join(WEB, "hooks")),
];

(function checkTranslationKeys() {
  for (const file of sourceFiles) {
    const src = readFileSync(file, "utf8");

    // const t = useTranslations("beds")  →  { t: "beds" }
    const scopes = {};
    for (const m of src.matchAll(
      /const\s+(\w+)\s*=\s*useTranslations\(\s*["']([^"']+)["']\s*\)/g,
    )) {
      scopes[m[1]] = m[2];
    }
    if (Object.keys(scopes).length === 0) continue;
    const names = Object.keys(scopes).join("|");

    // Literal keys: t("title")
    for (const m of src.matchAll(
      new RegExp(`\\b(${names})\\(\\s*["']([^"'\`]+)["']`, "g"),
    )) {
      const full = `${scopes[m[1]]}.${m[2]}`;
      for (const locale of LOCALES) {
        const value = lookup(messages[locale], full);
        if (typeof value !== "string") {
          report(
            "MESSAGES",
            `${rel(file)}: ${m[1]}("${m[2]}") → "${full}" ${
              value === undefined ? "is missing from" : "is not a string in"
            } ${locale}.json`,
          );
        }
      }
    }

    // Dynamic keys: t(`status.${x}`) — verify the static prefix is a group, so at
    // least the namespace exists. The individual values can't be checked here.
    //
    // Only when the prefix ends in a dot. `t(`gender${Capitalised}`)` builds a
    // single flat key by concatenation rather than walking a path, and treating
    // that as `register.gender` reported three findings that were not real.
    for (const m of src.matchAll(
      new RegExp(`\\b(${names})\\(\\s*\`([^\`$]*)\\$\\{`, "g"),
    )) {
      if (!m[2].endsWith(".")) continue;
      const prefix = m[2].slice(0, -1);
      if (!prefix) continue;
      const full = `${scopes[m[1]]}.${prefix}`;
      for (const locale of LOCALES) {
        const value = lookup(messages[locale], full);
        if (value === null || typeof value !== "object") {
          report(
            "MESSAGES",
            `${rel(file)}: ${m[1]}(\`${prefix}.\${…}\`) → "${full}" is not a group in ${locale}.json`,
          );
        }
      }
    }
  }
})();

/* -------------------------------------------------------------------------- */
/* 2. reachable capabilities                                                  */
/* -------------------------------------------------------------------------- */

(function checkDataExportsHaveCallers() {
  const dataDir = join(WEB, "lib", "data");
  const dataFiles = walk(dataDir);

  for (const file of dataFiles) {
    const src = readFileSync(file, "utf8");
    const exported = new Set();
    for (const m of src.matchAll(
      /export\s+(?:async\s+)?function\s+(\w+)/g,
    )) {
      exported.add(m[1]);
    }
    if (exported.size === 0) continue;

    // Every source file except the one that defines it. Excluding all of lib/data
    // was wrong: `rpc.ts` exports helpers that only other data modules use, and
    // reporting those as unreachable is noise that hides the real finding.
    const others = sourceFiles
      .filter((f) => f !== file)
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");

    for (const name of exported) {
      if (!new RegExp(`\\b${name}\\b`).test(others)) {
        report(
          "REACHABLE",
          `${rel(file)}: ${name}() is exported but nothing else references it — a capability with no way to reach it in the UI.`,
        );
      }
    }
  }
})();

/*
 * Route access and nav consistency is deliberately NOT checked here.
 *
 * It was, via regex over `navigation.ts` and `route-access.ts`, and it reported 45
 * findings that were all false — the parser silently matched nothing and concluded
 * every link was forbidden. Regex-parsing TypeScript to make a security-adjacent
 * claim is the wrong tool, and a noisy audit is worse than no audit because people
 * stop reading it.
 *
 * `e2e/rbac.spec.ts` covers the same ground properly: it drives the real proxy with
 * a real session, asserts the nav link is absent, and then asserts the typed URL is
 * refused too — which is the part that actually matters, since hiding a button is
 * not access control (rules.md §4.3).
 */

/* -------------------------------------------------------------------------- */
/* output                                                                     */
/* -------------------------------------------------------------------------- */

const order = ["MESSAGES", "REACHABLE"];
if (findings.length === 0) {
  console.log(
    "audit-frontend: clean — every t() key resolves in en/hi/gu, and every exported data capability has a caller.",
  );
  process.exit(0);
}

for (const check of order) {
  const group = findings.filter((f) => f.check === check);
  if (group.length === 0) continue;
  console.log(`\n${check} — ${group.length} finding(s)`);
  for (const f of group) console.log(`  • ${f.message}`);
}
console.log(`\n${findings.length} finding(s) total.`);
process.exit(1);
