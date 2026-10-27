/**
 * Offline contract test for the bundle distribution format.
 *
 * DSH's plugin manager only manages a package that declares
 * `"dsh": { "bundle": { "patch": ... } }`; without that declaration, installing
 * this package is refused with "The package declares no dsh.bundle and cannot
 * be managed as a plugin". The declaration alone is not enough either: startup
 * reads the patch file, and each inserted row's `id` is what the manager uses
 * to match the installed package to its runtime rows.
 *
 * These checks pin all three halves of that contract — declaration, patch row,
 * and the published file set — without importing a DSH package, so they run in
 * CI as well as here.
 *
 * Run: node test/bundle-contract.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

let failures = 0;
const check = (label, ok, detail) => {
  if (ok) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};

/** One row of the patch, collected by a deliberately small line scanner. */
function scanInsertRows(text) {
  const rows = [];
  let current = null;
  let inInsert = false;
  for (const line of text.split(/\r?\n/)) {
    const content = line.trim();
    if (content === "" || content.startsWith("#")) continue;
    if (/^-\s*insert:\s*$/.test(line)) {
      inInsert = true;
      continue;
    }
    if (!inInsert) continue;
    const id = /^\s+-\s*id:\s*(\S.*?)\s*$/.exec(line);
    if (id !== null) {
      current = { id: id[1], name: null, config: false };
      rows.push(current);
      continue;
    }
    const name = /^\s+name:\s*(\S.*?)\s*$/.exec(line);
    if (name !== null && current !== null) {
      current.name = name[1];
      continue;
    }
    if (/^\s+config:\s*$/.test(line) && current !== null) current.config = true;
  }
  return rows;
}

const patchRel = manifest.dsh?.bundle?.patch;
const patchPath = typeof patchRel === "string" ? resolve(root, patchRel) : null;
const patchText = patchPath !== null && existsSync(patchPath) ? readFileSync(patchPath, "utf8") : "";
const rows = scanInsertRows(patchText);

console.log("\n[1] package declares a manageable bundle");
check("dsh.bundle.patch is declared", typeof patchRel === "string", String(patchRel));
check("declaration points at ./cordis.patch.yml", patchRel === "./cordis.patch.yml", String(patchRel));
check("declared patch file exists", patchPath !== null && existsSync(patchPath), String(patchPath));
check("patch file is published in `files`", Array.isArray(manifest.files) && manifest.files.includes("cordis.patch.yml"));
check(
  "patch file is exported",
  manifest.exports?.["./cordis.patch.yml"] === "./cordis.patch.yml",
  JSON.stringify(manifest.exports?.["./cordis.patch.yml"])
);

console.log("\n[2] bundle patch mounts exactly one row");
check("patch has one `- insert:` block", (patchText.match(/^-\s*insert:\s*$/gm) ?? []).length === 1);
check("patch declares exactly one row", rows.length === 1, String(rows.length));
const row = rows[0] ?? { id: null, name: null, config: false };
check("row id is the full package name", row.id === manifest.name, `${String(row.id)} vs ${manifest.name}`);
check("row mounts the package by name", row.name === manifest.name, String(row.name));
check("row carries its config under `config:`", row.config === true);
check("patch has no unresolved template slots", !patchText.includes("{{"));

console.log("\n[3] the mounted entry is the shipped plugin");
const mainPath = resolve(root, typeof manifest.main === "string" ? manifest.main : "lib/index.js");
check("package main exists", existsSync(mainPath), mainPath);
const mod = await import(pathToFileURL(mainPath).href);
check("entry exports apply()", typeof mod.apply === "function", typeof mod.apply);
check("entry exports inject", Array.isArray(mod.inject), JSON.stringify(mod.inject));
check("inject declares systemPrompt", mod.inject.includes("systemPrompt"));
check("inject declares sessionProjections", mod.inject.includes("sessionProjections"));

console.log(failures === 0 ? "\nALL BUNDLE CHECKS PASSED\n" : `\n${failures} BUNDLE CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
