const fs = require("fs");
const {
  functionHandler,
  classHandler,
  expressionHandler,
  importHandler,
} = require("./utils")

NODE_FORMATTER_MAP = {
}


function* traverseTree(tree, sourceCode) {
  // Walking through tree
  const cursor = tree.walk();

  let reachedRoot = false;
  let parentClassID = null;
  let parentFunctionID = null;
  let parentFunctionEndIndex = 0;

  while (!reachedRoot) {
    // Nodes with ignored patterns and their children are not processed
    const ignoredPatterns = ["{", "}", ";"];
    const isIgnored = ignoredPatterns.includes(cursor.nodeType)

    let currentNode = cursor.currentNode;
    // TreeCursor.currentNode is a property in Node but a function in the browser
    // https://github.com/tree-sitter/tree-sitter/issues/2195
    if (typeof currentNode === "function") {
      currentNode = currentNode();
    }

    if (!isIgnored) {
      // Get the name/text of the node from the source string
      // .substring uses the start and end offsets provided by tree-sitter
      const nodeText = sourceCode.substring(
        currentNode.startIndex,
        currentNode.endIndex
      );
      const loc = currentNode.endIndex - currentNode.startIndex + 1

      const currentNodeID = currentNode.id
      if (currentNode.type == "package_statement") {
        parentClassID = currentNodeID;
      }
      if (currentNode.type == "subroutine_declaration_statement") {
        parentFunctionID = currentNodeID;
        parentFunctionEndIndex = currentNode.endIndex;
      } else if (parentFunctionEndIndex < currentNode.endIndex) {
        parentFunctionID = null;
        parentFunctionEndIndex = 0;
      }
      
      // Yield te processed output
      yield {
        node: currentNode,
        type: currentNode.type,
        id: currentNodeID,
        text: nodeText,
        loc,
        parentClassID,
        parentFunctionID 
      };
    }

    // Children are accessed only if the node is of type "source_file" or "block"
    if ( currentNode.type == "block" || currentNode.type == "source_file") {
      if (cursor.gotoFirstChild()) {
        continue;
      }
    }

    // If current Node is not of type "source_file" it looks for descendants
    // of type "block". If such node exists, cursor is moved to that node.
    if (currentNode.type != "source_file") {
      const blockDescendants = currentNode.descendantsOfType("block");
      if (blockDescendants.length > 0) {
        cursor.gotoFirstChildForIndex(blockDescendants[0].startIndex);
        if (cursor.gotoFirstChild()) {
          continue;
        }
      }
    }

    // Go to next sibling if exists
    if (cursor.gotoNextSibling()) {
      continue;
    }

    // Handle retracing - retraces until it reaches root node or if next sibling
    // is available.
    let retracing = true;
    while (retracing) {
      if (!cursor.gotoParent()) {
        retracing = false;
        reachedRoot = true;
      }

      if (cursor.gotoNextSibling()) {
        retracing = false;
      }
    }
  }
}

function treeParser(tree, sourceCode) {
  const codeMap = {
    importFiles: {},
    externalImports: {},
    functions: {},
    classes: {},
    classMethods: {},
    statements: {},
    classStatements: {},
    functionStatements: {},
  }

  // Loops through traverseTree outputs
  for (const item of traverseTree(tree, sourceCode)) {

    // Handle use statements
    if (item.type == "use_statement") {
      codeMap.externalImports[item.id] = importHandler(item, sourceCode);
    }

    // Handle functions/subroutines
    if (item.type == "subroutine_declaration_statement") {
      const functionData = functionHandler(item, sourceCode);
      if (item.parentClassID) {
        (codeMap.classMethods[item.parentClassID] ??= []).push(
          functionData.name
        );
      }
      codeMap.functions[item.id] = functionData;
    }

    // Handle classes/packages
    if (item.type == "package_statement") {
      codeMap.classes[item.id] = classHandler(item, sourceCode);
    }

    // Handle statements    
    if (item.type == "expression_statement") {
      expressionData = expressionHandler(item, sourceCode);
      codeMap.statements[item.id] = expressionData;
      if (item.parentFunctionID) {
        (codeMap.functionStatements[item.parentFunctionID] ??= []).push(
          expressionData
        );
      } else if (item.parentClassID) {
        (codeMap.classStatements[item.parentFunctionID] ??= []).push(
          expressionData
        );
      } else {
        codeMap.statements[item.id] = expressionData;
      }
    }    
  }

  return codeMap;
}

let sourceCache = {};

function parseSource(filePath) {
  if (sourceCache[filePath]) {
    return sourceCache[filePath];
  }
  const source = fs.readFileSync(filePath, "utf8").replace(/\0/g, "");
  sourceCache[filePath] = source;
  return source;
}

function parseFile(filePath, parser) {
  const sourceCode = parseSource(filePath);
  const tree = parser.parse(sourceCode);

  const {
    importFiles,
    externalImports,
    functions,
    classes,
    statements,
  } = treeParser(tree, sourceCode);

  return {
    path: filePath,
    language: "perl",
    type: "code",
    loc: tree.rootNode.endPosition.row,
    importFiles: Object.values(importFiles),
    externalImports: Object.values(externalImports),
    functions: Object.values(functions),
    classes: Object.values(classes),
    statements: Object.values(statements), 
  };
}

module.exports = { parseFile };
