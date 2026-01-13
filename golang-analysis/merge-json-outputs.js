#!/usr/bin/env node

/**
 * Merge multiple JSON outputs into a single comprehensive file
 */

const fs = require("fs");

const files = process.argv.slice(2, -1); // All args except the last
const outputFile = process.argv[process.argv.length - 1]; // Last arg is output

if (files.length < 2 || !outputFile) {
  console.error("Usage: node merge-json-outputs.js <input1.json> <input2.json> ... <output.json>");
  process.exit(1);
}

console.log(`\n🔗 Merging ${files.length} JSON files...\n`);

let merged = [];
let totalFiles = 0;

files.forEach((file) => {
  console.log(`   📄 Reading: ${file}`);
  const data = JSON.parse(fs.readFileSync(file, "utf-8"));
  merged = merged.concat(data);
  totalFiles += data.length;
  console.log(`      ✅ Added ${data.length} entries`);
});

console.log(`\n   📦 Total entries: ${totalFiles}`);
console.log(`   📝 Writing to: ${outputFile}\n`);

fs.writeFileSync(outputFile, JSON.stringify(merged, null, 2), "utf-8");

console.log("✅ Merge complete!\n");
