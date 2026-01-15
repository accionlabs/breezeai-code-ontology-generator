const Parser = require("tree-sitter");
const Go = require("tree-sitter-go");
const fs = require("fs");
const path = require("path");

function extractFunctionsWithCalls(filePath, repoPath = null) {
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
      const funcInfo = extractFunctionInfo(node, filePath, repoPath, source);
      if (funcInfo.name) {
        functions.push(funcInfo);
      }
    }
  });

  return functions;
}

function extractFunctionInfo(node, filePath, repoPath = null, source) {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  const name = getFunctionName(node, source);
  const params = extractFunctionParams(node, source);
  const calls = extractDirectCalls(node, source);

  const { visibility, kind, receiver } = getFunctionModifiers(node, source);

  return {
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

function resolveImportPath(importSource, currentFilePath, repoPath) {
  // External package (standard library or third-party)
  if (!importSource.startsWith(".") && !importSource.startsWith("/")) {
    return null; // External package
  }

  // Relative path
  let resolvedPath = path.resolve(path.dirname(currentFilePath), importSource);

  // Go doesn't typically use file extensions in imports, but files are .go
  if (!path.extname(resolvedPath)) {
    // Check if it's a directory (package)
    if (fs.existsSync(resolvedPath) && fs.statSync(resolvedPath).isDirectory()) {
      return path.relative(repoPath, resolvedPath);
    }
    resolvedPath += ".go";
  }

  if (fs.existsSync(resolvedPath)) {
    return path.relative(repoPath, resolvedPath);
  }

  return null;
}

function extractFunctionsAndCalls(filePath, repoPath) {
  try {
    const functions = extractFunctionsWithCalls(filePath, repoPath);
    const imports = extractImports(filePath);

    const functionMap = new Map();

    // Map local functions
    functions.forEach(func => {
      functionMap.set(func.name, path.relative(repoPath, filePath));
    });

    // Map imports
    imports.forEach(imp => {
      const resolvedPath = resolveImportPath(imp.source, filePath, repoPath);
      const packageName = imp.alias || path.basename(imp.source);
      functionMap.set(packageName, resolvedPath || imp.source);
    });

    // Resolve call paths
    functions.forEach(func => {
      func.calls.forEach(call => {
        let resolvedPath = functionMap.get(call.name);

        if (!resolvedPath && call.objectName) {
          resolvedPath = functionMap.get(call.objectName);
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
