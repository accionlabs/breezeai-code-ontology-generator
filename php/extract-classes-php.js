const Parser = require("tree-sitter");
const PHP = require("tree-sitter-php");
const fs = require("fs");
const path = require("path");

function extractClasses(filePath, repoPath = null) {
  const source = fs.readFileSync(filePath, "utf8");

  const parser = new Parser();
  // Use php_only for pure PHP parsing (no HTML mixed content)
  parser.setLanguage(PHP.php);

  const tree = parser.parse(source);

  const classes = [];

  traverse(tree.rootNode, (node) => {
    if (
      node.type === "class_declaration" ||
      node.type === "interface_declaration" ||
      node.type === "trait_declaration" ||
      node.type === "enum_declaration"
    ) {
      const classInfo = extractClassInfo(node, filePath, repoPath, source);
      if (classInfo?.name) {
        classes.push(classInfo);
      }
    }
  });

  return classes;
}

function traverse(node, cb) {
  cb(node);
  for (let i = 0; i < node.childCount; i++) {
    traverse(node.child(i), cb);
  }
}

function extractClassInfo(node, filePath, repoPath = null, source) {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;

  const name = getClassName(node, source);
  const { superClass, interfaces } = getInheritanceInfo(node, source);
  const typeKind = getTypeKind(node);

  const {
    constructorParams,
    methods
  } = extractClassMembers(node, source, typeKind);

  const { visibility, isAbstract, isFinal } = getClassModifiers(node, source);

  return {
    name,
    type: typeKind,
    visibility,
    isAbstract,
    isFinal,
    extends: superClass,
    implements: interfaces,
    constructorParams,
    methods,
    startLine,
    endLine
  };
}

function getTypeKind(node) {
  switch (node.type) {
    case "class_declaration":
      return "class";
    case "interface_declaration":
      return "interface";
    case "trait_declaration":
      return "trait";
    case "enum_declaration":
      return "enum";
    default:
      return "class";
  }
}

function getClassName(node, source) {
  const nameNode = node.childForFieldName("name");
  return nameNode ? source.slice(nameNode.startIndex, nameNode.endIndex) : null;
}

function getInheritanceInfo(node, source) {
  let superClass = null;
  const interfaces = [];

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);

    // Handle extends clause (base_clause in PHP grammar)
    if (child.type === "base_clause") {
      // First qualified_name is the parent class
      for (let j = 0; j < child.childCount; j++) {
        const baseChild = child.child(j);
        if (baseChild.type === "name" || baseChild.type === "qualified_name") {
          superClass = source.slice(baseChild.startIndex, baseChild.endIndex);
          break;
        }
      }
    }

    // Handle implements clause (class_interface_clause in PHP grammar)
    if (child.type === "class_interface_clause") {
      traverse(child, (n) => {
        if (n.type === "name" || n.type === "qualified_name") {
          const interfaceName = source.slice(n.startIndex, n.endIndex);
          if (!interfaces.includes(interfaceName)) {
            interfaces.push(interfaceName);
          }
        }
      });
    }
  }

  return { superClass, interfaces };
}

function getClassModifiers(node, source) {
  let visibility = "public"; // PHP default
  let isAbstract = false;
  let isFinal = false;

  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    const childText = source.slice(child.startIndex, child.endIndex).toLowerCase();

    if (child.type === "visibility_modifier" || child.type === "abstract_modifier" ||
        child.type === "final_modifier" || child.type === "modifier") {
      if (childText === "public") {
        visibility = "public";
      } else if (childText === "private") {
        visibility = "private";
      } else if (childText === "protected") {
        visibility = "protected";
      } else if (childText === "abstract") {
        isAbstract = true;
      } else if (childText === "final") {
        isFinal = true;
      }
    }
  }

  return { visibility, isAbstract, isFinal };
}

function extractClassMembers(classNode, source, typeKind) {
  const body = classNode.childForFieldName("body");
  if (!body) {
    return { constructorParams: [], methods: [] };
  }

  const methods = [];
  let constructorParams = [];

  for (let i = 0; i < body.childCount; i++) {
    const member = body.child(i);
    if (!member.isNamed) continue;

    // Method declaration
    if (member.type === "method_declaration") {
      const nameNode = member.childForFieldName("name");
      if (nameNode) {
        const methodName = source.slice(nameNode.startIndex, nameNode.endIndex);

        // Check if it's the constructor
        if (methodName === "__construct") {
          const paramsNode = member.childForFieldName("parameters");
          if (paramsNode) {
            constructorParams = extractParameterNames(paramsNode, source);
          }
          continue;
        }

        methods.push(methodName);
      }
    }
  }

  return { constructorParams, methods };
}

function extractParameterNames(paramsNode, source) {
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

module.exports = { extractClasses };
