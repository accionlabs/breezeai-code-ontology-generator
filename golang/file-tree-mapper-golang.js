#!/usr/bin/env node
/**
 * Go Import Analyzer
 * Usage: node file-tree-mapper-golang.js <repoPath> <importsOutput.json>
 */

const fs = require("fs");
const path = require("path");
const glob = require("glob");
const Parser = require("tree-sitter");
const Go = require("tree-sitter-go");
const { extractFunctionsAndCalls } = require("./extract-functions-golang");
const { extractClasses } = require("./extract-classes-golang");

if (process.argv.length < 4) {
  console.error(
    "Usage: node golang/file-tree-mapper-golang.js <repoPath> <importsOutput.json>"
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
parser.setLanguage(Go);

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
  // For Go, package name is typically the directory name
  const packageName = path.basename(path.dirname(filePath));
  return [packageName, relPath];
}

// -------------------------------------------------------------
// Step 2: Extract Go imports
// -------------------------------------------------------------
function extractImports(filePath) {
  const sourceText = fs.readFileSync(filePath, "utf8").replace(/\0/g, "");
  if (!sourceText.trim()) return { imports: [], libPaths: [] };

  const tree = parser.parse(sourceText);
  const imports = [];
  const libPaths = [];

  traverse(tree.rootNode, (node) => {
    if (node.type === "import_declaration") {
      // Single import: import "fmt"
      const importSpec = node.childForFieldName("spec");
      if (importSpec && importSpec.type === "import_spec") {
        const pathNode = importSpec.childForFieldName("path");
        if (pathNode) {
          imports.push(getNodeText(pathNode, sourceText).replace(/["']/g, ""));
        }
      }

      // Multiple imports: import ( "fmt" "os" )
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child.type === "import_spec_list") {
          for (let j = 0; j < child.childCount; j++) {
            const spec = child.child(j);
            if (spec.type === "import_spec") {
              const pathNode = spec.childForFieldName("path");
              if (pathNode) {
                imports.push(getNodeText(pathNode, sourceText).replace(/["']/g, ""));
              }
            }
          }
        }
      }
    }
  });

  return { imports, libPaths };
}

// -------------------------------------------------------------
// Step 3: Build mapper
// -------------------------------------------------------------
function buildPackageMapper(repoPath) {
  const goFiles = getGoFiles();

  const mapper = {};
  for (const file of goFiles) {
    try {
      const [pkgName, relPath] = extractPackageNames(file);
      mapper[pkgName] = relPath;
    } catch (err) {
      console.log("Error analyzing file for mapper:", file);
    }
  }

  return mapper;
}

function getGoFiles() {
  return glob.sync(`${repoPath}/**/*.go`, {
    ignore: [
      `${repoPath}/**/vendor/**`,
      `${repoPath}/**/build/**`,
      `${repoPath}/**/dist/**`,
      `${repoPath}/**/.git/**`
    ],
  });
}

// -------------------------------------------------------------
// Step 4: Analyze imports
// -------------------------------------------------------------
function analyzeImports(repoPath, mapper) {
  console.log("Started working...");
  const goFiles = getGoFiles();

  const results = [];
  const totalFiles = goFiles.length;
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIndex = 0;

  console.log(`\n📊 Total files to process: ${totalFiles}\n`);

  for (let i = 0; i < goFiles.length; i++) {
    const file = goFiles[i];

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

      // Helper function to try resolving a path
      function tryResolveGoPath(basePath) {
        // Check if directory exists (Go packages are directories)
        if (fs.existsSync(basePath) && fs.statSync(basePath).isDirectory()) {
          return basePath;
        }

        // Try with .go extension
        if (fs.existsSync(basePath + ".go")) {
          return basePath + ".go";
        }

        return null;
      }

      for (let imp of imports) {
        let resolvedPath = null;
        let isResolved = false;

        // Handle relative imports (./package or ../package)
        if (imp.startsWith(".")) {
          resolvedPath = path.resolve(path.dirname(file), imp);
        }
        // Handle absolute imports from project root
        else if (imp.startsWith("/")) {
          resolvedPath = path.join(repoPath, imp);
        }
        // Try to resolve as a local module
        else {
          // Check if it's a local package (not a standard library or third-party)
          // Try to find it in common locations
          const possiblePaths = [
            path.join(repoPath, imp),
            path.join(repoPath, 'pkg', imp),
            path.join(repoPath, 'internal', imp),
            path.join(repoPath, 'src', imp)
          ];

          for (const possiblePath of possiblePaths) {
            const testPath = tryResolveGoPath(possiblePath);
            if (testPath) {
              resolvedPath = testPath;
              break;
            }
          }
        }

        // If we have a potential path, verify it exists
        if (resolvedPath && !isResolved) {
          const finalPath = tryResolveGoPath(resolvedPath);

          if (finalPath && fs.existsSync(finalPath)) {
            const relativePath = path.relative(repoPath, finalPath);
            // Make sure it's within the repo
            if (!relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
              importFiles.push(relativePath);
              isResolved = true;
              continue;
            }
          }
        }

        // If we couldn't resolve it as a local file, it's an external import
        if (!isResolved) {
          externalImports.push(imp); // Standard library or third-party imports
        }
      }

      // Extract functions for this file
      const functions = extractFunctionsAndCalls(file, repoPath);

      // Extract structs and interfaces
      const classes = extractClasses(file, repoPath);

      results.push({
        path: path.relative(repoPath, file),
        importFiles: [...new Set(importFiles)],
        externalImports: [...new Set(externalImports)],
        functions: functions,
        classes
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
// EXPORTS (for use in other files if needed)
// -------------------------------------------------------------
module.exports = {
  extractImports,
  traverse,
  getNodeText,
  buildPackageMapper,
  analyzeImports
};

// -------------------------------------------------------------
// MAIN EXECUTION
// -------------------------------------------------------------
if (require.main === module) {
  (async () => {
    console.log(`📂 Scanning Go repo: ${repoPath}`);

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
}
