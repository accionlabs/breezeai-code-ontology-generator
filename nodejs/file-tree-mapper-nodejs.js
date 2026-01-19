#!/usr/bin/env node
/**
 * JavaScript Import Analyzer
 * Can be used as a CLI tool or imported as a module
 *
 * CLI Usage: node file-tree-mapper-nodejs.js <repoPath> <importsOutput.json>
 * Module Usage: const { analyzeJavaScriptRepo } = require('./file-tree-mapper-nodejs'); const data = analyzeJavaScriptRepo(repoPath);
 */

const fs = require("fs");
const path = require("path");
const glob = require("glob");
const Parser = require("tree-sitter");
const JavaScript = require("tree-sitter-javascript");
const { extractFuncitonAndItsCalls } = require("./extract-functions-nodejs");
const { extractClasses } = require("./extract-classes-nodejs");

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
function extractPackageNames(filePath, repoPath) {
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
  const jsFiles = getJsFiles(repoPath);

  const mapper = {};
  for (const file of jsFiles) {
    try {
      const [pkgName, relPath] = extractPackageNames(file, repoPath);
      mapper[pkgName] = relPath;
    } catch (err) {
      console.log("Error analyzing file for mapper:", file);
    }
  }

  return mapper;
}

function getJsFiles(repoPath) {
  return glob.sync(`${repoPath}/**/*.{js,jsx}`, {
    ignore: [
      `${repoPath}/**/node_modules/**`,
      `${repoPath}/**/build/**`,
      `${repoPath}/**/dist/**`
    ],
  });
}

// -------------------------------------------------------------
// Step 4: Analyze imports
// -------------------------------------------------------------
function analyzeImports(repoPath, mapper) {
  console.log("strted woring*******************************")
  const jsFiles = getJsFiles()


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

      // Helper function to try resolving a path with different extensions
      function tryResolveWithExtensions(basePath) {
        // If already has extension and exists, return it
        if (path.extname(basePath) && fs.existsSync(basePath)) {
          return basePath;
        }

        // Try with different JavaScript extensions
        const extensions = ['.js', '.jsx', '.mjs', '.cjs', '.json'];
        for (const ext of extensions) {
          const pathWithExt = basePath + ext;
          if (fs.existsSync(pathWithExt)) {
            return pathWithExt;
          }
        }

        // Try as directory with index file
        if (fs.existsSync(basePath) && fs.statSync(basePath).isDirectory()) {
          for (const ext of extensions) {
            const indexPath = path.join(basePath, 'index' + ext);
            if (fs.existsSync(indexPath)) {
              return indexPath;
            }
          }
        }

        // If no extension worked, return null
        return null;
      }

      for (let imp of imports) {
        let resolvedPath = null;
        let isResolved = false;

        // Handle relative imports (./file or ../file)
        if (imp.startsWith(".")) {
          resolvedPath = path.resolve(path.dirname(file), imp);
        }
        // Handle absolute imports (/src/file or /lib/file)
        else if (imp.startsWith("/")) {
          resolvedPath = path.join(repoPath, imp);
        }
        // Try to resolve as a local module (might be a path alias or local module)
        else if (!imp.startsWith('@')) {
          // Check if it's a local file path (not a package name)
          if (imp.includes('/')) {
            // Try to resolve relative to repo root
            resolvedPath = path.join(repoPath, imp);
          } else if (mapper[imp]) {
            // Try the mapper for simple package names
            const mappedPath = path.join(repoPath, mapper[imp]);
            if (fs.existsSync(mappedPath)) {
              importFiles.push(mapper[imp]);
              isResolved = true;
              continue;
            }
          } else {
            // Could be a local file without path, try common patterns
            const possiblePaths = [
              path.join(repoPath, 'src', imp),
              path.join(repoPath, 'lib', imp),
              path.join(repoPath, imp)
            ];

            for (const possiblePath of possiblePaths) {
              const testPath = tryResolveWithExtensions(possiblePath);
              if (testPath) {
                resolvedPath = testPath;
                break;
              }
            }
          }
        }

        // If we have a potential path, try to resolve it with extensions
        if (resolvedPath && !isResolved) {
          const finalPath = tryResolveWithExtensions(resolvedPath);

          if (finalPath && fs.existsSync(finalPath)) {
            const relativePath = path.relative(repoPath, finalPath);
            // Make sure it's within the repo (not outside)
            if (!relativePath.startsWith('..') && !path.isAbsolute(relativePath)) {
              importFiles.push(relativePath);
              isResolved = true;
              continue;
            }
          }
        }

        // If we couldn't resolve it as a local file, it's an external import
        if (!isResolved) {
          externalImports.push(imp); // NPM imports
        }
      }

      // Extract functions for this file
      const functions = extractFuncitonAndItsCalls(file, repoPath);

      const classes = extractClasses(file, repoPath)

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
// Main export function - to be called from main.js
// -------------------------------------------------------------
function analyzeJavaScriptRepo(repoPath) {
  console.log(`📂 Scanning JavaScript repo: ${repoPath}`);

  const mapper = buildPackageMapper(repoPath);
  const analysis = analyzeImports(repoPath, mapper);

  console.log(`\n📊 Summary:`);
  console.log(`   JavaScript files: ${analysis.length}`);

  return analysis;
}

// -------------------------------------------------------------
// EXPORTS
// -------------------------------------------------------------
module.exports = {
  analyzeJavaScriptRepo,
  extractImports,
  traverse,
  getNodeText,
  buildPackageMapper,
  analyzeImports
};

// -------------------------------------------------------------
// CLI mode - only run if executed directly (not imported)
// -------------------------------------------------------------
if (require.main === module) {
  if (process.argv.length < 4) {
    console.error(
      "Usage: node nodejs/file-tree-mapper-nodejs.js <repoPath> <importsOutput.json>"
    );
    process.exit(1);
  }

  const repoPath = path.resolve(process.argv[2]);
  const importsOutput = path.resolve(process.argv[3]);

  const results = analyzeJavaScriptRepo(repoPath);

  // Write results to file
  fs.writeFileSync(importsOutput, JSON.stringify(results, null, 2));
  console.log(`✅ Final output written → ${importsOutput}`);
}
