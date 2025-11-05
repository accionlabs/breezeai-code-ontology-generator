#!/usr/bin/env node
/**
 * JavaScript Import Analyzer
 * Usage: node analyze-js-imports.js <repoPath> <mapperOutput.json> <importsOutput.json>
 */

const fs = require("fs");
const path = require("path");
const glob = require("glob");
const Parser = require("tree-sitter");
const JavaScript = require("tree-sitter-javascript");

if (process.argv.length < 5) {
  console.error(
    "Usage: node analyze-js-imports.js <repoPath> <mapperOutput.json> <importsOutput.json>"
  );
  process.exit(1);
}

const repoPath = path.resolve(process.argv[2]);
const mapperOutput = path.resolve(process.argv[3]);
const importsOutput = path.resolve(process.argv[4]);

// -------------------------------------------------------------
// Initialize parser
// -------------------------------------------------------------
const parser = new Parser();
parser.setLanguage(JavaScript);

// -------------------------------------------------------------
// Helper: recursively traverse AST
// -------------------------------------------------------------
function traverse(node, callback) {
  callback(node);
  for (let i = 0; i < node.namedChildCount; i++) {
    traverse(node.namedChild(i), callback);
  }
}

// Helper: get text from node
function getNodeText(node, sourceText) {
  return sourceText.slice(node.startIndex, node.endIndex);
}

// -------------------------------------------------------------
// Step 1: Extract "package" names (for mapper, treat each file as a package)
// -------------------------------------------------------------
function extractPackageNames(filePath) {
  const relPath = path.relative(repoPath, filePath);
  const packageName = path.basename(filePath, path.extname(filePath));
  return [packageName, relPath];
}

// -------------------------------------------------------------
// Step 2: Extract imports from AST
// -------------------------------------------------------------
function extractImports(filePath) {
  const sourceText = fs.readFileSync(filePath, "utf8").replace(/\0/g, "");
  if (!sourceText.trim()) return { imports: [], libPaths: [] };

  const tree = parser.parse(sourceText);
  const imports = [];
  const libPaths = [];

  traverse(tree.rootNode, (node) => {
    // ES6 import ... from 'module';
    if (node.type === "import_statement") {
      const moduleNode = node.namedChildren.find((n) => n.type === "string");
      if (moduleNode) {
        const moduleName = getNodeText(moduleNode, sourceText).replace(
          /['"]/g,
          ""
        );
        imports.push(moduleName);
      }
    }

    // CommonJS require('module')
    if (node.type === "call_expression") {
      const funcNode = node.namedChildren[0]; // function being called
      const argNode = node.namedChildren[1]?.namedChild(0); // first argument

      if (
        funcNode &&
        funcNode.type === "identifier" &&
        getNodeText(funcNode, sourceText) === "require" &&
        argNode &&
        argNode.type === "string"
      ) {
        const moduleName = getNodeText(argNode, sourceText).replace(/['"]/g, "");
        imports.push(moduleName);
      }
    }

    // Destructured require: const {x, y} = require('module')
    if (node.type === "variable_declarator") {
      const initNode = node.childForFieldName("value");
      if (
        initNode &&
        initNode.type === "call_expression" &&
        initNode.namedChildren[0].type === "identifier" &&
        getNodeText(initNode.namedChildren[0], sourceText) === "require"
      ) {
        const argNode = initNode.namedChildren[1]?.namedChild(0);
        if (argNode && argNode.type === "string") {
          const moduleName = getNodeText(argNode, sourceText).replace(/['"]/g, "");
          imports.push(moduleName);
        }
      }
    }
  });

  return { imports, libPaths };
}

// -------------------------------------------------------------
// Step 3: Build package-to-path mapper
// -------------------------------------------------------------
function buildPackageMapper(repoPath) {
  const jsFiles = glob.sync(`${repoPath}/**/*.js`, {
    ignore: ["**/build/**", "**/blib/**", "**/node_modules/**"],
  });

  const mapper = {};
  for (const file of jsFiles) {
    try {
      const [pkgName, relPath] = extractPackageNames(file);
      mapper[pkgName] = relPath;
    } catch (err) {
      console.log("Error analyzing file for mapper:", file, err.message);
    }
  }

  return mapper;
}

// -------------------------------------------------------------
// Step 4: Analyze imports for all files
// -------------------------------------------------------------
function analyzeImports(repoPath, mapper) {
  const jsFiles = glob.sync(`${repoPath}/**/*.js`, {
    ignore: ["**/build/**", "**/blib/**", "**/node_modules/**"],
  });

  const results = [];

  for (const file of jsFiles) {
    try {
      const { imports, libPaths } = extractImports(file);
      const importFiles = [];
      const externalImports = [];

      for (let imp of imports) {
        let resolvedPath = imp;

        if (imp.startsWith(".")) {
          // Treat all relative imports as local files
          resolvedPath = path.resolve(path.dirname(file), imp);
          if (!path.extname(resolvedPath)) resolvedPath += ".js";
          resolvedPath = path.relative(repoPath, resolvedPath);
          importFiles.push(resolvedPath);
        } else {
          // Non-relative import: check mapper for known packages
          if (mapper[imp]) {
            importFiles.push(mapper[imp]);
          } else {
            externalImports.push(imp); // probably npm package
          }
        }
      }

      results.push({
        path: path.relative(repoPath, file),
        importFiles: [...new Set(importFiles)],
        externalImports: [...new Set(externalImports)],
        libPaths: [...new Set(libPaths)],
      });
    } catch (e) {
      console.log("Error analyzing file:", file, e.message);
    }
  }

  return results;
}

// -------------------------------------------------------------
// MAIN EXECUTION
// -------------------------------------------------------------
(async () => {
  console.log(`📂 Scanning repo: ${repoPath}`);

  const mapper = buildPackageMapper(repoPath);
  fs.writeFileSync(mapperOutput, JSON.stringify(mapper, null, 2));
  console.log(`✅ Package mapper saved to ${mapperOutput}`);

  const analysis = analyzeImports(repoPath, mapper);
  fs.writeFileSync(importsOutput, JSON.stringify(analysis, null, 2));
  console.log(`✅ Imports analysis saved to ${importsOutput}`);
})();
