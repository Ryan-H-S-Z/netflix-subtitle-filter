"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const manifestPath = path.join(root, "manifest.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

if (manifest.manifest_version !== 3) {
  throw new Error("manifest.json must use Manifest V3");
}

const referencedFiles = new Set();

for (const iconPath of Object.values(manifest.icons || {})) {
  referencedFiles.add(iconPath);
}

for (const iconPath of Object.values(manifest.action?.default_icon || {})) {
  referencedFiles.add(iconPath);
}

if (manifest.action?.default_popup) {
  referencedFiles.add(manifest.action.default_popup);
}

if (manifest.background?.service_worker) {
  referencedFiles.add(manifest.background.service_worker);
}

for (const contentScript of manifest.content_scripts || []) {
  for (const file of [...(contentScript.js || []), ...(contentScript.css || [])]) {
    referencedFiles.add(file);
  }
}

const missing = Array.from(referencedFiles).filter((file) => !fs.existsSync(path.join(root, file)));

if (missing.length) {
  throw new Error(`Manifest references missing files: ${missing.join(", ")}`);
}

console.log(`Manifest valid: ${referencedFiles.size} referenced files found.`);
