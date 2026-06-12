/**
 * Java web-route extractor (static, tree-sitter based)
 *
 * Detects HTTP route / endpoint declarations for the two dominant Java REST
 * stacks and returns them as structured route objects (same shape as the
 * Python route extractor, so they flow through the identical HAS_STATEMENT
 * ingestion path and reuse the method/endpoint/framework/handler graph props):
 *
 *   Spring MVC / annotation-based WebFlux
 *     class : @RequestMapping("/base")  (base path)
 *     method: @GetMapping / @PostMapping / @PutMapping / @DeleteMapping /
 *             @PatchMapping / @RequestMapping(value=..., method=RequestMethod.X)
 *
 *   JAX-RS (Jersey / RESTEasy / Microprofile)
 *     class : @Path("/base")            (base path)
 *     method: @GET / @POST / @PUT / @DELETE / @HEAD / @OPTIONS / @PATCH
 *             + optional @Path("/sub")
 *
 *   Functional routing — WebMvc.fn + WebFlux (call-based, import-gated)
 *     RouterFunctions.route().GET("/p", handler)  and  route(GET("/p"), handler)
 *     -> file-scoped routes (framework "spring-functional"); the handler name is
 *     captured from a method reference (handler::all) when present.
 *
 *   Composed / meta-annotations
 *     A custom @interface meta-annotated with a Spring mapping (e.g.
 *     @GetJson -> @GetMapping) is resolved when the @interface is declared in
 *     the SAME file. Cross-file composed annotations need a repo-wide
 *     annotation index and are out of scope for this per-file extractor.
 *
 * For annotation routes the effective endpoint is the class base path joined
 * with the method path, and each route is function-scoped (attached to its
 * handler method). Non-literal paths (constants, ${...}/#{...} placeholders,
 * string concatenation) are rendered as {token} segments rather than dropped.
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
// Functional-routing builder/predicate verbs (RouterFunctions.route().GET(...),
// RequestPredicates.GET(...)) — shared by Spring WebMvc.fn and WebFlux. The
// invoked method name IS the HTTP method.
const FUNCTIONAL_VERBS = new Set([
  "GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS",
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

// Decode a Java escape_sequence node's text (e.g. "\\d" -> "\d", "\\u002F" -> "/").
function decodeJavaEscape(seq) {
  if (!seq || seq.length < 2) return seq || "";
  const c = seq[1];
  switch (c) {
    case "n": return "\n";
    case "t": return "\t";
    case "r": return "\r";
    case "b": return "\b";
    case "f": return "\f";
    case "0": return "\0";
    case "\\": return "\\";
    case "'": return "'";
    case '"': return '"';
    case "u": {
      const code = parseInt(seq.slice(2), 16);
      return Number.isNaN(code) ? seq : String.fromCharCode(code);
    }
    default: return seq.slice(1); // unknown escape -> drop the backslash
  }
}

// Literal value of a string_literal node: concatenates string_fragment parts and
// decoded escape sequences (so regex/escaped paths like {sku:\\d+} survive).
function stringLiteralValue(node, source) {
  if (!node || node.type !== "string_literal") return null;
  let out = "";
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c.type === "string_fragment") out += slice(source, c);
    else if (c.type === "escape_sequence") out += decodeJavaEscape(slice(source, c));
  }
  return out;
}

// Spring property placeholders ${...} and SpEL #{...} -> {...} token form.
function tokenizePath(s) {
  return s.replace(/[$#]\{([^}]*)\}/g, "{$1}");
}

// Resolve a single annotation value node to a path string. Literals are taken
// verbatim (with ${x}/#{x} placeholders rewritten to {x}); unresolved
// constants / field accesses are rendered as {lastSegment}; string
// concatenation joins its tokenized operands. Returns null when nothing usable.
function resolvePath(node, source) {
  if (!node) return null;
  switch (node.type) {
    case "string_literal": {
      const s = stringLiteralValue(node, source);
      return s != null ? tokenizePath(s) : null;
    }
    case "identifier":
    case "field_access":
    case "scoped_identifier": {
      const txt = slice(source, node) || "";
      const seg = txt.slice(txt.lastIndexOf(".") + 1).trim();
      return seg ? `{${seg}}` : null;
    }
    case "binary_expression": {
      // String concatenation (a + b + ...) -> join tokenized operands.
      const l = resolvePath(node.childForFieldName("left"), source) || "";
      const r = resolvePath(node.childForFieldName("right"), source) || "";
      return (l + r) || null;
    }
    default:
      return null;
  }
}

// Resolve a value node to all path strings: a {"a","b"} array -> one per
// element; any other node -> a single resolved path (tokenized if non-literal).
function pathValuesFrom(node, source) {
  if (!node) return [];
  if (node.type === "element_value_array_initializer") {
    const out = [];
    for (let i = 0; i < node.namedChildCount; i++) {
      out.push(...pathValuesFrom(node.namedChild(i), source));
    }
    return out;
  }
  const v = resolvePath(node, source);
  return v != null ? [v] : [];
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

// Single path declared by an annotation (first of any multi-path set), or null.
// Used for class base paths and JAX-RS @Path (single-valued by design).
function annotationPath(ann, source) {
  const paths = annotationPaths(ann, source);
  return paths.length ? paths[0] : null;
}

// All paths declared by an annotation (multi-path arrays -> one per element;
// non-literal constants/placeholders tokenized via resolvePath). Returns [null]
// when no path is present, so callers emit exactly one route bearing the base
// path (e.g. @PostMapping with no args).
function annotationPaths(ann, source) {
  const args = getArgList(ann);
  if (!args) return [null];

  // Positional value (string, array, or non-literal like a constant ref).
  for (let i = 0; i < args.namedChildCount; i++) {
    const c = args.namedChild(i);
    if (c.type === "element_value_pair") continue; // named args handled below
    const list = pathValuesFrom(c, source);
    if (list.length) return list;
  }
  // Named value= / path=
  const v = getNamedArg(args, "value", source) || getNamedArg(args, "path", source);
  const list = v ? pathValuesFrom(v, source) : [];
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
    scope: fields.scope || "function",
    handlerLine: fields.handlerLine != null ? fields.handlerLine : null,
    text: (fields.text || `[${fields.framework}] ${method} ${endpoint}`).slice(0, MAX_TEXT),
    startLine: fields.startLine,
    endLine: fields.endLine,
  };
}

// Composed mapping annotations DEFINED IN THIS FILE: a custom @interface that
// is itself meta-annotated with a Spring mapping (e.g. @GetJson -> @GetMapping).
// Returns a Map(customName -> HTTP method). Cross-file composed annotations are
// out of scope (need a repo-wide annotation index — see header).
function composedAnnotations(tree, source) {
  const map = new Map();
  traverse(tree.rootNode, (node) => {
    if (node.type !== "annotation_type_declaration") return;
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;
    const customName = slice(source, nameNode);
    for (const meta of getAnnotations(node)) {
      const metaName = annotationName(meta, source);
      if (SPRING_METHOD_ANNOS[metaName]) {
        map.set(customName, SPRING_METHOD_ANNOS[metaName]);
        break;
      }
      if (metaName === "RequestMapping") {
        const methods = springRequestMethods(meta, source);
        map.set(customName, methods.length ? methods.join(",") : "ANY");
        break;
      }
    }
  });
  return map;
}

// -------------------------------------------------------------------
// Per-method route detection
// -------------------------------------------------------------------
function methodRoutes(methodNode, base, source, composed = new Map()) {
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
    } else if (composed.has(name)) {
      // Custom mapping annotation defined in this file (e.g. @GetJson). The
      // path (if any) is supplied at the usage site; method comes from the meta.
      for (const p of annotationPaths(ann, source)) {
        routes.push(makeRoute({
          framework: "spring",
          method: composed.get(name),
          path: joinPaths(base.spring, p),
          handler, handlerLine, decorator: `@${name}`, requestDTO,
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

// -------------------------------------------------------------------
// Functional routing (call-based) — RouterFunctions.route().GET("/p", h) and
// the static-predicate form route(GET("/p"), h). Covers Spring WebMvc.fn
// (web.servlet.function) and WebFlux (web.reactive.function.server). Import-
// gated to avoid treating any uppercase .GET()/.POST() call as a route
// (guide §3a / §4).
// -------------------------------------------------------------------
function importsFunctionalRouting(tree, source) {
  let found = false;
  traverse(tree.rootNode, (n) => {
    if (found || n.type !== "import_declaration") return;
    const txt = slice(source, n, MAX_TEXT);
    if (txt.includes("web.servlet.function") ||
        txt.includes("web.reactive.function.server")) found = true;
  });
  return found;
}

// Handler name referenced as the second arg (handler::all -> "all"; a bare
// identifier/field handler -> its text; lambdas -> null).
function functionalHandler(node, source) {
  if (!node) return null;
  if (node.type === "method_reference") {
    const txt = slice(source, node) || "";
    const i = txt.lastIndexOf("::");
    return i >= 0 ? txt.slice(i + 2).trim() : txt;
  }
  if (node.type === "identifier" || node.type === "field_access") {
    return slice(source, node);
  }
  return null;
}

function functionalRoutes(tree, source) {
  const routes = [];
  traverse(tree.rootNode, (node) => {
    if (node.type !== "method_invocation") return;
    const nameNode = node.childForFieldName("name");
    if (!nameNode) return;
    const verb = slice(source, nameNode);
    if (!FUNCTIONAL_VERBS.has(verb)) return;

    const args = node.childForFieldName("arguments");
    if (!args || args.namedChildCount === 0) return;
    const first = args.namedChild(0);
    if (first.type !== "string_literal") return;     // need a literal path
    const path = stringLiteralValue(first, source);
    if (!path || !path.startsWith("/")) return;        // route-like path gate

    routes.push(makeRoute({
      framework: "spring-functional",
      method: verb,
      path,
      handler: args.namedChildCount > 1 ? functionalHandler(args.namedChild(1), source) : null,
      scope: "file",                                   // not attached to a handler method
      text: slice(source, node),
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
    }));
  });
  return routes;
}

/**
 * Main entry: returns an array of route objects for a single Java file.
 */
function extractRoutes(filePath, source, tree) {
  const routes = [];
  const baseCache = new Map(); // typeNode.startIndex -> base paths
  const composed = composedAnnotations(tree, source); // same-file @GetJson -> GET

  traverse(tree.rootNode, (node) => {
    if (node.type !== "method_declaration") return;
    const type = enclosingType(node);
    const key = type ? type.startIndex : -1;
    let base = baseCache.get(key);
    if (!base) {
      base = classBasePaths(type, source);
      baseCache.set(key, base);
    }
    routes.push(...methodRoutes(node, base, source, composed));
  });

  // Functional routes (call-based), only when the file uses the API.
  if (importsFunctionalRouting(tree, source)) {
    routes.push(...functionalRoutes(tree, source));
  }

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
