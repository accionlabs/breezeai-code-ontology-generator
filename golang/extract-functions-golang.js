const Parser = require("tree-sitter");
const Go = require("tree-sitter-go");
const fs = require("fs");
const path = require("path");
const { truncateSourceCode } = require("../utils");

// -------------------------------------------------------------
// Helpers for go.mod resolution
// -------------------------------------------------------------
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

function extractFunctionsWithCalls(filePath, repoPath = null, captureSourceCode = false) {
  const source = fs.readFileSync(filePath, "utf8");

  const parser = new Parser();
  parser.setLanguage(Go);

  const tree = parser.parse(source);

  const functions = [];

  traverse(tree.rootNode, (node) => {
    if (
      node.type === "function_declaration" ||
      node.type === "method_declaration"
    ) {
      const funcInfo = extractFunctionInfo(node, filePath, repoPath, source, captureSourceCode);
      if (funcInfo.name) {
        functions.push(funcInfo);
      }
    }
  });

  return functions;
}

function extractFunctionInfo(node, filePath, repoPath = null, source, captureSourceCode = false) {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  const name = getFunctionName(node, source);
  const params = extractFunctionParams(node, source);
  const calls = extractDirectCalls(node, source);

  const { visibility, kind, receiver } = getFunctionModifiers(node, source);

  const result = {
    name,
    type: node.type,
    visibility,
    kind,
    receiver,
    params,
    startLine,
    endLine,
    calls
  };

  if (captureSourceCode && source) {
    result.sourceCode = truncateSourceCode(source.slice(node.startIndex, node.endIndex));
  }

  return result;
}

function getFunctionModifiers(node, source) {
  let visibility = "public";
  let kind = "function";
  let receiver = null;

  // In Go, visibility is determined by the first letter of the function name
  const nameNode = node.childForFieldName("name");
  if (nameNode) {
    const name = source.slice(nameNode.startIndex, nameNode.endIndex);
    // If the first letter is lowercase, it's private (package-scoped)
    if (name[0] === name[0].toLowerCase()) {
      visibility = "private";
    }
  }

  // Check if it's a method (has a receiver)
  if (node.type === "method_declaration") {
    const receiverNode = node.childForFieldName("receiver");
    if (receiverNode) {
      kind = "method";
      // Extract receiver type
      traverse(receiverNode, (n) => {
        if (n.type === "type_identifier" || n.type === "pointer_type") {
          receiver = source.slice(n.startIndex, n.endIndex).replace(/\*/g, '');
        }
      });
    }
  }

  return { visibility, kind, receiver };
}

function extractFunctionParams(node, source) {
  const paramsNode = node.childForFieldName("parameters");
  if (!paramsNode) return [];

  const params = [];

  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = paramsNode.child(i);

    if (!child.isNamed) continue;

    if (child.type === "parameter_declaration") {
      const paramName = extractParamName(child, source);
      if (paramName) {
        params.push(paramName);
      }
    }
  }

  return params;
}

function extractParamName(node, source) {
  // parameter_declaration can have: name type OR just type (unnamed param)
  const nameNode = node.childForFieldName("name");

  if (nameNode) {
    return source.slice(nameNode.startIndex, nameNode.endIndex);
  }

  // For variadic parameters or unnamed parameters
  const text = source.slice(node.startIndex, node.endIndex);
  if (text.startsWith("...")) {
    return "...args";
  }

  // Return type as placeholder for unnamed params
  const typeNode = node.childForFieldName("type");
  if (typeNode) {
    const typeText = source.slice(typeNode.startIndex, typeNode.endIndex);
    return `_${typeText}`;
  }

  return null;
}

function getFunctionName(node, source) {
  const nameNode = node.childForFieldName("name");
  return nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : null;
}

function extractDirectCalls(funcNode, source) {
  const calls = [];

  traverse(funcNode, (node) => {
    if (node.type !== "call_expression") return;

    const fn = node.childForFieldName("function");
    if (!fn) return;

    // Simple identifier call: foo()
    if (fn.type === "identifier") {
      calls.push({
        name: source.slice(fn.startIndex, fn.endIndex),
        path: null
      });
      return;
    }

    // Selector expression: obj.Method() or package.Function()
    if (fn.type === "selector_expression") {
      const operandNode = fn.childForFieldName("operand");
      const fieldNode = fn.childForFieldName("field");

      let objectName = null;
      if (operandNode) {
        objectName = source.slice(operandNode.startIndex, operandNode.endIndex);
      }

      calls.push({
        name: fieldNode ? source.slice(fieldNode.startIndex, fieldNode.endIndex) : null,
        objectName: objectName,
        path: null
      });
    }
  });

  return calls;
}

function traverse(node, cb) {
  cb(node);
  for (let i = 0; i < node.childCount; i++) {
    traverse(node.child(i), cb);
  }
}

function extractImports(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const parser = new Parser();
  parser.setLanguage(Go);
  const tree = parser.parse(source);

  const imports = [];

  traverse(tree.rootNode, (node) => {
    if (node.type === "import_declaration") {
      // Single import: import "fmt"
      const importSpec = node.childForFieldName("spec");
      if (importSpec && importSpec.type === "import_spec") {
        const pathNode = importSpec.childForFieldName("path");
        if (pathNode) {
          const importPath = source.slice(pathNode.startIndex, pathNode.endIndex).replace(/["']/g, "");
          const nameNode = importSpec.childForFieldName("name");
          const alias = nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : null;
          imports.push({ source: importPath, alias, imported: [] });
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
                const importPath = source.slice(pathNode.startIndex, pathNode.endIndex).replace(/["']/g, "");
                const nameNode = spec.childForFieldName("name");
                const alias = nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : null;
                imports.push({ source: importPath, alias, imported: [] });
              }
            }
          }
        }
      }
    }
  });

  return imports;
}

function extractFunctionsAndCalls(filePath, repoPath, captureSourceCode = false) {
  try {
    const functions = extractFunctionsWithCalls(filePath, repoPath, captureSourceCode);
    const imports = extractImports(filePath);

    // Get go.mod info for module-based import resolution
    const goModPath = findGoMod(path.dirname(filePath));
    let moduleName = null;
    let moduleRoot = null;

    if (goModPath) {
      moduleRoot = path.dirname(goModPath);
      moduleName = readModuleName(goModPath);
    }

    // Map package names to their resolved file paths
    const packageToFiles = new Map();

    // Map imports to actual file paths
    imports.forEach(imp => {
      const pkgName = imp.alias || path.basename(imp.source);
      let resolvedFiles = [];

      // Local module import (e.g., github.com/user/project/pkg)
      if (moduleName && imp.source.startsWith(moduleName)) {
        const rel = imp.source.slice(moduleName.length);
        const pkgDir = path.join(moduleRoot, rel);

        if (fs.existsSync(pkgDir) && fs.statSync(pkgDir).isDirectory()) {
          resolvedFiles = fs.readdirSync(pkgDir)
            .filter(f => f.endsWith(".go") && !f.endsWith("_test.go"))
            .map(f => path.relative(repoPath, path.join(pkgDir, f)));
        }
      }

      // Relative import (rare in Go)
      if (resolvedFiles.length === 0 && imp.source.startsWith(".")) {
        const abs = path.resolve(path.dirname(filePath), imp.source);
        if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
          resolvedFiles = fs.readdirSync(abs)
            .filter(f => f.endsWith(".go") && !f.endsWith("_test.go"))
            .map(f => path.relative(repoPath, path.join(abs, f)));
        }
      }

      if (resolvedFiles.length > 0) {
        packageToFiles.set(pkgName, resolvedFiles);
      }
    });

    // Map local functions to current file
    const localFunctionMap = new Map();
    functions.forEach(func => {
      localFunctionMap.set(func.name, path.relative(repoPath, filePath));
    });

    // Resolve call paths
    functions.forEach(func => {
      func.calls.forEach(call => {
        let resolvedPath = null;

        // Check if it's a local function call
        if (!call.objectName) {
          resolvedPath = localFunctionMap.get(call.name);
        } else {
          // It's a package.Function() or receiver.Method() call
          const pkgFiles = packageToFiles.get(call.objectName);
          if (pkgFiles && pkgFiles.length > 0) {
            // Use the first file as representative (or could search for the actual function)
            resolvedPath = pkgFiles[0];
          }
        }

        if (resolvedPath) {
          call.path = resolvedPath;
        }

        delete call.objectName;
      });
    });

    return functions;
  } catch (error) {
    console.error(`Error processing ${filePath}:`, error);
    return [];
  }
}

module.exports = { extractFunctionsAndCalls, extractImports };
