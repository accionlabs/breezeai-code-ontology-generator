#!/usr/bin/env node
/**
 * JavaScript Import Analyzer
 * Usage: node file-tree-mapper-nodejs.js <repoPath> <importsOutput.json>
 */

const fs = require("fs");
const path = require("path");
const glob = require("glob");
const Parser = require("tree-sitter");
const JavaScript = require("tree-sitter-javascript");
const { extractFunctionsWithCalls } = require("./extract-functions-nodejs");

if (process.argv.length < 4) {
  console.error(
    "Usage: node file-tree-mapper-nodejs.js <repoPath> <importsOutput.json>"
  );
  process.exit(1);
}

const repoPath = path.resolve(process.argv[2]);
const mapperOutput = "mapper.json";   // TEMP FILE
const importsOutput = path.resolve(process.argv[3]);

// -------------------------------------------------------------
// Initialize parser
// -------------------------------------------------------------
const parser = new Parser();
parser.setLanguage(JavaScript);

// -------------------------------------------------------------
// Helper functions
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

// -------------------------------------------------------------
// Step 1: Extract package names
// -------------------------------------------------------------
function extractPackageNames(filePath) {
  const relPath = path.relative(repoPath, filePath);
  const packageName = path.basename(filePath, path.extname(filePath));
  return [packageName, relPath];
}

// -------------------------------------------------------------
// Step 2: Extract JavaScript imports
// -------------------------------------------------------------
function extractImports(filePath) {
  const sourceText = fs.readFileSync(filePath, "utf8").replace(/\0/g, "");
  if (!sourceText.trim()) return { imports: [], libPaths: [] };

  const tree = parser.parse(sourceText);
  const imports = [];
  const libPaths = [];

  traverse(tree.rootNode, (node) => {
    // ES6 imports
    if (node.type === "import_statement") {
      const moduleNode = node.namedChildren.find((n) => n.type === "string");
      if (moduleNode) {
        imports.push(getNodeText(moduleNode, sourceText).replace(/['"]/g, ""));
      }
    }

    // require("module")
    if (node.type === "call_expression") {
      const funcNode = node.namedChildren[0];
      const argNode = node.namedChildren[1]?.namedChild(0);

      if (
        funcNode &&
        funcNode.type === "identifier" &&
        getNodeText(funcNode, sourceText) === "require" &&
        argNode &&
        argNode.type === "string"
      ) {
        imports.push(getNodeText(argNode, sourceText).replace(/['"]/g, ""));
      }
    }
  });

  return { imports, libPaths };
}

// -------------------------------------------------------------
// Step 3: Build mapper
// -------------------------------------------------------------
function buildPackageMapper(repoPath) {
  const jsFiles = glob.sync(`${repoPath}/**/*.js`, {
    ignore: ["**/node_modules/**", "**/build/**", "**/dist/**"],
  });

  const mapper = {};
  for (const file of jsFiles) {
    try {
      const [pkgName, relPath] = extractPackageNames(file);
      mapper[pkgName] = relPath;
    } catch (err) {
      console.log("Error analyzing file for mapper:", file);
    }
  }

  return mapper;
}

// -------------------------------------------------------------
// Step 4: Analyze imports
// -------------------------------------------------------------
function analyzeImports(repoPath, mapper) {
  const jsFiles = glob.sync(`${repoPath}/**/*.js`, {
  ignore: [
    `${repoPath}/**/node_modules/**`,
    `${repoPath}/**/build/**`,
    `${repoPath}/**/dist/**`
  ],
});


  const results = [];
  const totalFiles = jsFiles.length;
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIndex = 0;

  console.log(`\n📊 Total files to process: ${totalFiles}\n`);

  for (let i = 0; i < jsFiles.length; i++) {
    const file = jsFiles[i];

    try {
      // Show progress with spinner
      const percentage = ((i / totalFiles) * 100).toFixed(1);
      const spinner = spinnerFrames[spinnerIndex % spinnerFrames.length];
      const fileName = path.relative(repoPath, file);

      process.stdout.write(`\r${spinner} Processing: ${i}/${totalFiles} (${percentage}%) - ${fileName.substring(0, 60).padEnd(60, ' ')}`);
      spinnerIndex++;

      const { imports } = extractImports(file);
      const importFiles = [];
      const externalImports = [];

      for (let imp of imports) {
        if (imp.startsWith(".")) {
          let resolvedPath = path.resolve(path.dirname(file), imp);
          if (!path.extname(resolvedPath)) resolvedPath += ".js";
          resolvedPath = path.relative(repoPath, resolvedPath);
          importFiles.push(resolvedPath);
        } else if (mapper[imp]) {
          importFiles.push(mapper[imp]);
        } else {
          externalImports.push(imp); // NPM imports
        }
      }

      // Extract functions for this file
      const functions = extractFunctionsWithCalls(file, repoPath);

      results.push({
        path: path.relative(repoPath, file),
        importFiles: [...new Set(importFiles)],
        externalImports: [...new Set(externalImports)],
        functions: functions
      });
    } catch (e) {
      process.stdout.write('\n');
      console.log(`❌ Error analyzing file: ${file} - ${e.message}`);
    }
  }

  // Clear progress line and show completion
  process.stdout.write('\r' + ' '.repeat(150) + '\r');
  console.log(`✅ Completed processing ${totalFiles} files\n`);

  return results;
}

// -------------------------------------------------------------
// MAIN EXECUTION
// -------------------------------------------------------------
(async () => {
  console.log(`📂 Scanning repo: ${repoPath}`);

  const mapper = buildPackageMapper(repoPath);
  fs.writeFileSync(mapperOutput, JSON.stringify(mapper, null, 2));
  console.log(`🛠️  Temporary mapper saved → ${mapperOutput}`);

  const analysis = analyzeImports(repoPath, mapper);
  fs.writeFileSync(importsOutput, JSON.stringify(analysis, null, 2));
  console.log(`✅ Final output written to → ${importsOutput}`);

  // DELETE TEMP FILE
  fs.unlinkSync(mapperOutput);
  console.log(`🗑️  Deleted temporary file: ${mapperOutput}`);
})();
