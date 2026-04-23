function functionHandler(nodeData, sourceCode) {
  node = nodeData.node

  const nameNode = node.namedChildren.find((n) => n.type === "bareword")
  name = nameNode ? sourceCode.slice(nameNode.startIndex, nameNode.endIndex) : null;
  
  const functionData = {
    name,
    type: node.type,
    visibility: "public", // [FIXME]
    kind: nodeData.parentClassID ? "method": "function",
    params: [],
    returnType: null,
    generics: null,
    startLine: node.startPosition.row,
    endLine: node.endPosition.row,
    calls: [],
    statements: [],
    sourceCode: nodeData.text,
  }

  return functionData;
}


function classHandler(nodeData, sourceCode) {
  node = nodeData.node
  const nameNode = node.namedChildren.find((n) => n.type === "package")
  name = nameNode ? sourceCode.slice(nameNode.startIndex, nameNode.endIndex) : null;

  const classData = {
    name,
    type: node.type,
    visibility: "public", // [FIXME]
    isAbstract: false, // [FIXME]
    generics: null, // [FIXME]
    extends: null, // [FIXME]
    implements: [], // [FIXME]
    constructorParams: [],
    methods: [],
    statements: [],
    startLine: node.startPosition.row,
    endLine: node.endPosition.row, // [FIXME]
  }
  return classData;
}


function expressionHandler(nodeData, sourceCode) {
  node = nodeData.node
  
  const expressionData = {
    type: node.type,
    text: nodeData.text,
    startLine: 35,
    endLine: 35,
    startLine: node.startPosition.row,
    endLine: node.endPosition.row, // [FIXME]
  }
  return expressionData;
}


function importHandler(nodeData, sourceCode) {
  const moduleNode = nodeData.node.childForFieldName("module");
  let moduleName = null;
  if (moduleNode) {
    moduleName = sourceCode
          .slice(moduleNode.startIndex, moduleNode.endIndex)
          .trim();
  }
  return moduleName;
}

module.exports = {
  functionHandler,
  classHandler,
  expressionHandler,
  importHandler,
}
