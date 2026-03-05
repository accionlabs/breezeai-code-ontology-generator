const Parser = require("tree-sitter");
const PHP = require("tree-sitter-php").php;
const fs = require("fs");

function extractClasses(filePath, repoPath = null) {
  try {
    const source = fs.readFileSync(filePath, "utf8");

    const parser = new Parser();
    parser.setLanguage(PHP);

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
  } catch (error) {
    console.error(`Error extracting classes from ${filePath}:`, error);
    return [];
  }
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
  if (nameNode) {
    return source.slice(nameNode.startIndex, nameNode.endIndex);
  }

  // Try to find name by looking for identifier child
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child.type === "name") {
      return source.slice(child.startIndex, child.endIndex);
    }
  }

  return null;
}

function getInheritanceInfo(node, source) {
  let superClass = null;
  const interfaces = [];

  // Look for base_clause (extends)
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);

    // Handle extends clause
    if (child.type === "base_clause") {
      for (let j = 0; j < child.childCount; j++) {
        const extChild = child.child(j);
        if (extChild.type === "name" || extChild.type === "qualified_name") {
          superClass = source.slice(extChild.startIndex, extChild.endIndex);
        }
      }
    }

    // Handle class_interface_clause (implements)
    if (child.type === "class_interface_clause") {
      for (let j = 0; j < child.childCount; j++) {
        const implChild = child.child(j);
        if (implChild.type === "name" || implChild.type === "qualified_name") {
          interfaces.push(source.slice(implChild.startIndex, implChild.endIndex));
        }
      }
    }
  }

  return { superClass, interfaces };
}

function getClassModifiers(node, source) {
  let visibility = "public"; // PHP classes default to public
  let isAbstract = false;
  let isFinal = false;

  // Look through all children for modifiers
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    const childText = source.slice(child.startIndex, child.endIndex).toLowerCase();

    if (child.type === "abstract_modifier" || childText === "abstract") {
      isAbstract = true;
    }
    if (child.type === "final_modifier" || childText === "final") {
      isFinal = true;
    }
    if (child.type === "visibility_modifier") {
      if (childText === "public") {
        visibility = "public";
      } else if (childText === "private") {
        visibility = "private";
      } else if (childText === "protected") {
        visibility = "protected";
      }
    }
  }

  return { visibility, isAbstract, isFinal };
}

function extractClassMembers(classNode, source, typeKind) {
  const methods = [];
  let constructorParams = [];

  // Find declaration_list (class body)
  let body = classNode.childForFieldName("body");
  if (!body) {
    for (let i = 0; i < classNode.childCount; i++) {
      const child = classNode.child(i);
      if (child.type === "declaration_list") {
        body = child;
        break;
      }
    }
  }

  if (!body) {
    return { constructorParams: [], methods: [] };
  }

  for (let i = 0; i < body.childCount; i++) {
    const member = body.child(i);
    if (!member.isNamed) continue;

    // Methods
    if (member.type === "method_declaration") {
      const nameNode = member.childForFieldName("name");
      if (!nameNode) {
        // Try to find name by traversing
        for (let j = 0; j < member.childCount; j++) {
          const child = member.child(j);
          if (child.type === "name") {
            const methodName = source.slice(child.startIndex, child.endIndex);

            // Handle constructor
            if (methodName === "__construct") {
              constructorParams = extractConstructorParams(member, source);
            }

            methods.push(methodName);
            break;
          }
        }
      } else {
        const methodName = source.slice(nameNode.startIndex, nameNode.endIndex);

        // Handle constructor
        if (methodName === "__construct") {
          constructorParams = extractConstructorParams(member, source);
        }

        methods.push(methodName);
      }
    }
  }

  return { constructorParams, methods };
}

function extractConstructorParams(methodNode, source) {
  const params = [];

  // Look for formal_parameters
  let paramsNode = methodNode.childForFieldName("parameters");

  if (!paramsNode) {
    for (let i = 0; i < methodNode.childCount; i++) {
      const child = methodNode.child(i);
      if (child.type === "formal_parameters") {
        paramsNode = child;
        break;
      }
    }
  }

  if (!paramsNode) return [];

  for (let i = 0; i < paramsNode.childCount; i++) {
    const child = paramsNode.child(i);

    if (!child.isNamed) continue;

    if (
      child.type === "simple_parameter" ||
      child.type === "property_promotion_parameter" ||
      child.type === "variadic_parameter"
    ) {
      const nameNode = child.childForFieldName("name");
      if (nameNode) {
        let paramName = source.slice(nameNode.startIndex, nameNode.endIndex);
        // Remove $ prefix
        if (paramName.startsWith("$")) {
          paramName = paramName.substring(1);
        }
        params.push(paramName);
      } else {
        // Try to find variable_name
        traverse(child, (n) => {
          if (n.type === "variable_name" && n.parent === child) {
            let paramName = source.slice(n.startIndex, n.endIndex);
            if (paramName.startsWith("$")) {
              paramName = paramName.substring(1);
            }
            params.push(paramName);
          }
        });
      }
    }
  }

  return params;
}

module.exports = { extractClasses };
