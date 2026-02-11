#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const glob = require("glob");
const Parser = require("tree-sitter");
const Go = require("tree-sitter-go");
const { extractFunctionsAndCalls } = require("./extract-functions-golang");
const { extractClasses } = require("./extract-classes-golang");
const { filterChangedFiles } = require("../utils");

const parser = new Parser();
parser.setLanguage(Go);

// -------------------------------------------------------------
// Helpers
// -------------------------------------------------------------
function traverse(node, callback) {
  callback(node);
  for (let i = 0; i < node.namedChildCount; i++) {
    traverse(node.namedChild(i), callback);
  }
}

function getNodeText(node, sourceText) {
  return sourceText.slice(node.startIndex, node.endIndex);
}

function getGoFiles(repoPath) {
  return glob.sync(`${repoPath}/**/*.go`, {
    ignore: [
      `${repoPath}/**/vendor/**`,
      `${repoPath}/**/.git/**`,
      `${repoPath}/**/dist/**`,
      `${repoPath}/**/build/**`,
    ],
  });
}

function findGoMod(startDir) {
  let dir = path.resolve(startDir);

  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, "go.mod");
    if (fs.existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return null;
}

function readModuleName(goModPath) {
  const content = fs.readFileSync(goModPath, "utf8");
  const match = content.match(/^module\s+(.+)$/m);
  return match ? match[1].trim() : null;
}

// -------------------------------------------------------------
// Import Extraction
// -------------------------------------------------------------
function extractImports(filePath) {
  const sourceText = fs.readFileSync(filePath, "utf8").replace(/\0/g, "");
  if (!sourceText.trim()) return [];

  const tree = parser.parse(sourceText);
  const imports = [];

  traverse(tree.rootNode, (node) => {
    if (node.type === "import_spec") {
      const pathNode = node.childForFieldName("path");
      if (pathNode) {
        imports.push(getNodeText(pathNode, sourceText).replace(/["']/g, ""));
      }
    }
  });

  return imports;
}

// -------------------------------------------------------------
// Analyze Imports
// -------------------------------------------------------------
function analyzeImports(repoPath, existingHashMap) {
  let goFiles = getGoFiles(repoPath);
  goFiles = filterChangedFiles(goFiles, repoPath, existingHashMap);
  const results = [];
  const totalFiles = goFiles.length;

  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIndex = 0;

  console.log(`\n📊 Go files to process: ${totalFiles}\n`);

  for (let i = 0; i < goFiles.length; i++) {
    const file = goFiles[i];

    try {
      const percentage = ((i / totalFiles) * 100).toFixed(1);
      const spinner = spinnerFrames[spinnerIndex % spinnerFrames.length];
      const fileName = path.relative(repoPath, file);

      process.stdout.write(`\r${spinner} Processing Go: ${i}/${totalFiles} (${percentage}%) - ${fileName.substring(0, 60).padEnd(60, ' ')}`);
      spinnerIndex++;

      const imports = extractImports(file);
      const importFiles = [];
      const externalImports = [];

      const goModPath = findGoMod(path.dirname(file));
      let moduleName = null;
      let moduleRoot = null;

      if (goModPath) {
        moduleRoot = path.dirname(goModPath);
        moduleName = readModuleName(goModPath);
      }

      for (let imp of imports) {
        let resolved = false;

        // Local module import
        if (moduleName && imp.startsWith(moduleName)) {
          const rel = imp.slice(moduleName.length);
          const pkgDir = path.join(moduleRoot, rel);

          if (fs.existsSync(pkgDir) && fs.statSync(pkgDir).isDirectory()) {
            const files = fs.readdirSync(pkgDir)
              .filter(f => f.endsWith(".go") && !f.endsWith("_test.go"))
              .map(f => path.relative(repoPath, path.join(pkgDir, f)));

            importFiles.push(...files);
            resolved = true;
          }
        }

        // Relative import (rare)
        if (!resolved && imp.startsWith(".")) {
          const abs = path.resolve(path.dirname(file), imp);
          if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
            const files = fs.readdirSync(abs)
              .filter(f => f.endsWith(".go"))
              .map(f => path.relative(repoPath, path.join(abs, f)));

            importFiles.push(...files);
            resolved = true;
          }
        }

        if (!resolved) {
          externalImports.push(imp);
        }
      }

      const functions = extractFunctionsAndCalls(file, repoPath);
      const classes = extractClasses(file, repoPath);

      results.push({
        path: path.relative(repoPath, file),
        importFiles: [...new Set(importFiles)],
        externalImports: [...new Set(externalImports)],
        functions,
        classes,
      });
    } catch (e) {
      console.log(`\n❌ Error analyzing ${file}:`, e);
    }
  }

  // Clear the progress line and show completion
  process.stdout.write(`\r${' '.repeat(120)}\r`);
  console.log(`✅ Processed ${results.length}/${totalFiles} Go files\n`);

  return results;
}

// -------------------------------------------------------------
// Wrapper
// -------------------------------------------------------------
function analyzeGolangRepo(repoPath, existingHashMap) {
  return analyzeImports(repoPath, existingHashMap);
}

module.exports = { analyzeGolangRepo };

// -------------------------------------------------------------
// Main
// -------------------------------------------------------------
if (require.main === module) {
  if (process.argv.length < 4) {
    console.error(
      "Usage: node file-tree-mapper-golang.js <repoPath> <importsOutput.json>"
    );
    process.exit(1);
  }

  const repoPath = path.resolve(process.argv[2]);
  const importsOutput = path.resolve(process.argv[3]);

  console.log(`Scanning Go repo: ${repoPath}`);

  const analysis = analyzeGolangRepo(repoPath);
  fs.writeFileSync(importsOutput, JSON.stringify(analysis, null, 2));

  console.log(`Output written to → ${importsOutput}`);
}
