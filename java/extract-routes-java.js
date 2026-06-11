/**
 * Java web-route extractor (static, tree-sitter based)
 *
 * Detects HTTP route / endpoint declarations for the two dominant Java REST
 * stacks and returns them as structured route objects (same shape as the
 * Python route extractor, so they flow through the identical HAS_STATEMENT
 * ingestion path and reuse the method/endpoint/framework/handler graph props):
 *
 *   Spring MVC / WebFlux
 *     class : @RequestMapping("/base")  (base path)
 *     method: @GetMapping / @PostMapping / @PutMapping / @DeleteMapping /
 *             @PatchMapping / @RequestMapping(value=..., method=RequestMethod.X)
 *
 *   JAX-RS (Jersey / RESTEasy / Microprofile)
 *     class : @Path("/base")            (base path)
 *     method: @GET / @POST / @PUT / @DELETE / @HEAD / @OPTIONS / @PATCH
 *             + optional @Path("/sub")
 *
 * The effective endpoint is the class base path joined with the method path.
 * Each route is function-scoped (attached to its handler method) — Java REST
 * handlers are always methods defined inline, so there is no file-level case.
 */
const Parser = require("tree-sitter");
const Java = require("tree-sitter-java");
const path = require("path");
const { parseSource } = require("../utils");

const sharedParser = new Parser();
sharedParser.setLanguage(Java);

// Spring shortcut annotations -> HTTP method.
const SPRING_METHOD_ANNOS = {
  GetMapping: "GET",
  PostMapping: "POST",
  PutMapping: "PUT",
  DeleteMapping: "DELETE",
  PatchMapping: "PATCH",
};
// JAX-RS HTTP-method marker annotations (the annotation name IS the method).
const JAXRS_HTTP_METHODS = new Set([
  "GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH",
]);

const TYPE_DECL_TYPES = new Set([
  "class_declaration", "interface_declaration",
  "enum_declaration", "record_declaration",
]);

const MAX_TEXT = 500;

function traverse(node, cb) {
  cb(node);
  for (let i = 0; i < node.childCount; i++) traverse(node.child(i), cb);
}

function slice(source, node, limit = MAX_TEXT) {
  return node ? source.slice(node.startIndex, node.endIndex).slice(0, limit) : null;
}

// -------------------------------------------------------------------
// Annotation helpers
// -------------------------------------------------------------------

// Annotation nodes live inside a `modifiers` child of the declaration.
function getAnnotations(declNode) {
  const out = [];
  for (let i = 0; i < declNode.childCount; i++) {
    const c = declNode.child(i);
    if (c.type !== "modifiers") continue;
    for (let j = 0; j < c.childCount; j++) {
      const m = c.child(j);
      if (m.type === "annotation" || m.type === "marker_annotation") out.push(m);
    }
  }
  return out;
}

// Simple annotation name (last segment of a possibly-qualified name).
function annotationName(ann, source) {
  for (let i = 0; i < ann.childCount; i++) {
    const c = ann.child(i);
    if (c.type === "identifier") return slice(source, c);
    if (c.type === "scoped_identifier") {
      const txt = slice(source, c);
      return txt.slice(txt.lastIndexOf(".") + 1);
    }
  }
  return null;
}

function getArgList(ann) {
  for (let i = 0; i < ann.childCount; i++) {
    if (ann.child(i).type === "annotation_argument_list") return ann.child(i);
  }
  return null;
}

// Literal value of a string_literal node (concatenates string_fragment parts).
function stringLiteralValue(node, source) {
  if (!node || node.type !== "string_literal") return null;
  let out = "";
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i).type === "string_fragment") out += slice(source, node.child(i));
  }
  return out;
}

// Resolve a value node to a string: handles string_literal and the first
// element of a {"a","b"} array initializer.
function valueToString(node, source) {
  if (!node) return null;
  if (node.type === "string_literal") return stringLiteralValue(node, source);
  if (node.type === "element_value_array_initializer") {
    for (let i = 0; i < node.namedChildCount; i++) {
      const s = stringLiteralValue(node.namedChild(i), source);
      if (s != null) return s;
    }
  }
  return null;
}

// Resolve a value node to all literal strings: a single string_literal -> one
// element; a {"a","b"} array initializer -> one element per literal.
function valueToStringList(node, source) {
  if (!node) return [];
  if (node.type === "string_literal") {
    const s = stringLiteralValue(node, source);
    return s != null ? [s] : [];
  }
  if (node.type === "element_value_array_initializer") {
    const out = [];
    for (let i = 0; i < node.namedChildCount; i++) {
      const s = stringLiteralValue(node.namedChild(i), source);
      if (s != null) out.push(s);
    }
    return out;
  }
  return [];
}

function getNamedArg(argList, name, source) {
  if (!argList) return null;
  for (let i = 0; i < argList.namedChildCount; i++) {
    const c = argList.namedChild(i);
    if (c.type !== "element_value_pair") continue;
    const key = c.child(0);
    if (key && slice(source, key) === name) {
      // value is the last named child of the pair
      return c.namedChild(c.namedChildCount - 1);
    }
  }
  return null;
}

// Path declared by an annotation: positional string, or value=/path= attribute.
function annotationPath(ann, source) {
  const args = getArgList(ann);
  if (!args) return null;

  // Positional string or array (no `name=`).
  for (let i = 0; i < args.namedChildCount; i++) {
    const c = args.namedChild(i);
    if (c.type === "string_literal" || c.type === "element_value_array_initializer") {
      return valueToString(c, source);
    }
  }
  // Named value= / path=
  const v = getNamedArg(args, "value", source) || getNamedArg(args, "path", source);
  return v ? valueToString(v, source) : null;
}

// All paths declared by an annotation (multi-path arrays -> one per element).
// Returns [null] when no literal path is present, so callers emit exactly one
// route bearing the base path (e.g. @PostMapping with no args).
function annotationPaths(ann, source) {
  const args = getArgList(ann);
  if (!args) return [null];

  for (let i = 0; i < args.namedChildCount; i++) {
    const c = args.namedChild(i);
    if (c.type === "string_literal" || c.type === "element_value_array_initializer") {
      const list = valueToStringList(c, source);
      return list.length ? list : [null];
    }
  }
  const v = getNamedArg(args, "value", source) || getNamedArg(args, "path", source);
  const list = v ? valueToStringList(v, source) : [];
  return list.length ? list : [null];
}

// HTTP methods from a Spring @RequestMapping(method=RequestMethod.X | {X, Y}).
function springRequestMethods(ann, source) {
  const args = getArgList(ann);
  const v = getNamedArg(args, "method", source);
  if (!v) return [];
  const methods = [];
  const pushFieldAccess = (n) => {
    // RequestMethod.POST -> last identifier
    const txt = slice(source, n);
    if (txt) methods.push(txt.slice(txt.lastIndexOf(".") + 1).toUpperCase());
  };
  if (v.type === "element_value_array_initializer") {
    for (let i = 0; i < v.namedChildCount; i++) pushFieldAccess(v.namedChild(i));
  } else {
    pushFieldAccess(v);
  }
  return methods.filter(Boolean);
}

// Declared type of the first @RequestBody parameter (Spring), else null.
// Param annotations live under the formal_parameter's `modifiers`, same as
// class/method annotations.
function requestBodyType(methodNode, source) {
  const params = methodNode.childForFieldName("parameters");
  if (!params) return null;
  for (let i = 0; i < params.namedChildCount; i++) {
    const p = params.namedChild(i);
    if (p.type !== "formal_parameter") continue;
    const hasBody = getAnnotations(p).some((a) => annotationName(a, source) === "RequestBody");
    if (!hasBody) continue;
    const typeNode = p.childForFieldName("type");
    return typeNode ? slice(source, typeNode) : null;
  }
  return null;
}

// -------------------------------------------------------------------
// Path joining: <classBase> + <methodPath>
// -------------------------------------------------------------------
function joinPaths(base, sub) {
  base = base || "";
  sub = sub || "";
  if (!base) return sub;
  if (!sub) return base;
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const s = sub.startsWith("/") ? sub : "/" + sub;
  return b + s;
}

// Base paths declared on the enclosing type.
function classBasePaths(typeNode, source) {
  let spring = "";
  let jaxrs = "";
  if (!typeNode) return { spring, jaxrs };
  for (const ann of getAnnotations(typeNode)) {
    const name = annotationName(ann, source);
    if (name === "RequestMapping") spring = annotationPath(ann, source) || "";
    else if (name === "Path") jaxrs = annotationPath(ann, source) || "";
  }
  return { spring, jaxrs };
}

function enclosingType(node) {
  let p = node.parent;
  while (p && !TYPE_DECL_TYPES.has(p.type)) p = p.parent;
  return p || null;
}

function makeRoute(fields) {
  const method = fields.method || "ANY";
  const endpoint = fields.path != null ? fields.path : "";
  return {
    type: "route",
    framework: fields.framework,
    method,
    path: endpoint,
    handler: fields.handler || null,
    kind: "route",
    isRegex: false,
    decorator: fields.decorator || null,
    requestDTO: fields.requestDTO || null,
    scope: "function",
    handlerLine: fields.handlerLine,
    text: (fields.text || `[${fields.framework}] ${method} ${endpoint}`).slice(0, MAX_TEXT),
    startLine: fields.startLine,
    endLine: fields.endLine,
  };
}

// -------------------------------------------------------------------
// Per-method route detection
// -------------------------------------------------------------------
function methodRoutes(methodNode, base, source) {
  const annos = getAnnotations(methodNode);
  if (!annos.length) return [];

  const nameNode = methodNode.childForFieldName("name");
  const handler = nameNode ? slice(source, nameNode) : null;
  // Match the startLine that extract-functions-java records for this method
  // (method_declaration includes its modifiers/annotations).
  const handlerLine = methodNode.startPosition.row + 1;
  // Spring request-body type → route requestDTO (null for JAX-RS, which uses
  // unannotated entity params — not detected here).
  const requestDTO = requestBodyType(methodNode, source);

  const routes = [];

  // ---- Spring: one route per mapping annotation ----
  for (const ann of annos) {
    const name = annotationName(ann, source);
    const li = { startLine: ann.startPosition.row + 1, endLine: ann.endPosition.row + 1 };

    if (SPRING_METHOD_ANNOS[name]) {
      for (const p of annotationPaths(ann, source)) {
        routes.push(makeRoute({
          framework: "spring",
          method: SPRING_METHOD_ANNOS[name],
          path: joinPaths(base.spring, p),
          handler, handlerLine, decorator: `@${name}`, requestDTO,
          text: slice(source, ann), ...li,
        }));
      }
    } else if (name === "RequestMapping") {
      const methods = springRequestMethods(ann, source);
      const methodStr = methods.length ? methods.join(",") : "ANY";
      for (const p of annotationPaths(ann, source)) {
        routes.push(makeRoute({
          framework: "spring",
          method: methodStr,
          path: joinPaths(base.spring, p),
          handler, handlerLine, decorator: "@RequestMapping", requestDTO,
          text: slice(source, ann), ...li,
        }));
      }
    }
  }

  // ---- JAX-RS: HTTP marker(s) + optional @Path on the method ----
  const jaxrsMarkers = annos.filter((a) => JAXRS_HTTP_METHODS.has(annotationName(a, source)));
  if (jaxrsMarkers.length) {
    const methodPathAnno = annos.find((a) => annotationName(a, source) === "Path");
    const subPath = methodPathAnno ? annotationPath(methodPathAnno, source) : null;
    const endpoint = joinPaths(base.jaxrs, subPath);
    for (const marker of jaxrsMarkers) {
      const name = annotationName(marker, source);
      routes.push(makeRoute({
        framework: "jaxrs",
        method: name.toUpperCase(),
        path: endpoint,
        handler, handlerLine, decorator: `@${name}`,
        text: slice(source, methodPathAnno || marker),
        startLine: marker.startPosition.row + 1,
        endLine: (methodPathAnno || marker).endPosition.row + 1,
      }));
    }
  }

  return routes;
}

/**
 * Main entry: returns an array of route objects for a single Java file.
 */
function extractRoutes(filePath, source, tree) {
  const routes = [];
  const baseCache = new Map(); // typeNode.startIndex -> base paths

  traverse(tree.rootNode, (node) => {
    if (node.type !== "method_declaration") return;
    const type = enclosingType(node);
    const key = type ? type.startIndex : -1;
    let base = baseCache.get(key);
    if (!base) {
      base = classBasePaths(type, source);
      baseCache.set(key, base);
    }
    routes.push(...methodRoutes(node, base, source));
  });

  routes.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  return routes;
}

function extractFileRoutes(filePath) {
  try {
    const { source, tree } = parseSource(filePath, sharedParser);
    return extractRoutes(filePath, source, tree);
  } catch (e) {
    return [];
  }
}

module.exports = { extractRoutes, extractFileRoutes };

// -------------------------------------------------------------
// CLI: node java/extract-routes-java.js <File.java>
// -------------------------------------------------------------
if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: node java/extract-routes-java.js <File.java>");
    process.exit(1);
  }
  const routes = extractFileRoutes(path.resolve(target));
  console.log(JSON.stringify(routes, null, 2));
  console.log(`\n${routes.length} route(s) detected.`);
}
