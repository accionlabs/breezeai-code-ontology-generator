#!/usr/bin/env node
/**
 * Salesforce Apex Analyzer
 * Usage: node file-tree-mapper-salesforce.js <repoPath> <importsOutput.json>
 */

const fs = require("fs");
const path = require("path");
const glob = require("glob");
const Parser = require("tree-sitter");
const apex = require("tree-sitter-sfapex");
const { extractFunctionsAndCalls, extractReferences } = require("./extract-functions-salesforce");
const { extractClasses } = require("./extract-classes-salesforce");

// Wrapper function to analyze Salesforce Apex repository
function analyzeSalesforceRepo(repoPath) {
  const classIndex = buildClassIndex(repoPath);
  const analysis = analyzeApexFiles(repoPath, classIndex);
  return analysis;
}

// -------------------------------------------------------------
// Initialize parser
// -------------------------------------------------------------
const parser = new Parser();
parser.setLanguage(apex.apex);

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
// Step 1: Get Apex files
// -------------------------------------------------------------
function getApexFiles() {
  return glob.sync(`${repoPath}/**/*.{cls,trigger}`, {
    ignore: [
      `${repoPath}/**/node_modules/**`,
      `${repoPath}/**/build/**`,
      `${repoPath}/**/dist/**`,
      `${repoPath}/**/.sfdx/**`
    ],
  });
}

// -------------------------------------------------------------
// Step 2: Build class index (for resolving references)
// -------------------------------------------------------------
function buildClassIndex(repoPath) {
  const apexFiles = getApexFiles();
  const classIndex = {};

  console.log("📋 Building class index...");

  for (const file of apexFiles) {
    try {
      const sourceText = fs.readFileSync(file, "utf8").replace(/\0/g, "");
      if (!sourceText.trim()) continue;

      const tree = parser.parse(sourceText);
      const relPath = path.relative(repoPath, file);

      // Helper function to recursively index classes with qualified names
      function indexClasses(node, parentClassName = null) {
        if (node.type === "class_declaration" || node.type === "interface_declaration") {
          const nameNode = node.childForFieldName("name");
          if (nameNode) {
            const className = getNodeText(nameNode, sourceText);

            if (parentClassName) {
              // Inner class - index with fully qualified name
              const qualifiedName = `${parentClassName}.${className}`;
              classIndex[qualifiedName] = relPath;
            } else {
              // Top-level class - index with simple name
              classIndex[className] = relPath;
            }

            // Continue traversing for nested inner classes
            const body = node.childForFieldName("body");
            if (body) {
              for (let i = 0; i < body.childCount; i++) {
                const child = body.child(i);
                const currentClassName = parentClassName ? `${parentClassName}.${className}` : className;
                indexClasses(child, currentClassName);
              }
            }
          }
        } else {
          // Keep traversing
          for (let i = 0; i < node.childCount; i++) {
            indexClasses(node.child(i), parentClassName);
          }
        }
      }

      indexClasses(tree.rootNode, null);
    } catch (err) {
      console.log("Error indexing file:", file);
    }
  }

  return classIndex;
}

// -------------------------------------------------------------
// Step 3: Extract type references from Apex files
// -------------------------------------------------------------
function extractTypeReferences(filePath) {
  const sourceText = fs.readFileSync(filePath, "utf8").replace(/\0/g, "");
  if (!sourceText.trim()) return { references: [], topLevelClasses: [] };

  const tree = parser.parse(sourceText);
  const references = new Set();
  const topLevelClasses = [];

  // First, collect all top-level classes in this file
  function collectTopLevelClasses(node, depth = 0) {
    if (node.type === "class_declaration" || node.type === "interface_declaration") {
      const nameNode = node.childForFieldName("name");
      if (nameNode && depth === 0) {
        topLevelClasses.push(getNodeText(nameNode, sourceText));
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      collectTopLevelClasses(node.child(i), node.type === "class_declaration" || node.type === "interface_declaration" ? depth + 1 : depth);
    }
  }

  collectTopLevelClasses(tree.rootNode);

  // Then extract references, including qualified names
  traverse(tree.rootNode, (node) => {
    // Look for scoped_type_identifier (qualified names like OuterClass.InnerClass)
    if (node.type === "scoped_type_identifier") {
      const fullTypeName = getNodeText(node, sourceText);
      if (!isPrimitiveType(fullTypeName)) {
        references.add(fullTypeName);
      }
    }

    // Look for type identifiers (simple class references)
    if (node.type === "type_identifier") {
      const typeName = getNodeText(node, sourceText);

      // Filter out primitive types
      if (!isPrimitiveType(typeName)) {
        references.add(typeName);
      }
    }

    // Look for object creation (new ClassName())
    if (node.type === "object_creation_expression") {
      const typeNode = node.childForFieldName("type");
      if (typeNode) {
        if (typeNode.type === "scoped_type_identifier") {
          const fullTypeName = getNodeText(typeNode, sourceText);
          if (!isPrimitiveType(fullTypeName)) {
            references.add(fullTypeName);
          }
        } else if (typeNode.type === "type_identifier") {
          const typeName = getNodeText(typeNode, sourceText);
          if (!isPrimitiveType(typeName)) {
            references.add(typeName);
          }
        }
      }
    }
  });

  return { references: Array.from(references), topLevelClasses };
}

function isPrimitiveType(typeName) {
  const primitives = [
    'String', 'Integer', 'Long', 'Double', 'Decimal', 'Boolean',
    'Date', 'Datetime', 'Time', 'Blob', 'ID', 'Object',
    'List', 'Set', 'Map', 'void', 'SObject'
  ];
  return primitives.includes(typeName);
}

// -------------------------------------------------------------
// Step 4: Analyze Apex files
// -------------------------------------------------------------
function analyzeApexFiles(repoPath, classIndex) {
  console.log("Started analyzing Apex files...");
  const apexFiles = getApexFiles();

  const results = [];
  const totalFiles = apexFiles.length;
  const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinnerIndex = 0;

  console.log(`\n📊 Total files to process: ${totalFiles}\n`);

  for (let i = 0; i < apexFiles.length; i++) {
    const file = apexFiles[i];

    try {
      // Show progress with spinner
      const percentage = ((i / totalFiles) * 100).toFixed(1);
      const spinner = spinnerFrames[spinnerIndex % spinnerFrames.length];
      const fileName = path.relative(repoPath, file);

      process.stdout.write(`\r${spinner} Processing: ${i}/${totalFiles} (${percentage}%) - ${fileName.substring(0, 60).padEnd(60, ' ')}`);
      spinnerIndex++;

      const { references, topLevelClasses } = extractTypeReferences(file);
      const importFiles = [];
      const externalImports = [];
      const currentFilePath = path.relative(repoPath, file);

      // Resolve references to local or external classes
      for (let ref of references) {
        let resolved = false;

        // 1. Check if it's already a qualified name (e.g., "OuterClass.InnerClass")
        if (ref.includes('.')) {
          if (classIndex[ref] && classIndex[ref] !== currentFilePath) {
            importFiles.push(classIndex[ref]);
            resolved = true;
          }
        }

        // 2. If not resolved, check if it's a simple name
        if (!resolved) {
          // First, check if it could be an inner class of any top-level class in current file
          let foundInCurrentFile = false;
          for (const topLevel of topLevelClasses) {
            const qualifiedName = `${topLevel}.${ref}`;
            if (classIndex[qualifiedName] && classIndex[qualifiedName] !== currentFilePath) {
              importFiles.push(classIndex[qualifiedName]);
              resolved = true;
              foundInCurrentFile = true;
              break;
            }
          }

          // If not an inner class of current file, check if it's a top-level class
          if (!foundInCurrentFile && classIndex[ref] && classIndex[ref] !== currentFilePath) {
            importFiles.push(classIndex[ref]);
            resolved = true;
          }
        }

        // 3. If still not resolved, it's an external/standard Salesforce class
        if (!resolved) {
          externalImports.push(ref);
        }
      }

      // Extract functions and classes
      const functions = extractFunctionsAndCalls(file, repoPath, classIndex);
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
module.exports = { analyzeSalesforceRepo };

// -------------------------------------------------------------
// MAIN EXECUTION
// -------------------------------------------------------------
if (require.main === module) {
  if (process.argv.length < 4) {
    console.error(
      "Usage: node salesforce/file-tree-mapper-salesforce.js <repoPath> <importsOutput.json>"
    );
    process.exit(1);
  }

  const repoPath = path.resolve(process.argv[2]);
  const importsOutput = path.resolve(process.argv[3]);

  console.log(`📂 Scanning Salesforce Apex repo: ${repoPath}`);

  const analysis = analyzeSalesforceRepo(repoPath);
  fs.writeFileSync(importsOutput, JSON.stringify(analysis, null, 2));
  console.log(`✅ Final output written to → ${importsOutput}`);
}
