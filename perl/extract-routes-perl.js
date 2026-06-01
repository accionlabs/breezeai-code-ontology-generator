/**
 * Perl web-route extractor (static, tree-sitter based).
 *
 *   Dancer / Dancer2   (DSL, file-scoped):
 *     get '/x' => sub {...};  post/put/patch/del/options/any
 *   Mojolicious::Lite  (DSL, file-scoped):
 *     get '/x' => sub {...};  + websocket
 *   Mojolicious routes (method calls, file-scoped):
 *     $r->get('/x')->to('controller#action');  post/any/under/websocket/route
 *   Catalyst           (sub attributes, attached to handler sub):
 *     sub list :Path('/items') {} ; :Local (path=sub name); :Global; :Chained
 *
 * tree-sitter-perl is an ESM module with top-level await, so it must be loaded
 * via dynamic import() and the public entry is async (mirrors extract-functions-perl).
 * Framework is inferred from `use` statements; Catalyst's chained dispatch
 * (:Chained/:PathPart) is detected but not path-composed (kind "chained").
 *
 * Emitted as `type:"route"` statements, reusing the shared graph fields.
 */
const Parser = require("tree-sitter");
const fs = require("fs");
const path = require("path");

const MAX_TEXT = 500;

// Dancer/Mojo::Lite DSL verbs.
const DSL_VERBS = {
  get: "GET", post: "POST", put: "PUT", patch: "PATCH",
  del: "DELETE", delete: "DELETE", options: "OPTIONS", any: "ANY",
};
// Mojolicious routes-object methods.
const MOJO_METHODS = {
  get: "GET", post: "POST", put: "PUT", patch: "PATCH", delete: "DELETE",
  options: "OPTIONS", any: "ANY", under: "ANY", route: "ANY", websocket: "WEBSOCKET",
};
const CATALYST_PATH_ATTRS = new Set(["Path", "Local", "Global", "Chained"]);

let sharedParser = null;
let Perl = null;

async function initParser() {
  if (!sharedParser) {
    Perl = await import("tree-sitter-perl");
    sharedParser = new Parser();
    sharedParser.setLanguage(Perl.default);
  }
  return sharedParser;
}

function traverse(node, cb) {
  cb(node);
  for (let i = 0; i < node.childCount; i++) traverse(node.child(i), cb);
}

function text(source, node, limit = MAX_TEXT) {
  return node ? source.slice(node.startIndex, node.endIndex).slice(0, limit) : null;
}

function stripQuotes(s) {
  return s == null ? s : s.replace(/^['"]|['"]$/g, "");
}

// Value of a string_literal / interpolated_string_literal node.
function getString(source, node) {
  if (!node) return null;
  if (node.type === "string_literal" || node.type === "interpolated_string_literal") {
    let out = "";
    let had = false;
    for (let i = 0; i < node.childCount; i++) {
      if (node.child(i).type === "string_content") { out += text(source, node.child(i)); had = true; }
    }
    return had ? out : stripQuotes(text(source, node));
  }
  return null;
}

function pathLike(p) {
  return typeof p === "string" && p.startsWith("/");
}

function detectFrameworks(source) {
  return {
    dancer: /\buse\s+Dancer2?\b/.test(source),
    mojoLite: /\buse\s+Mojolicious::Lite\b/.test(source),
    mojo: /\buse\s+Mojo(licious)?\b/.test(source) || /Mojolicious::Controller/.test(source),
    catalyst: /\buse\s+Catalyst\b/.test(source) || /Catalyst::Controller/.test(source),
  };
}

function makeRoute(f) {
  const method = f.method || "ANY";
  const endpoint = f.path != null ? f.path : "";
  const arrow = f.handler ? ` -> ${f.handler}` : "";
  return {
    type: "route",
    framework: f.framework,
    method,
    path: endpoint,
    handler: f.handler || null,
    kind: f.kind || "route",
    isRegex: false,
    decorator: f.decorator || null,
    scope: f.scope || "file",
    handlerLine: f.handlerLine != null ? f.handlerLine : null,
    text: (f.text || `[${f.framework}] ${method} ${endpoint}${arrow}`).slice(0, MAX_TEXT),
    startLine: f.startLine,
    endLine: f.endLine,
  };
}

// First string literal inside a node's direct/contained children (one level).
function firstString(source, node) {
  if (!node) return null;
  for (let i = 0; i < node.namedChildCount; i++) {
    const c = node.namedChild(i);
    const s = getString(source, c);
    if (s != null) return s;
  }
  return null;
}

// -------------------------------------------------------------------
// Dancer / Mojolicious::Lite DSL: get '/x' => sub {...}
// -------------------------------------------------------------------
function extractDslRoutes(root, source, fw) {
  const routes = [];
  if (!fw.dancer && !fw.mojoLite) return routes;
  const framework = fw.dancer ? "dancer" : "mojolicious";

  traverse(root, (node) => {
    if (node.type !== "ambiguous_function_call_expression") return;
    const fnNode = node.child(0);
    if (!fnNode || fnNode.type !== "function") return;
    const verb = text(source, fnNode);
    if (!DSL_VERBS[verb]) return;
    // path = first string in the list_expression argument
    let list = null;
    for (let i = 1; i < node.childCount; i++) {
      if (node.child(i).type === "list_expression") { list = node.child(i); break; }
    }
    const p = list ? firstString(source, list) : firstString(source, node);
    if (!pathLike(p)) return;
    routes.push(makeRoute({
      framework, method: DSL_VERBS[verb], path: p,
      decorator: verb, text: text(source, node, 120),
      startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1,
    }));
  });
  return routes;
}

// -------------------------------------------------------------------
// Mojolicious routes object: $r->get('/x')->to('ctrl#action')
// -------------------------------------------------------------------
function methodName(source, mcall) {
  for (let i = 0; i < mcall.childCount; i++) {
    if (mcall.child(i).type === "method") return text(source, mcall.child(i));
  }
  return null;
}

// Leading scalar variable of a method call's invocant ($ua->get -> "ua",
// $app->routes->get -> "app"). Used to reject HTTP-client calls.
function invocantRoot(source, mcall) {
  const obj = mcall.child(0);
  if (!obj) return null;
  const m = /\$(\w+)/.exec(text(source, obj, 60));
  return m ? m[1] : null;
}

// Mojo::UserAgent / Test::Mojo / transaction objects use the same get/post/...
// method names as routers — exclude them so $ua->get('/x') isn't a route.
const CLIENT_INVOCANTS = new Set(["ua", "tx", "t", "client", "agent"]);

// If this call is chained with ->to('ctrl#action'), return the handler string.
function chainedTo(source, callNode) {
  const parent = callNode.parent;
  if (!parent || parent.type !== "method_call_expression") return null;
  if (methodName(source, parent) !== "to") return null;
  return firstString(source, parent);
}

function extractMojoRoutes(root, source, fw) {
  const routes = [];
  if (!fw.mojo && !fw.mojoLite) return routes;

  traverse(root, (node) => {
    if (node.type !== "method_call_expression") return;
    const m = methodName(source, node);
    if (!m || !MOJO_METHODS[m]) return;
    if (CLIENT_INVOCANTS.has(invocantRoot(source, node))) return; // $ua->get etc.
    const p = firstString(source, node);
    if (!pathLike(p)) return;
    routes.push(makeRoute({
      framework: "mojolicious",
      method: m === "websocket" ? "WEBSOCKET" : MOJO_METHODS[m],
      path: p,
      handler: chainedTo(source, node),
      kind: m === "websocket" ? "ws" : "route",
      decorator: `->${m}`, text: text(source, node, 120),
      startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1,
    }));
  });
  return routes;
}

// -------------------------------------------------------------------
// Catalyst: sub foo :Path('/x') :Args(0) {}
// -------------------------------------------------------------------
function subName(source, subNode) {
  for (let i = 0; i < subNode.childCount; i++) {
    if (subNode.child(i).type === "bareword") return text(source, subNode.child(i));
  }
  return null;
}

function subAttributes(source, subNode) {
  const out = [];
  traverse(subNode, (n) => {
    if (n.type === "attribute") {
      let name = null, value = null;
      for (let i = 0; i < n.childCount; i++) {
        const c = n.child(i);
        if (c.type === "attribute_name") name = text(source, c);
        else if (c.type === "attribute_value") value = stripQuotes(text(source, c));
      }
      if (name) out.push({ name, value });
    }
  });
  return out;
}

function extractCatalystRoutes(root, source, fw) {
  const routes = [];
  traverse(root, (node) => {
    if (node.type !== "subroutine_declaration_statement" && node.type !== "subroutine_definition") return;
    const attrs = subAttributes(source, node);
    if (!attrs.some((a) => CATALYST_PATH_ATTRS.has(a.name))) return;
    if (!fw.catalyst) {
      // Allow without import only for the unambiguous Catalyst attributes.
      if (!attrs.some((a) => ["Path", "Local", "Global", "Chained"].includes(a.name))) return;
    }
    const handler = subName(source, node);
    const handlerLine = node.startPosition.row + 1;

    let routePath = null, kind = "route", deco = null;
    for (const a of attrs) {
      if (a.name === "Path") { routePath = a.value != null ? a.value : handler; deco = ":Path"; break; }
      if (a.name === "Local") { routePath = handler; deco = ":Local"; break; }
      if (a.name === "Global") { routePath = "/" + handler; deco = ":Global"; break; }
      if (a.name === "Chained") {
        const pp = attrs.find((x) => x.name === "PathPart");
        routePath = pp && pp.value != null ? pp.value : handler;
        kind = "chained"; deco = ":Chained"; break;
      }
    }
    if (routePath == null) return;
    routes.push(makeRoute({
      framework: "catalyst", method: "ANY", path: routePath, handler, handlerLine,
      kind, scope: "function", decorator: deco, text: text(source, node, 120),
      startLine: handlerLine, endLine: handlerLine,
    }));
  });
  return routes;
}

function extractRoutesFromTree(source, tree) {
  const root = tree.rootNode;
  const fw = detectFrameworks(source);
  const routes = [
    ...extractDslRoutes(root, source, fw),
    ...extractMojoRoutes(root, source, fw),
    ...extractCatalystRoutes(root, source, fw),
  ];
  routes.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  return routes;
}

async function extractFileRoutes(filePath) {
  try {
    await initParser();
    const source = fs.readFileSync(filePath, "utf8").replace(/\0/g, "");
    const tree = sharedParser.parse(source);
    return extractRoutesFromTree(source, tree);
  } catch (e) {
    return [];
  }
}

module.exports = { extractFileRoutes, extractRoutesFromTree, initParser };

if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: node perl/extract-routes-perl.js <file.pl|.pm>");
    process.exit(1);
  }
  extractFileRoutes(path.resolve(target)).then((routes) => {
    console.log(JSON.stringify(routes, null, 2));
    console.log(`\n${routes.length} route(s) detected.`);
  });
}
