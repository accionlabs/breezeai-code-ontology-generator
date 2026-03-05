const Parser = require("tree-sitter");
const PHP = require("tree-sitter-php");
const fs = require("fs");
const path = require("path");
const { truncateSourceCode } = require("../utils");

function extractFunctionsWithCalls(filePath, repoPath = null, captureSourceCode = false) {
  const source = fs.readFileSync(filePath, "utf8");

  const parser = new Parser();
  parser.setLanguage(PHP.php);

  const tree = parser.parse(source);

  const functions = [];

  traverse(tree.rootNode, (node) => {
    if (
      node.type === "function_definition" ||
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

  const { visibility, kind } = getFunctionModifiers(node, source);

  const result = {
    name,
    type: getFunctionType(node),
    visibility,
    kind,
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

function getFunctionType(node) {
  switch (node.type) {
    case "function_definition":
      return "function";
    case "method_declaration":
      return "method";
    default:
      return "function";
  }
}

function getFunctionModifiers(node, source) {
  let visibility = "public"; // PHP default
  let kind = "function";

  // Check if it's a method (inside a class)
  if (node.type === "method_declaration") {
    kind = "instance";

    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      const modText = source.slice(child.startIndex, child.endIndex).toLowerCase();

      if (child.type === "visibility_modifier" || child.type === "static_modifier" ||
          child.type === "abstract_modifier" || child.type === "final_modifier") {
        if (modText === "public") {
          visibility = "public";
        } else if (modText === "private") {
          visibility = "private";
        } else if (modText === "protected") {
          visibility = "protected";
        } else if (modText === "static") {
          kind = "static";
        } else if (modText === "abstract") {
          kind = "abstract";
        }
      }
    }
  }

  return { visibility, kind };
}

function extractFunctionParams(node, source) {
  const paramsNode = node.childForFieldName("parameters");
  if (!paramsNode) return [];

  const params = [];

  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = paramsNode.child(i);

    if (!child.isNamed) continue;

    if (child.type === "simple_parameter" || child.type === "property_promotion_parameter") {
      const nameNode = child.childForFieldName("name");
      if (nameNode) {
        let paramName = source.slice(nameNode.startIndex, nameNode.endIndex);
        // Remove $ prefix if present
        if (paramName.startsWith("$")) {
          paramName = paramName.substring(1);
        }
        params.push(paramName);
      }
    } else if (child.type === "variadic_parameter") {
      const nameNode = child.childForFieldName("name");
      if (nameNode) {
        let paramName = source.slice(nameNode.startIndex, nameNode.endIndex);
        if (paramName.startsWith("$")) {
          paramName = paramName.substring(1);
        }
        params.push("..." + paramName);
      }
    }
  }

  return params;
}

function getFunctionName(node, source) {
  const nameNode = node.childForFieldName("name");
  return nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : null;
}

function extractDirectCalls(funcNode, source) {
  const calls = [];

  traverse(funcNode, (node) => {
    if (node.type === "function_call_expression" ||
        node.type === "member_call_expression" ||
        node.type === "scoped_call_expression") {
      const callInfo = extractCallInfo(node, source);
      if (callInfo) {
        calls.push(callInfo);
      }
    }
  });

  return calls;
}

function extractCallInfo(node, source) {
  // Simple function call: foo()
  if (node.type === "function_call_expression") {
    const functionNode = node.childForFieldName("function");
    if (!functionNode) return null;

    if (functionNode.type === "name" || functionNode.type === "qualified_name") {
      return {
        name: source.slice(functionNode.startIndex, functionNode.endIndex),
        objectName: null,
        path: null
      };
    }
  }

  // Method call: $obj->method()
  if (node.type === "member_call_expression") {
    const nameNode = node.childForFieldName("name");
    const objectNode = node.childForFieldName("object");

    let objectName = null;
    if (objectNode) {
      objectName = source.slice(objectNode.startIndex, objectNode.endIndex);
      // Remove $ prefix if it's a variable
      if (objectName.startsWith("$")) {
        objectName = objectName.substring(1);
      }
    }

    return {
      name: nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : null,
      objectName,
      path: null
    };
  }

  // Static method call: ClassName::method()
  if (node.type === "scoped_call_expression") {
    const nameNode = node.childForFieldName("name");
    const scopeNode = node.childForFieldName("scope");

    return {
      name: nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : null,
      objectName: scopeNode ? source.slice(scopeNode.startIndex, scopeNode.endIndex) : null,
      path: null
    };
  }

  return null;
}

function traverse(node, cb) {
  cb(node);
  for (let i = 0; i < node.childCount; i++) {
    traverse(node.child(i), cb);
  }
}

// Extract use statements and require/include directives
function extractImports(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const parser = new Parser();
  parser.setLanguage(PHP.php);
  const tree = parser.parse(source);

  const imports = {
    importFiles: [],
    externalImports: []
  };

  traverse(tree.rootNode, (node) => {
    // Namespace use declarations: use App\Services\UserService;
    if (node.type === "namespace_use_declaration") {
      traverse(node, (n) => {
        if (n.type === "namespace_use_clause") {
          // Find the qualified_name or name child (not a named field)
          let nameNode = null;
          for (let k = 0; k < n.childCount; k++) {
            const child = n.child(k);
            if (child.type === "qualified_name" || child.type === "name") {
              nameNode = child;
              break;
            }
          }
          if (nameNode) {
            const importName = source.slice(nameNode.startIndex, nameNode.endIndex);
            imports.externalImports.push(importName);
          }
        }
      });
    }

    // Require/Include expressions
    if (node.type === "include_expression" ||
        node.type === "include_once_expression" ||
        node.type === "require_expression" ||
        node.type === "require_once_expression") {
      // Try to get the string argument
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child.type === "string" || child.type === "encapsed_string") {
          let pathValue = source.slice(child.startIndex, child.endIndex);
          // Remove quotes
          pathValue = pathValue.replace(/^['"]|['"]$/g, "");
          imports.importFiles.push(pathValue);
          break;
        }
      }
    }
  });

  imports.externalImports = [...new Set(imports.externalImports)];
  imports.importFiles = [...new Set(imports.importFiles)];

  return imports;
}

/**
 * Resolve call path using comprehensive index
 */
function resolveCallPath(call, index, currentFilePath) {
  const { classIndex, methodIndex } = index;

  // If we have an object name, try to resolve its type
  if (call.objectName) {
    // Try to resolve objectName as a class name (static method call)
    if (classIndex[call.objectName] && classIndex[call.objectName].length > 0) {
      if (methodIndex[call.name]) {
        const methodEntry = methodIndex[call.name].find(m => m.className === call.objectName);
        if (methodEntry) {
          return methodEntry.filePath;
        }
      }
      return classIndex[call.objectName][0];
    }
  }

  // Try to resolve by method name alone
  if (call.name && methodIndex[call.name]) {
    const methodEntries = methodIndex[call.name];

    if (methodEntries.length === 1) {
      return methodEntries[0].filePath;
    }

    const otherFileEntry = methodEntries.find(m => m.filePath !== currentFilePath);
    if (otherFileEntry) {
      return otherFileEntry.filePath;
    }

    return methodEntries[0].filePath;
  }

  return null;
}

function extractFunctionsAndCalls(filePath, repoPath, index = {}, captureSourceCode = false) {
  try {
    const functions = extractFunctionsWithCalls(filePath, repoPath, captureSourceCode);
    const currentFilePath = path.relative(repoPath, filePath);

    const { classIndex = {}, methodIndex = {} } = index;

    // Build local function map
    const localFunctionMap = new Map();
    functions.forEach(func => {
      localFunctionMap.set(func.name, currentFilePath);
    });

    // Resolve call paths
    functions.forEach(func => {
      func.calls.forEach(call => {
        if (localFunctionMap.has(call.name) && !call.objectName) {
          call.path = currentFilePath;
        } else {
          const resolvedPath = resolveCallPath(call, { classIndex, methodIndex }, currentFilePath);
          if (resolvedPath) {
            call.path = resolvedPath;
          }
        }

        // Clean up temporary fields
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
