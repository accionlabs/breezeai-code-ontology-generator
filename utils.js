const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/**
 * Filters a list of absolute file paths to only include files
 * whose content hash differs from the existing hash map (or are new).
 * Returns the full list unchanged if no hash map is provided.
 */
function filterChangedFiles(files, repoPath, existingHashMap) {
  if (!existingHashMap || Object.keys(existingHashMap).length === 0) return files;

  const original = files.length;
  const filtered = files.filter(file => {
    const relativePath = path.relative(repoPath, file);
    const existingHash = existingHashMap[relativePath];
    if (!existingHash) return true; // new file, process it
    try {
      const content = fs.readFileSync(file, "utf-8");
      const currentHash = crypto.createHash("sha256").update(content).digest("hex");
      return currentHash !== existingHash;
    } catch {
      return true; // on error, process it
    }
  });

  if (filtered.length < original) {
    console.log(`   ⏭️  Skipped ${original - filtered.length} unchanged file(s), processing ${filtered.length} changed file(s)`);
  }

  return filtered;
}

module.exports = { filterChangedFiles };
