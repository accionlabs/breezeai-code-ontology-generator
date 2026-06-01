/**
 * PHP web-route extractor (static).
 *
 *   Laravel   (tree-sitter, file-scoped):
 *     Route::get/post/put/patch/delete/options/any('/path', action)
 *     Route::match(['get','post'], '/path', action)
 *     Route::resource('photos', PhotoController::class)   -> expanded to REST routes
 *     Route::apiResource(...)                             -> expanded (no create/edit)
 *     Route::view('/welcome', 'welcome')
 *     action forms: [Ctrl::class,'m'] | 'Ctrl@action' | Ctrl::class (invokable)
 *
 *   Symfony   (tree-sitter, attached to handler method):
 *     class  #[Route('/api')]   (prefix)
 *     method #[Route('/list', methods: ['GET'])]
 *
 *   Drupal / Symfony YAML (yaml parser, file-scoped):
 *     *.routing.yml, routes.yaml, config/routes/*.yaml
 *       route_name: { path: '/x', methods: [GET], defaults: { _controller: 'C::m' } }
 *
 * Emitted as `type:"route"` statements, reusing the shared graph fields.
 */
const Parser = require("tree-sitter");
const PHP = require("tree-sitter-php").php;
const fs = require("fs");
const path = require("path");
const YAML = require("yaml");
const { parseSource } = require("../utils");

const sharedParser = new Parser();
sharedParser.setLanguage(PHP);

const MAX_TEXT = 500;

const LARAVEL_VERBS = {
  get: "GET", post: "POST", put: "PUT", patch: "PATCH",
  delete: "DELETE", options: "OPTIONS", any: "ANY",
};

// REST routes that Route::resource() / apiResource() generate.
const RESOURCE_ACTIONS = [
  { action: "index", method: "GET", suffix: "" },
  { action: "create", method: "GET", suffix: "/create" },
  { action: "store", method: "POST", suffix: "" },
  { action: "show", method: "GET", suffix: "/{param}" },
  { action: "edit", method: "GET", suffix: "/{param}/edit" },
  { action: "update", method: "PUT,PATCH", suffix: "/{param}" },
  { action: "destroy", method: "DELETE", suffix: "/{param}" },
];
const API_RESOURCE_ACTIONS = new Set(["index", "store", "show", "update", "destroy"]);

function traverse(node, cb) {
  cb(node);
  for (let i = 0; i < node.childCount; i++) traverse(node.child(i), cb);
}

function text(source, node, limit = MAX_TEXT) {
  return node ? source.slice(node.startIndex, node.endIndex).slice(0, limit) : null;
}

function lastSegment(s) {
  if (!s) return s;
  return s.replace(/^\\+/, "").split("\\").pop();
}

// String literal value (string / encapsed_string -> concatenate content parts).
function getString(source, node) {
  if (!node) return null;
  if (node.type === "string" || node.type === "encapsed_string") {
    let out = "";
    let had = false;
    for (let i = 0; i < node.childCount; i++) {
      const t = node.child(i).type;
      if (t === "string_content" || t === "string_value" || t === "encapsed_string") {
        out += text(source, node.child(i));
        had = true;
      }
    }
    if (had) return out;
    return text(source, node).replace(/^b?['"]|['"]$/g, "");
  }
  return null;
}

// Strings inside an array_creation_expression ([ 'a', 'b' ]).
function arrayStrings(source, node) {
  const out = [];
  if (!node || node.type !== "array_creation_expression") return out;
  for (let i = 0; i < node.namedChildCount; i++) {
    const el = node.namedChild(i);
    const v = el.type === "array_element_initializer" ? el.namedChild(0) : el;
    const s = getString(source, v);
    if (s != null) out.push(s);
  }
  return out;
}

// The arguments node of a call/attribute.
function argsOf(node) {
  const a = node.childForFieldName && node.childForFieldName("arguments");
  if (a) return a;
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i).type === "arguments") return node.child(i);
  }
  return null;
}

// Parse one `argument` node -> { name|null, value }.
function parseArgument(source, arg) {
  let named = false;
  for (let i = 0; i < arg.childCount; i++) {
    if (arg.child(i).type === ":") { named = true; break; }
  }
  const value = arg.namedChild(arg.namedChildCount - 1);
  const name = named ? text(source, arg.namedChild(0)) : null;
  return { name, value };
}

function positionalArgs(source, argsNode) {
  const out = [];
  if (!argsNode) return out;
  for (let i = 0; i < argsNode.namedChildCount; i++) {
    const a = argsNode.namedChild(i);
    if (a.type !== "argument") continue;
    const p = parseArgument(source, a);
    if (p.name == null) out.push(p.value);
  }
  return out;
}

function namedArg(source, argsNode, name) {
  if (!argsNode) return null;
  for (let i = 0; i < argsNode.namedChildCount; i++) {
    const a = argsNode.namedChild(i);
    if (a.type !== "argument") continue;
    const p = parseArgument(source, a);
    if (p.name === name) return p.value;
  }
  return null;
}

// Resolve a Laravel route action value -> "Ctrl@method" | "Ctrl" | string | null.
function resolveAction(source, node) {
  if (!node) return null;
  const str = getString(source, node);
  if (str != null) return str; // 'Ctrl@action' or view name
  if (node.type === "array_creation_expression") {
    const parts = [];
    for (let i = 0; i < node.namedChildCount; i++) {
      const el = node.namedChild(i);
      const v = el.type === "array_element_initializer" ? el.namedChild(0) : el;
      if (v.type === "class_constant_access_expression") {
        parts.push(lastSegment(text(source, v.child(0)))); // Ctrl from Ctrl::class
      } else {
        const s = getString(source, v);
        if (s != null) parts.push(s);
      }
    }
    if (parts.length === 2) return `${parts[0]}@${parts[1]}`;
    if (parts.length === 1) return parts[0];
  }
  if (node.type === "class_constant_access_expression") {
    return lastSegment(text(source, node.child(0)));
  }
  return null; // closure / arrow function
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

function joinPaths(base, sub) {
  base = base || "";
  sub = sub || "";
  if (!base) return sub;
  if (!sub) return base;
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const s = sub.startsWith("/") ? sub : "/" + sub;
  return b + s;
}

function singularize(word) {
  if (/ies$/.test(word)) return word.replace(/ies$/, "y");
  if (/s$/.test(word)) return word.replace(/s$/, "");
  return word;
}

// -------------------------------------------------------------------
// Laravel facade calls  (Route::verb / match / resource / view)
// -------------------------------------------------------------------
function extractLaravelRoutes(root, source) {
  const routes = [];
  traverse(root, (node) => {
    if (node.type !== "scoped_call_expression") return;
    const scope = node.childForFieldName("scope");
    const nameNode = node.childForFieldName("name");
    if (!scope || !nameNode) return;
    if (lastSegment(text(source, scope)) !== "Route") return;

    const method = text(source, nameNode);
    const args = argsOf(node);
    const pos = positionalArgs(source, args);
    const li = { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 };
    const snippet = text(source, node);

    if (LARAVEL_VERBS[method]) {
      const p = getString(source, pos[0]);
      if (p == null) return;
      routes.push(makeRoute({
        framework: "laravel", method: LARAVEL_VERBS[method], path: p,
        handler: resolveAction(source, pos[1]),
        decorator: `Route::${method}`, text: snippet, ...li,
      }));
      return;
    }

    if (method === "match") {
      const methods = arrayStrings(source, pos[0]).map((m) => m.toUpperCase());
      const p = getString(source, pos[1]);
      if (p == null) return;
      routes.push(makeRoute({
        framework: "laravel", method: methods.join(",") || "ANY", path: p,
        handler: resolveAction(source, pos[2]),
        decorator: "Route::match", text: snippet, ...li,
      }));
      return;
    }

    if (method === "view") {
      const p = getString(source, pos[0]);
      if (p == null) return;
      routes.push(makeRoute({
        framework: "laravel", method: "GET", path: p,
        handler: getString(source, pos[1]), kind: "view",
        decorator: "Route::view", text: snippet, ...li,
      }));
      return;
    }

    if (method === "resource" || method === "apiResource"
      || method === "resources" || method === "apiResources") {
      const name = getString(source, pos[0]);
      if (name == null) return;
      const isApi = method.toLowerCase().startsWith("apiresource");
      const controller = resolveAction(source, pos[1]); // Ctrl::class -> "Ctrl"
      const basePath = "/" + name.replace(/\./g, "/");
      const param = singularize(name.split(".").pop());
      for (const r of RESOURCE_ACTIONS) {
        if (isApi && !API_RESOURCE_ACTIONS.has(r.action)) continue;
        routes.push(makeRoute({
          framework: "laravel", method: r.method,
          path: basePath + r.suffix.replace("{param}", `{${param}}`),
          handler: controller ? `${controller}@${r.action}` : null,
          kind: "resource", decorator: `Route::${method}`,
          text: `${snippet} (${r.action})`, ...li,
        }));
      }
    }
  });
  return routes;
}

// -------------------------------------------------------------------
// Symfony PHP 8 attributes  ( #[Route(...)] )
// -------------------------------------------------------------------
function attributesOf(node) {
  const out = [];
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c.type !== "attribute_list") continue;
    for (let j = 0; j < c.childCount; j++) {
      const grp = c.child(j);
      if (grp.type !== "attribute_group") continue;
      for (let k = 0; k < grp.childCount; k++) {
        if (grp.child(k).type === "attribute") out.push(grp.child(k));
      }
    }
  }
  return out;
}

function attributeName(source, attr) {
  const n = attr.childForFieldName("name");
  if (n) return lastSegment(text(source, n));
  for (let i = 0; i < attr.childCount; i++) {
    if (attr.child(i).type === "name" || attr.child(i).type === "qualified_name") {
      return lastSegment(text(source, attr.child(i)));
    }
  }
  return null;
}

// First #[Route] attribute -> { path, methods } (or null).
function routeFromAttributes(source, node) {
  for (const attr of attributesOf(node)) {
    if (attributeName(source, attr) !== "Route") continue;
    const args = argsOf(attr);
    const pos = positionalArgs(source, args);
    let p = getString(source, pos[0]);
    if (p == null) {
      const pathArg = namedArg(source, args, "path");
      p = getString(source, pathArg);
    }
    const methodsArr = arrayStrings(source, namedArg(source, args, "methods")).map((m) => m.toUpperCase());
    return { path: p || "", methods: methodsArr };
  }
  return null;
}

function extractSymfonyRoutes(root, source) {
  const routes = [];
  traverse(root, (node) => {
    if (node.type !== "class_declaration") return;
    const classRoute = routeFromAttributes(source, node);
    const base = classRoute ? classRoute.path : "";

    const body = node.childForFieldName("body") || node.childForFieldName("declaration_list");
    if (!body) return;
    for (let i = 0; i < body.namedChildCount; i++) {
      const m = body.namedChild(i);
      if (m.type !== "method_declaration") continue;
      const mr = routeFromAttributes(source, m);
      if (!mr) continue;
      const nameNode = m.childForFieldName("name");
      const handler = nameNode ? text(source, nameNode) : null;
      routes.push(makeRoute({
        framework: "symfony",
        method: mr.methods.length ? mr.methods.join(",") : "ANY",
        path: joinPaths(base, mr.path),
        handler, handlerLine: m.startPosition.row + 1, scope: "function",
        decorator: "#[Route]", text: text(source, m, 120),
        startLine: m.startPosition.row + 1, endLine: m.startPosition.row + 1,
      }));
    }
  });
  return routes;
}

function extractRoutes(filePath, source, tree) {
  const root = tree.rootNode;
  const routes = [...extractLaravelRoutes(root, source), ...extractSymfonyRoutes(root, source)];
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

// -------------------------------------------------------------------
// Drupal / Symfony YAML routing files
// -------------------------------------------------------------------
function buildLineIndex(text) {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") offsets.push(i + 1);
  }
  return (off) => {
    // binary search: count of line starts <= off
    let lo = 0, hi = offsets.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid] <= off) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans + 1;
  };
}

function extractYamlRoutes(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    return [];
  }
  let doc;
  try {
    doc = YAML.parseDocument(raw);
  } catch (e) {
    return [];
  }
  const root = doc && doc.contents;
  if (!root || !Array.isArray(root.items)) return [];

  const isDrupal = filePath.endsWith(".routing.yml");
  const lineAt = buildLineIndex(raw);
  const routes = [];

  for (const pair of root.items) {
    if (!pair.key || !pair.value || typeof pair.value.toJSON !== "function") continue;
    const name = String(pair.key.value != null ? pair.key.value : pair.key);
    const val = pair.value.toJSON();
    if (!val || typeof val !== "object") continue;
    if (val.path == null) continue; // skip resource/import/prefix entries

    const methods = Array.isArray(val.methods)
      ? val.methods.map((m) => String(m).toUpperCase()).join(",")
      : (val.methods ? String(val.methods).toUpperCase() : "ANY");

    const defaults = val.defaults || {};
    const controller = val.controller
      || defaults._controller || defaults._form || defaults._entity_form
      || defaults._entity_list || defaults._entity_view || null;

    const framework = isDrupal || defaults._controller || defaults._form ? "drupal" : "symfony";
    const startLine = pair.key.range ? lineAt(pair.key.range[0]) : 1;
    const endLine = pair.value.range ? lineAt(pair.value.range[1]) : startLine;

    routes.push(makeRoute({
      framework, method: methods, path: String(val.path), handler: controller,
      kind: "route", decorator: null, scope: "file",
      text: `${name}: ${val.path}`, startLine, endLine,
    }));
  }
  return routes;
}

module.exports = { extractFileRoutes, extractYamlRoutes };

// -------------------------------------------------------------
// CLI: node php/extract-routes-php.js <file.php|file.yml>
// -------------------------------------------------------------
if (require.main === module) {
  const target = process.argv[2];
  if (!target) {
    console.error("Usage: node php/extract-routes-php.js <file.php|*.routing.yml>");
    process.exit(1);
  }
  const abs = path.resolve(target);
  const routes = /\.ya?ml$/.test(abs) ? extractYamlRoutes(abs) : extractFileRoutes(abs);
  console.log(JSON.stringify(routes, null, 2));
  console.log(`\n${routes.length} route(s) detected.`);
}
