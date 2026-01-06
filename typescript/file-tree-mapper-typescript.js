#!/usr/bin/env node
/**
 * TypeScript/JavaScript Import Analyzer
 * Analyzes both TypeScript (.ts, .tsx) and JavaScript (.js, .jsx) files
 * Usage: node file-tree-mapper-typescript.js <repoPath> <importsOutput.json>
 */

const fs = require("fs");
const path = require("path");
const glob = require("glob");
const { extractFunctionsAndCalls: extractFunctionsTS, extractImports: extractImportsTS } = require("./extract-functions-typescript");
const { extractClasses: extractClassesTS } = require("./extract-classes-typescript");

// Import JavaScript parsers for .js/.jsx files
const { extractFuncitonAndItsCalls: extractFunctionsJS } = require("../nodejs/extract-functions-nodejs");
const { extractClasses: extractClassesJS } = require("../nodejs/extract-classes-nodejs");

const Parser = require("tree-sitter");
const JavaScript = require("tree-sitter-javascript");

// Initialize JavaScript parser
const jsParser = new Parser();
jsParser.setLanguage(JavaScript);

if (process.argv.length < 4) {
  console.error(
    "Usage: node typescript/file-tree-mapper-typescript.js <repoPath> <importsOutput.json>"
  );
  process.exit(1);
}

const repoPath = path.resolve(process.argv[2]);
const importsOutput = path.resolve(process.argv[3]);

// -------------------------------------------------------------
// Helper functions for Tree-sitter traversal (for JS files)
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
// Check if file is JavaScript
// -------------------------------------------------------------
function isJavaScriptFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.js' || ext === '.jsx';
}

// -------------------------------------------------------------
// Extract imports from JavaScript files
// -------------------------------------------------------------
function extractImportsJS(filePath) {
  const sourceText = fs.readFileSync(filePath, "utf8").replace(/\0/g, "");
  if (!sourceText.trim()) return [];

  const tree = jsParser.parse(sourceText);
  const imports = [];

  traverse(tree.rootNode, (node) => {
    // ES6 imports
    if (node.type === "import_statement") {
      const moduleNode = node.namedChildren.find((n) => n.type === "string");
      if (moduleNode) {
        const importPath = getNodeText(moduleNode, sourceText).replace(/['"]/g, "");
        imports.push({ source: importPath, specifiers: [] });
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
        const importPath = getNodeText(argNode, sourceText).replace(/['"]/g, "");
        imports.push({ source: importPath, specifiers: [] });
      }
    }
  });

  return imports;
}

// -------------------------------------------------------------
// Unified import extraction (uses appropriate parser)
// -------------------------------------------------------------
function extractImports(filePath) {
  if (isJavaScriptFile(filePath)) {
    return extractImportsJS(filePath);
  } else {
    return extractImportsTS(filePath);
  }
}

// -------------------------------------------------------------
// Unified function extraction (uses appropriate parser)
// -------------------------------------------------------------
function extractFunctionsAndCalls(filePath) {
  if (isJavaScriptFile(filePath)) {
    return extractFunctionsJS(filePath);
  } else {
    return extractFunctionsTS(filePath);
  }
}

// -------------------------------------------------------------
// Unified class extraction (uses appropriate parser)
// -------------------------------------------------------------
function extractClasses(filePath) {
  if (isJavaScriptFile(filePath)) {
    return extractClassesJS(filePath);
  } else {
    return extractClassesTS(filePath);
  }
}

// -------------------------------------------------------------
// Get TypeScript and JavaScript files
// -------------------------------------------------------------
function getTsFiles() {
  return glob.sync(`${repoPath}/**/*.{ts,tsx,js,jsx}`, {
    ignore: [
      `${repoPath}/**/node_modules/**`,
      `${repoPath}/**/build/**`,
      `${repoPath}/**/dist/**`
    ]
  });
}

// -------------------------------------------------------------
// Analyze files with functions and classes
// -------------------------------------------------------------
function analyzeFiles() {
  const tsFiles = getTsFiles();
  const results = [];
  const totalFiles = tsFiles.length;

  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIndex = 0;

  console.log(`\n📊 Total files to process: ${totalFiles}\n`);

  for (let i = 0; i < tsFiles.length; i++) {
    const file = tsFiles[i];

    try {
      const percentage = ((i / totalFiles) * 100).toFixed(1);
      const spinner = spinnerFrames[spinnerIndex % spinnerFrames.length];
      const fileName = path.relative(repoPath, file);

      process.stdout.write(`\r${spinner} Processing: ${i}/${totalFiles} (${percentage}%) - ${fileName.substring(0, 60).padEnd(60, ' ')}`);
      spinnerIndex++;

      const imports = extractImports(file);
      const importFiles = [];
      const externalImports = [];

      // Resolve imports
      imports.forEach(imp => {
        const importSource = imp.source;
        let resolvedPath = null;
        let isResolved = false;

        // Handle relative imports (./file or ../file)
        if (importSource.startsWith(".")) {
          resolvedPath = path.resolve(path.dirname(file), importSource);
        }
        // Handle absolute imports (/src/file or /lib/file)
        else if (importSource.startsWith("/")) {
          resolvedPath = path.join(repoPath, importSource);
        }
        // Try to resolve as a local module (might be a path alias or local module)
        else if (!importSource.startsWith('@')) {
          // Check if it's a local file path (not a package name)
          // Package names typically don't contain "/" or are scoped (@org/package)
          if (importSource.includes('/')) {
            // Try to resolve relative to repo root
            resolvedPath = path.join(repoPath, importSource);
          } else {
            // Could be a local file without path, try common patterns
            const possiblePaths = [
              path.join(repoPath, 'src', importSource),
              path.join(repoPath, 'lib', importSource),
              path.join(repoPath, importSource)
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
              return;
            }
          }
        }

        // If we couldn't resolve it as a local file, it's an external import
        if (!isResolved) {
          externalImports.push(importSource);
        }
      });

      // Helper function to try resolving a path with different extensions
      function tryResolveWithExtensions(basePath) {
        // If already has extension and exists, return it
        if (path.extname(basePath) && fs.existsSync(basePath)) {
          return basePath;
        }

        // Try with different extensions
        const extensions = ['.ts', '.tsx', '.js', '.jsx'];
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

      // Extract functions and classes
      const functions = extractFunctionsAndCalls(file, repoPath);
      const classes = extractClasses(file, repoPath);

      results.push({
        path: path.relative(repoPath, file),
        importFiles: [...new Set(importFiles)],
        externalImports: [...new Set(externalImports)],
        functions,
        classes
      });
    } catch (e) {
      process.stdout.write('\n');
      console.log(`❌ Error analyzing file: ${file} - ${e.message}`);
    }
  }

  process.stdout.write('\r' + ' '.repeat(150) + '\r');
  console.log(`✅ Completed processing ${totalFiles} files\n`);

  return results;
}

// -------------------------------------------------------------
// MAIN
// -------------------------------------------------------------
(() => {
  console.log(`📂 Scanning TypeScript repo: ${repoPath}`);

  const analysis = analyzeFiles();
  fs.writeFileSync(importsOutput, JSON.stringify(analysis, null, 2));
  console.log(`✅ Final output written → ${importsOutput}`);
})();
