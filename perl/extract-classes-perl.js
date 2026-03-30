const Parser = require("tree-sitter");
const fs = require("fs");
const path = require("path");
const { containsDbQuery, getDbFromMethod } = require("../utils");

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

async function extractPackages(filePath, repoPath, captureStatements = false) {
  try {
    await initParser();
    const source = parseSource(filePath);
    const tree = sharedParser.parse(source);

    const packages = [];
    const allSubroutines = [];
    const allStatements = [];

    traverse(tree.rootNode, (node) => {
      if (
        node.type === "subroutine_declaration_statement" ||
        node.type === "subroutine_definition"
      ) {
        allSubroutines.push(node);
      }
      if (captureStatements) {
        if (node.type === "expression_statement") {
          allStatements.push(node);
        }
      }
    });

    traverse(tree.rootNode, (node) => {
      if (node.type === "package_statement") {
        const pkgInfo = extractPackageInfo(
          node,
          source,
          allSubroutines,
          allStatements,
          captureStatements,
        );
        if (pkgInfo.name) {
          packages.push(pkgInfo);
        }
      }
    });

    return packages;
  } catch (error) {
    console.error(`Error extracting packages from ${filePath}:`, error);
    return [];
  }
}

function extractPackageInfo(
  node,
  source,
  allSubroutines,
  allStatements,
  captureStatements = false,
) {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  const namespaceNode =
    node.childForFieldName("namespace") ||
    node.namedChildren.find((n) => n.type === "package_name") ||
    node.namedChildren.find((n) => n.type === "package") ||
    node.namedChildren.find((n) => n.type === "identifier");
  const name = namespaceNode
    ? source.slice(namespaceNode.startIndex, namespaceNode.endIndex).trim()
    : null;

  const versionNode =
    node.childForFieldName("version") ||
    node.namedChildren.find((n) => n.type === "version");
  const version = versionNode
    ? source.slice(versionNode.startIndex, versionNode.endIndex).trim()
    : null;

  const baseClass = extractBaseClass(node, source);
  const methods = extractPackageMethodsFromList(node, source, allSubroutines);
  const constructorParams = extractConstructorParamsFromList(source, methods);
  const statements = captureStatements
    ? extractPackageStatementsFromList(source, allStatements)
    : [];

  return {
    name,
    type: "package",
    visibility: "public",
    isAbstract: false,
    extends: baseClass,
    implements: [],
    version,
    constructorParams,
    methods,
    statements,
    startLine,
    endLine,
  };
}

function extractBaseClass(node, source) {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === "base_clause" || child.type === "parent") {
      const classNode =
        child.namedChildren.find((n) => n.type === "package_name") ||
        child.namedChildren.find((n) => n.type === "identifier");
      if (classNode) {
        return source.slice(classNode.startIndex, classNode.endIndex).trim();
      }
    }
  }
  return null;
}

function extractPackageMethodsFromList(pkgNode, source, allSubroutines) {
  const methods = [];
  const pkgEndLine = pkgNode.endPosition.row + 1;

  for (const subNode of allSubroutines) {
    const subStartLine = subNode.startPosition.row + 1;

    if (subStartLine >= pkgEndLine) {
      let nameNode = subNode.childForFieldName("name");
      if (!nameNode) {
        nameNode =
          subNode.namedChildren.find((n) => n.type === "bareword") ||
          subNode.namedChildren.find((n) => n.type === "identifier");
      }
      if (nameNode) {
        const methodName = source.slice(nameNode.startIndex, nameNode.endIndex);
        if (
          methodName &&
          methodName !== "BEGIN" &&
          methodName !== "END" &&
          methodName !== "INIT" &&
          methodName !== "CHECK" &&
          methodName !== "UNITCHECK"
        ) {
          let visibility = "public";
          if (methodName.startsWith("_") && !methodName.startsWith("__")) {
            visibility = "protected";
          } else if (
            methodName.startsWith("__") &&
            !methodName.endsWith("__")
          ) {
            visibility = "private";
          }
          methods.push(methodName);
        }
      }
    }
  }

  return methods;
}

function extractConstructorParamsFromList(source, methods) {
  return [];
}

function extractPackageStatementsFromList(source, statements) {
  const result = [];
  for (const stmt of statements) {
    let name = null;
    if (stmt.type === "expression_statement") {
      const nameNode =
        stmt.childForFieldName("name") ||
        stmt.namedChildren.find((n) => n.type === "identifier") ||
        stmt.namedChildren.find((n) => n.type === "variable_name");
      if (nameNode) {
        name = source.slice(nameNode.startIndex, nameNode.endIndex);
      }
    }
    result.push({
      type: stmt.type,
      name,
      text: source.slice(stmt.startIndex, stmt.endIndex),
      startLine: stmt.startPosition.row + 1,
      endLine: stmt.endPosition.row + 1,
    });
  }
  return result;
}

function traverse(node, cb) {
  cb(node);
  for (let i = 0; i < node.namedChildCount; i++) {
    traverse(node.namedChild(i), cb);
  }
}


module.exports = { extractPackages, initParser };
