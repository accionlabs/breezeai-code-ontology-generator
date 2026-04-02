const Parser = require("tree-sitter");
const fs = require("fs");
const path = require("path");
const {
  truncateSourceCode,
  containsDbQuery,
  getDbFromMethod,
} = require("../utils");

let sharedParser = null;
let Perl = null;
let sourceCache = {};

async function initParser() {
  if (!sharedParser) {
    Perl = await import("tree-sitter-perl");
    sharedParser = new Parser();
    sharedParser.setLanguage(Perl.default);
  }
  return sharedParser;
}

function parseSource(filePath) {
  if (sourceCache[filePath]) {
    return sourceCache[filePath];
  }
  const source = fs.readFileSync(filePath, "utf8").replace(/\0/g, "");
  sourceCache[filePath] = source;
  return source;
}

const STATEMENT_TYPES = [
  "expression_statment",
];

async function extractFunctionsWithCalls(
  filePath,
  repoPath,
  captureSourceCode = false,
  captureStatements = false,
) {
  await initParser();
  const source = parseSource(filePath);
  const tree = sharedParser.parse(source);

  const packages = [];
  traverse(tree.rootNode, (node) => {
    if (node.type === "package_statement") {
      packages.push({
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
      });
    }
  });

  const functions = [];

  traverse(tree.rootNode, (node) => {
    if (
      node.type === "subroutine_declaration_statement" ||
      node.type === "subroutine_definition"
    ) {
      const funcInfo = extractFunctionInfo(
        node,
        source,
        packages,
        captureSourceCode,
        captureStatements,
      );
      if (funcInfo.name) {
        functions.push(funcInfo);
      }
    }
  });

  return functions;
}

function extractFunctionInfo(
  node,
  source,
  packages,
  captureSourceCode = false,
  captureStatements = false,
) {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  const name = getFunctionName(node, source);
  const params = extractFunctionParams(node, source);
  const calls = extractDirectCalls(node, source);
  const prototype = extractPrototype(node, source);

  let visibility = "public";
  let kind = "function";

  if (name && name.startsWith("_") && !name.startsWith("__")) {
    visibility = "protected";
  } else if (name && name.startsWith("__") && !name.endsWith("__")) {
    visibility = "private";
  }

  const isMethod = packages.some((pkg) => startLine >= pkg.startLine);
  if (isMethod) {
    kind = "method";
  }

  const statements = captureStatements ? extractStatements(node, source) : [];

  const result = {
    name,
    type: node.type,
    visibility,
    kind,
    params,
    prototype,
    startLine,
    endLine,
    calls,
    statements,
  };

  if (captureSourceCode && source) {
    result.sourceCode = truncateSourceCode(
      source.slice(node.startIndex, node.endIndex),
    );
  }

  return result;
}

function extractFunctionParams(node, source) {
  const paramsNode =
    node.childForFieldName("parameters") ||
    node.namedChildren.find((n) => n.type === "parameter_list");
  if (!paramsNode) return [];

  const params = [];

  traverse(paramsNode, (child) => {
    if (child.type === "optional_parameter") {
      const nameNode =
        child.childForFieldName("name") ||
        child.namedChildren.find((n) => n.type === "identifier");
      if (nameNode) {
        const paramName = source.slice(nameNode.startIndex, nameNode.endIndex);
        params.push(paramName);
      }
    } else if (child.type === "simple_parameter") {
      const nameNode =
        child.childForFieldName("name") ||
        child.namedChildren.find((n) => n.type === "identifier");
      if (nameNode) {
        const paramName = source.slice(nameNode.startIndex, nameNode.endIndex);
        params.push(paramName);
      }
    } else if (child.type === "bareword" || child.type === "identifier") {
      const parent = child.parent;
      if (
        parent &&
        (parent.type === "parameter_list" || parent.type === "parameters")
      ) {
        params.push(source.slice(child.startIndex, child.endIndex));
      }
    }
  });

  return params;
}

function extractPrototype(node, source) {
  const protoNode =
    node.childForFieldName("prototype") ||
    node.namedChildren.find((n) => n.type === "prototype");
  if (protoNode) {
    return source.slice(protoNode.startIndex, protoNode.endIndex);
  }
  return null;
}

function getFunctionName(node, source) {
  let nameNode = node.childForFieldName("name");
  if (!nameNode) {
    nameNode =
      node.namedChildren.find((n) => n.type === "bareword") ||
      node.namedChildren.find((n) => n.type === "identifier");
  }
  return nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : null;
}

function extractDirectCalls(funcNode, source) {
  const calls = [];

  traverse(funcNode, (node) => {
    if (node.type === "method_call_expression") {
      const methodNode = node.childForFieldName("method");
      const objectNode = node.childForFieldName("object");

      let objectName = null;
      if (objectNode) {
        objectName = source.slice(objectNode.startIndex, objectNode.endIndex);
      }

      if (methodNode) {
        calls.push({
          name: source.slice(methodNode.startIndex, methodNode.endIndex),
          objectName: objectName,
          path: null,
        });
      }
    }

    if (node.type === "function_call_expression" || node.type === "ambiguous_function_call_expression") {
      const fnNode = node.childForFieldName("function");
      if (fnNode) {
        calls.push({
          name: source.slice(fnNode.startIndex, fnNode.endIndex),
          path: null,
        });
      }
    }
  });

  return calls;
}

async function extractImports(filePath) {
  await initParser();
  const source = parseSource(filePath);
  const tree = sharedParser.parse(source);

  const imports = [];

  traverse(tree.rootNode, (node) => {
    if (node.type === "use_statement") {
      const moduleNode =
        node.childForFieldName("module") ||
        node.namedChildren.find((n) => n.type === "package_name") ||
        node.namedChildren.find((n) => n.type === "identifier");

      if (moduleNode) {
        const moduleName = source
          .slice(moduleNode.startIndex, moduleNode.endIndex)
          .trim();

        if (moduleName === "lib") {
          const versionNode = node.childForFieldName("version");
          if (versionNode) {
            const version = source
              .slice(versionNode.startIndex, versionNode.endIndex)
              .trim();
            imports.push({
              source: version.replace(/['"]/g, ""),
              isLib: true,
              imported: [],
            });
          }
        } else {
          imports.push({ source: moduleName, isLib: false, imported: [] });
        }
      }

      const importNode = node.childForFieldName("imports");
      if (importNode) {
        const importedNames = [];
        traverse(importNode, (child) => {
          if (child.type === "identifier" || child.type === "bareword") {
            importedNames.push(source.slice(child.startIndex, child.endIndex));
          }
        });
        if (importedNames.length > 0) {
          const lastImport = imports[imports.length - 1];
          if (lastImport) {
            lastImport.imported = importedNames;
          }
        }
      }
    }

    if (node.type === "require_statement") {
      const moduleNode =
        node.childForFieldName("module") ||
        node.namedChildren.find((n) => n.type === "package_name") ||
        node.namedChildren.find((n) => n.type === "identifier");

      if (moduleNode) {
        const moduleName = source
          .slice(moduleNode.startIndex, moduleNode.endIndex)
          .trim();
        imports.push({ source: moduleName, isLib: false, imported: [] });
      } else {
        const stringNode = node.namedChildren.find((n) => n.type === "string");
        if (stringNode) {
          const moduleName = source
            .slice(stringNode.startIndex, stringNode.endIndex)
            .replace(/['"]/g, "")
            .trim();
          imports.push({ source: moduleName, isLib: false, imported: [] });
        }
      }
    }

    if (node.type === "do_statement") {
      const fileNode = node.namedChildren.find((n) => n.type === "string");
      if (fileNode) {
        const fileName = source
          .slice(fileNode.startIndex, fileNode.endIndex)
          .replace(/['"]/g, "")
          .trim();
        imports.push({
          source: fileName,
          isLib: false,
          imported: [],
          isDo: true,
        });
      }
    }
  });

  return imports;
}

function extractStatements(node, source) {
  const body =
    node.childForFieldName("block") ||
    node.namedChildren.find((n) => n.type === "block");
  if (!body) return [];

  const statements = [];
  for (let i = 0; i < body.namedChildCount; i++) {
    const child = body.namedChild(i);
    if (!STATEMENT_TYPES.includes(child.type)) continue;
    statements.push({
      type: child.type,
      text: source.slice(child.startIndex, child.endIndex).slice(0, 200),
      startLine: child.startPosition.row + 1,
      endLine: child.endPosition.row + 1,
    });
  }

  return statements;
}

function traverse(node, cb) {
  cb(node);
  for (let i = 0; i < node.namedChildCount; i++) {
    traverse(node.namedChild(i), cb);
  }
}

async function extractFunctionsAndCalls(
  filePath,
  repoPath,
  packageMapper = null,
  captureSourceCode = false,
  captureStatements = false,
) {
  try {
    sourceCache = {};
    const functions = await extractFunctionsWithCalls(
      filePath,
      repoPath,
      captureSourceCode,
      captureStatements,
    );
    const imports = await extractImports(filePath);

    const functionMap = new Map();

    functions.forEach((func) => {
      functionMap.set(func.name, path.relative(repoPath, filePath));
    });

    imports.forEach((imp) => {
      if (imp.imported) {
        imp.imported.forEach((imported) => {
          if (packageMapper && packageMapper[imp.source]) {
            functionMap.set(imported, packageMapper[imp.source]);
          } else {
            functionMap.set(imported, imp.source);
          }
        });
      }
    });

    functions.forEach((func) => {
      func.calls.forEach((call) => {
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

async function extractFileStatements(filePath) {
  await initParser();
  const source = parseSource(filePath);
  const tree = sharedParser.parse(source);
  const statements = [];

  for (let i = 0; i < tree.rootNode.namedChildCount; i++) {
    const child = tree.rootNode.namedChild(i);
    if (!STATEMENT_TYPES.includes(child.type)) continue;
    statements.push({
      type: child.type,
      text: source.slice(child.startIndex, child.endIndex).slice(0, 200),
      startLine: child.startPosition.row + 1,
      endLine: child.endPosition.row + 1,
    });
  }

  return statements;
}

module.exports = {
  extractFunctionsAndCalls,
  extractImports,
  extractFileStatements,
  initParser,
};
