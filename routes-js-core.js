/**
 * Shared Node.js / TypeScript web-route extraction core.
 *
 * Grammar-agnostic: tree-sitter-javascript and tree-sitter-typescript share the
 * node-type names this module relies on (call_expression, member_expression,
 * decorator, class_declaration, method_definition, string, template_string), so
 * one implementation drives both. Thin wrappers in nodejs/ and typescript/
 * supply their own parser and call `extractRoutesFromTree`.
 *
 * Detects (emitted as `type:"route"` statements, same shape as Python/Java):
 *   Express / Fastify / Koa (call-based, file-scoped):
 *     app|router.get/post/put/delete/patch/head/options/all('/path', handler)
 *     app.use('/prefix', subRouter)            -> mount
 *     fastify.route({ method, url, handler })
 *   NestJS (decorator-based, attached to handler method):
 *     @Controller('base') + @Get/@Post/@Put/@Delete/@Patch/@All/@Options/@Head
 *     @Query/@Mutation/@Subscription/@ResolveField   -> routeKind "graphql"
 *     @SubscribeMessage('event')                      -> routeKind "ws"
 *     @MessagePattern/@EventPattern(pattern)          -> routeKind "message"
 *   LoopBack 4 (decorator-based, attached to handler method):
 *     @get/@post/@put/@patch/@del('/full/path', {spec})   (@del -> DELETE)
 *     full path is the 1st decorator arg (no class-level base, unlike Nest);
 *     config-prefix concatenation (appConfig.apiPath + '/x') -> {apiPath}/x
 *
 * Call-based detection is gated on an express/fastify/koa import and a route-like
 * path ('/...') to avoid false positives (e.g. cache.get('key')); NestJS decorator
 * detection is gated on a @nestjs/* import (or a @Controller class); LoopBack
 * decorator detection is gated on a @loopback/rest import.
 */

const MAX_TEXT = 500;

const CALL_HTTP_VERBS = new Set([
  "get", "post", "put", "delete", "patch", "head", "options",
]);
const NEST_HTTP_DECORATORS = {
  Get: "GET", Post: "POST", Put: "PUT", Delete: "DELETE",
  Patch: "PATCH", Options: "OPTIONS", Head: "HEAD", All: "ANY", Search: "SEARCH",
};
const NEST_GRAPHQL_DECORATORS = {
  Query: "QUERY", Mutation: "MUTATION", Subscription: "SUBSCRIPTION",
  ResolveField: "RESOLVE_FIELD", ResolveReference: "RESOLVE_REFERENCE",
};

function traverse(node, cb) {
  cb(node);
  for (let i = 0; i < node.childCount; i++) traverse(node.child(i), cb);
}

function text(source, node, limit = MAX_TEXT) {
  return node ? source.slice(node.startIndex, node.endIndex).slice(0, limit) : null;
}

// String literal / template value (static parts; interpolations -> {param}).
function getString(source, node) {
  if (!node) return null;
  if (node.type === "string") {
    let out = "";
    let had = false;
    for (let i = 0; i < node.childCount; i++) {
      if (node.child(i).type === "string_fragment") {
        out += text(source, node.child(i));
        had = true;
      }
    }
    if (had) return out;
    return text(source, node).replace(/^['"`]|['"`]$/g, "");
  }
  if (node.type === "template_string") {
    return text(source, node).replace(/^`|`$/g, "").replace(/\$\{[^}]*\}/g, "{param}");
  }
  return null;
}

function looksLikeRoutePath(p) {
  return p === "" || (typeof p === "string" && p.startsWith("/"));
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

// -------------------------------------------------------------------
// Import detection -> active framework
// -------------------------------------------------------------------
function detectImports(root, source) {
  const mods = new Set();
  traverse(root, (n) => {
    if (n.type === "import_statement") {
      for (let i = 0; i < n.childCount; i++) {
        const c = n.child(i);
        if (c.type === "string") {
          const s = getString(source, c);
          if (s) mods.add(s);
        }
      }
    } else if (n.type === "call_expression") {
      const fn = n.childForFieldName("function");
      if (fn && fn.type === "identifier" && text(source, fn) === "require") {
        const args = n.childForFieldName("arguments");
        const first = args && args.namedChild(0);
        const s = first && getString(source, first);
        if (s) mods.add(s);
      }
    }
  });
  const has = (re) => [...mods].some((m) => re.test(m));
  return {
    express: has(/^express$/),
    fastify: has(/^fastify$/),
    koa: has(/^koa($|-router)|^@koa\/router$/),
    nest: has(/^@nestjs\//),
    loopback: has(/^@loopback\/rest$/),
    vueRouter: has(/^vue-router$/),
  };
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
    kind: fields.kind || "route",
    isRegex: false,
    decorator: fields.decorator || null,
    controllerBase: fields.controllerBase != null ? fields.controllerBase : null,
    version: fields.version != null ? fields.version : null,
    authRequired: fields.authRequired != null ? fields.authRequired : false,
    guards: fields.guards || [],
    requestDTO: fields.requestDTO != null ? fields.requestDTO : null,
    responseDTO: fields.responseDTO != null ? fields.responseDTO : null,
    scope: fields.scope || "file",
    handlerLine: fields.handlerLine != null ? fields.handlerLine : null,
    text: (fields.text || `[${fields.framework}] ${method} ${endpoint}`).slice(0, MAX_TEXT),
    startLine: fields.startLine,
    endLine: fields.endLine,
  };
}

// -------------------------------------------------------------------
// Member-expression helpers (object.property)
// -------------------------------------------------------------------
function memberProperty(source, memberNode) {
  const prop = memberNode.childForFieldName("property");
  return prop ? text(source, prop) : null;
}

// First positional argument node of a call.
function firstArg(callNode) {
  const args = callNode.childForFieldName("arguments");
  return args && args.namedChildCount ? args.namedChild(0) : null;
}
function nthArg(callNode, n) {
  const args = callNode.childForFieldName("arguments");
  return args && args.namedChildCount > n ? args.namedChild(n) : null;
}

// -------------------------------------------------------------------
// Express / Fastify / Koa  — call-based routes
// -------------------------------------------------------------------
function callFramework(fw) {
  return fw.express ? "express" : fw.fastify ? "fastify" : fw.koa ? "koa" : "unknown";
}

function extractCallRoutes(root, source, fw) {
  const routes = [];
  if (!fw.express && !fw.fastify && !fw.koa) return routes;
  const framework = callFramework(fw);

  traverse(root, (node) => {
    if (node.type !== "call_expression") return;
    const fn = node.childForFieldName("function");
    if (!fn || fn.type !== "member_expression") return;
    const prop = memberProperty(source, fn);
    if (!prop) return;
    const li = { startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1 };

    // fastify.route({ method, url })
    if (prop === "route" && fw.fastify) {
      const arg = firstArg(node);
      if (arg && arg.type === "object") {
        const method = objectStringProp(source, arg, "method") || "ANY";
        const url = objectStringProp(source, arg, "url");
        if (url != null) {
          routes.push(makeRoute({
            framework: "fastify", method: method.toUpperCase(), path: url,
            kind: "route", decorator: `${rootName(source, fn)}.route`,
            text: text(source, node), ...li,
          }));
        }
        return;
      }
    }

    const pathArg = firstArg(node);
    const pathStr = getString(source, pathArg);

    // app.use('/prefix', subRouter)  -> mount
    if (prop === "use") {
      if (pathStr != null && looksLikeRoutePath(pathStr)) {
        routes.push(makeRoute({
          framework, method: "ANY", path: pathStr, kind: "mount",
          handler: text(source, nthArg(node, 1), 80),
          decorator: `${rootName(source, fn)}.use`, text: text(source, node), ...li,
        }));
      }
      return;
    }

    // app|router.<verb>('/path', handler)
    const isVerb = CALL_HTTP_VERBS.has(prop) || prop === "all";
    if (!isVerb) return;
    if (pathStr == null || !looksLikeRoutePath(pathStr)) return; // needs a route-like path
    // require a handler arg (filters chained .get(handler) on .route() and getters)
    if (!nthArg(node, 1)) return;

    routes.push(makeRoute({
      framework,
      method: prop === "all" ? "ANY" : prop.toUpperCase(),
      path: pathStr,
      kind: "route",
      decorator: `${rootName(source, fn)}.${prop}`,
      text: text(source, node), ...li,
    }));
  });

  return routes;
}

// Root identifier of a member/call chain (app.foo.get -> "app").
function rootName(source, memberNode) {
  let cur = memberNode.childForFieldName("object");
  while (cur && (cur.type === "member_expression" || cur.type === "call_expression")) {
    cur = cur.type === "call_expression"
      ? cur.childForFieldName("function")
      : cur.childForFieldName("object");
  }
  return cur ? text(source, cur, 40) : null;
}

// String value of a property inside an object literal.
function objectStringProp(source, objNode, key) {
  for (let i = 0; i < objNode.namedChildCount; i++) {
    const pair = objNode.namedChild(i);
    if (pair.type !== "pair") continue;
    const k = pair.childForFieldName("key");
    if (k && text(source, k).replace(/['"]/g, "") === key) {
      const v = pair.childForFieldName("value");
      const s = getString(source, v);
      if (s != null) return s;
      // method: ['GET','POST'] or RequestMethod-like
      if (v && v.type === "array") {
        const parts = [];
        for (let j = 0; j < v.namedChildCount; j++) {
          const e = getString(source, v.namedChild(j));
          if (e) parts.push(e);
        }
        if (parts.length) return parts.join(",");
      }
    }
  }
  return null;
}

// -------------------------------------------------------------------
// NestJS — decorator-based routes
// -------------------------------------------------------------------

// Collect decorator nodes for a class/method. Decorators appear in three
// shapes across the grammar:
//   - own children (some method forms)
//   - preceding siblings in class_body (method decorators)
//   - siblings inside a wrapping export_statement, before the class
// Benign tokens (export/default/abstract/async/comments) are skipped, not
// treated as a boundary.
const DECORATOR_SKIP = new Set(["comment", "export", "default", "abstract", "async"]);

function decoratorsOf(node) {
  const out = [];
  const seen = new Set();
  const add = (c) => {
    if (c.type === "decorator" && !seen.has(c.startIndex)) { out.push(c); seen.add(c.startIndex); }
  };
  for (let i = 0; i < node.childCount; i++) add(node.child(i));

  // `@Controller() export class X` -> decorator is a child of export_statement.
  if (node.parent && node.parent.type === "export_statement") {
    for (let i = 0; i < node.parent.childCount; i++) {
      const c = node.parent.child(i);
      if (c.startIndex >= node.startIndex) break;
      add(c);
    }
  }

  let s = node.previousSibling;
  while (s) {
    if (s.type === "decorator") add(s);
    else if (!DECORATOR_SKIP.has(s.type)) break;
    s = s.previousSibling;
  }
  return out;
}

// { name, argsNode } for a decorator (@Foo or @Foo(...) or @ns.Foo(...)).
function decoratorInfo(source, dec) {
  for (let i = 0; i < dec.childCount; i++) {
    const c = dec.child(i);
    if (c.type === "call_expression") {
      const fn = c.childForFieldName("function");
      const name = fn && fn.type === "member_expression"
        ? memberProperty(source, fn)
        : (fn ? text(source, fn) : null);
      return { name, argsNode: c.childForFieldName("arguments") };
    }
    if (c.type === "identifier") return { name: text(source, c), argsNode: null };
    if (c.type === "member_expression") return { name: memberProperty(source, c), argsNode: null };
  }
  return { name: null, argsNode: null };
}

// First path-ish argument of a decorator: string, array[0], or object{path}.
function decoratorPath(source, argsNode) {
  if (!argsNode) return null;
  for (let i = 0; i < argsNode.namedChildCount; i++) {
    const a = argsNode.namedChild(i);
    const s = getString(source, a);
    if (s != null) return s;
    if (a.type === "array") {
      for (let j = 0; j < a.namedChildCount; j++) {
        const e = getString(source, a.namedChild(j));
        if (e != null) return e;
      }
    }
    if (a.type === "object") {
      const p = objectStringProp(source, a, "path") || objectStringProp(source, a, "name");
      if (p != null) return p;
    }
  }
  return null;
}

function methodName(source, methodNode) {
  const n = methodNode.childForFieldName("name");
  return n ? text(source, n) : null;
}

// Identifier / string arguments of a decorator: @UseGuards(JwtAuthGuard) -> ["JwtAuthGuard"].
function decoratorIdentifierArgs(source, argsNode) {
  const out = [];
  if (!argsNode) return out;
  for (let i = 0; i < argsNode.namedChildCount; i++) {
    const a = argsNode.namedChild(i);
    if (a.type === "identifier") out.push(text(source, a, 80));
    else if (a.type === "member_expression") out.push(text(source, a, 80));
    else {
      const s = getString(source, a);
      if (s != null) out.push(s);
    }
  }
  return out;
}

// First object-literal argument of a decorator call (e.g. @ApiResponse({ type: Dto })).
function firstObjectArg(argsNode) {
  if (!argsNode) return null;
  for (let i = 0; i < argsNode.namedChildCount; i++) {
    if (argsNode.namedChild(i).type === "object") return argsNode.namedChild(i);
  }
  return null;
}

// Value of an object property as source text; arrays return their first element
// (so `type: [Dto]` -> "Dto"). Used to pull responseDTO from @ApiResponse.
function objectPropText(source, objNode, key) {
  if (!objNode || objNode.type !== "object") return null;
  for (let i = 0; i < objNode.namedChildCount; i++) {
    const pair = objNode.namedChild(i);
    if (pair.type !== "pair") continue;
    const k = pair.childForFieldName("key");
    if (k && text(source, k).replace(/['"]/g, "") === key) {
      const v = pair.childForFieldName("value");
      if (!v) return null;
      if (v.type === "array") {
        const e = v.namedChild(0);
        return e ? text(source, e, 80) : null;
      }
      return text(source, v, 80);
    }
  }
  return null;
}

// formal_parameters node of a method_definition.
function methodParamsNode(methodNode) {
  for (let i = 0; i < methodNode.childCount; i++) {
    if (methodNode.child(i).type === "formal_parameters") return methodNode.child(i);
  }
  return null;
}

// Type of the parameter decorated with @Body -> requestDTO ("AddProjectDto").
function bodyParamType(source, methodNode) {
  const params = methodParamsNode(methodNode);
  if (!params) return null;
  for (let i = 0; i < params.namedChildCount; i++) {
    const p = params.namedChild(i);
    if (p.type !== "required_parameter" && p.type !== "optional_parameter") continue;
    let hasBody = false;
    for (let j = 0; j < p.childCount; j++) {
      if (p.child(j).type !== "decorator") continue;
      const { name } = decoratorInfo(source, p.child(j));
      if (name === "Body") hasBody = true;
    }
    if (hasBody) {
      const typeNode = p.childForFieldName("type");
      if (typeNode) return text(source, typeNode, 80).replace(/^:\s*/, "").trim();
    }
  }
  return null;
}

function classMethods(classNode) {
  const body = classNode.childForFieldName("body");
  const out = [];
  if (!body) return out;
  for (let i = 0; i < body.namedChildCount; i++) {
    if (body.namedChild(i).type === "method_definition") out.push(body.namedChild(i));
  }
  return out;
}

function nestMethodRoutes(source, methodNode, ctrl, opts) {
  const decs = decoratorsOf(methodNode);
  if (!decs.length) return [];
  const framework = opts.framework;
  const allowPatterns = opts.allowPatterns; // GraphQL/WS/message need a real @nestjs import
  const handler = methodName(source, methodNode);
  const handlerLine = methodNode.startPosition.row + 1;
  const controllerBase = ctrl.base;
  const routes = [];

  // Method-level metadata: @Version overrides the controller's; @UseGuards
  // merges with the controller's; @ApiResponse({ type }) -> responseDTO;
  // the @Body-decorated parameter's type -> requestDTO.
  let methodVersion = null;
  const methodGuards = [];
  let responseDTO = null;
  for (const dec of decs) {
    const { name, argsNode } = decoratorInfo(source, dec);
    if (name === "Version") {
      const v = decoratorPath(source, argsNode);
      if (v != null) methodVersion = v;
    } else if (name === "UseGuards") {
      methodGuards.push(...decoratorIdentifierArgs(source, argsNode));
    } else if (name === "ApiResponse" || name === "ApiOkResponse" || name === "ApiCreatedResponse") {
      const t = objectPropText(source, firstObjectArg(argsNode), "type");
      if (t && !responseDTO) responseDTO = t.replace(/['"]/g, "");
    }
  }
  const version = methodVersion != null ? methodVersion : ctrl.version;
  const guards = [...ctrl.guards, ...methodGuards];
  const authRequired = guards.length > 0;
  const requestDTO = bodyParamType(source, methodNode);

  for (const dec of decs) {
    const { name, argsNode } = decoratorInfo(source, dec);
    if (!name) continue;
    const li = { startLine: dec.startPosition.row + 1, endLine: dec.endPosition.row + 1 };
    const argPath = decoratorPath(source, argsNode);

    if (NEST_HTTP_DECORATORS[name]) {
      let composedPath = joinPaths(controllerBase, argPath);
      if (version != null && version !== "") composedPath = joinPaths("/v" + version, composedPath);
      routes.push(makeRoute({
        framework, method: NEST_HTTP_DECORATORS[name],
        path: composedPath, kind: "route",
        handler, handlerLine, scope: "function",
        controllerBase: controllerBase || null,
        version: version != null ? version : null,
        authRequired, guards, requestDTO, responseDTO,
        decorator: `@${name}`, text: text(source, dec), ...li,
      }));
    } else if (allowPatterns && NEST_GRAPHQL_DECORATORS[name]) {
      routes.push(makeRoute({
        framework: "nestjs", method: NEST_GRAPHQL_DECORATORS[name],
        path: argPath || handler, kind: "graphql",
        handler, handlerLine, scope: "function",
        decorator: `@${name}`, text: text(source, dec), ...li,
      }));
    } else if (allowPatterns && name === "SubscribeMessage") {
      routes.push(makeRoute({
        framework: "nestjs", method: "WS",
        path: argPath || handler, kind: "ws",
        handler, handlerLine, scope: "function",
        decorator: `@${name}`, text: text(source, dec), ...li,
      }));
    } else if (allowPatterns && (name === "MessagePattern" || name === "EventPattern")) {
      routes.push(makeRoute({
        framework: "nestjs", method: name === "EventPattern" ? "EVENT" : "MESSAGE",
        path: argPath || text(source, firstArgOf(argsNode), 80) || handler,
        kind: "message", handler, handlerLine, scope: "function",
        decorator: `@${name}`, text: text(source, dec), ...li,
      }));
    }
  }
  return routes;
}

function firstArgOf(argsNode) {
  return argsNode && argsNode.namedChildCount ? argsNode.namedChild(0) : null;
}

// @Controller('base') | @Controller({ path: 'base' }) -> { has, base }
function controllerInfo(source, classNode) {
  let has = false;
  let base = "";
  let version = null;
  const guards = [];
  for (const dec of decoratorsOf(classNode)) {
    const { name, argsNode } = decoratorInfo(source, dec);
    if (name === "Controller") {
      has = true;
      base = decoratorPath(source, argsNode) || "";
      // @Controller({ path, version }) — recover version if declared here.
      const v = objectPropText(source, firstObjectArg(argsNode), "version");
      if (v != null) version = v.replace(/['"]/g, "");
    } else if (name === "Version") {
      const v = decoratorPath(source, argsNode);
      if (v != null) version = v;
    } else if (name === "UseGuards") {
      guards.push(...decoratorIdentifierArgs(source, argsNode));
    }
  }
  return { has, base, version, guards };
}

// Decorator routes fire when the file imports @nestjs/* OR a class carries a
// @Controller decorator (custom NestJS-like frameworks are common — e.g. a
// homegrown core.ts defining @Controller/@Get). Without a @nestjs import the
// framework is tagged "nestjs-like", and GraphQL/WS/message patterns stay gated
// on the real import (those resolver classes lack the @Controller signal).
function extractDecoratorRoutes(root, source, fw) {
  const routes = [];
  traverse(root, (node) => {
    if (node.type !== "class_declaration" && node.type !== "class") return;
    const ctrl = controllerInfo(source, node);
    if (!fw.nest && !ctrl.has) return;
    const opts = {
      framework: fw.nest ? "nestjs" : "nestjs-like",
      allowPatterns: fw.nest,
    };
    for (const m of classMethods(node)) {
      routes.push(...nestMethodRoutes(source, m, ctrl, opts));
    }
  });
  return routes;
}

// -------------------------------------------------------------------
// LoopBack 4 — decorator-based routes
//
// Lowercase verb decorators imported from @loopback/rest. Unlike NestJS the
// full path lives in each method decorator's first argument (there is no
// class-level base path), and DELETE is spelled @del. The path argument is
// frequently a string concatenation of a config-prefix constant and a literal
// (appConfig.apiPath + '/roles'); the constant resolves cross-file, so it is
// emitted as an unresolved {token} (e.g. {apiPath}/roles) — same convention
// the graph already uses for version tokens.
// -------------------------------------------------------------------
const LOOPBACK_HTTP_DECORATORS = {
  get: "GET", post: "POST", put: "PUT", patch: "PATCH", del: "DELETE",
};

// Build a path string from a decorator's first argument: string/template
// literals as-is, `a + b` concatenations joined, and identifier / member
// operands (prefix constants like appConfig.apiPath) rendered as {token}.
function loopbackPathExpr(source, node) {
  if (!node) return null;
  // Template literal: render ${appConfig.apiPathV2} as {apiPathV2} (vs getString's
  // generic {param}) so the prefix token matches the concatenation form.
  if (node.type === "template_string") {
    let out = "";
    for (let i = 0; i < node.childCount; i++) {
      const c = node.child(i);
      if (c.type === "string_fragment") out += text(source, c);
      else if (c.type === "template_substitution") {
        const r = loopbackPathExpr(source, c.namedChild(0));
        out += r != null ? r : "{param}";
      }
    }
    return out;
  }
  const s = getString(source, node);
  if (s != null) return s;
  if (node.type === "binary_expression") {
    const l = loopbackPathExpr(source, node.childForFieldName("left"));
    const r = loopbackPathExpr(source, node.childForFieldName("right"));
    if (l == null && r == null) return null;
    return (l || "") + (r || "");
  }
  if (node.type === "member_expression") {
    const prop = memberProperty(source, node); // appConfig.apiPath -> {apiPath}
    return prop ? `{${prop}}` : null;
  }
  if (node.type === "identifier") {
    return `{${text(source, node)}}`;
  }
  if (node.type === "parenthesized_expression") {
    return loopbackPathExpr(source, node.namedChild(0));
  }
  return null;
}

function loopbackMethodRoutes(source, methodNode, framework) {
  const decs = decoratorsOf(methodNode);
  if (!decs.length) return [];
  const handler = methodName(source, methodNode);
  const handlerLine = methodNode.startPosition.row + 1;
  const routes = [];
  for (const dec of decs) {
    const { name, argsNode } = decoratorInfo(source, dec);
    if (!name || !LOOPBACK_HTTP_DECORATORS[name]) continue;
    const argPath = loopbackPathExpr(source, firstArgOf(argsNode));
    if (argPath == null) continue;
    const li = { startLine: dec.startPosition.row + 1, endLine: dec.endPosition.row + 1 };
    routes.push(makeRoute({
      framework, method: LOOPBACK_HTTP_DECORATORS[name],
      path: argPath, kind: "route",
      handler, handlerLine, scope: "function",
      decorator: `@${name}`, text: text(source, dec), ...li,
    }));
  }
  return routes;
}

// LoopBack controllers carry no @Controller decorator and no @nestjs import,
// so they need their own gate: the @loopback/rest import. Every class in such
// a file is treated as a controller (LoopBack controllers are plain classes).
function extractLoopbackRoutes(root, source, fw) {
  const routes = [];
  if (!fw.loopback) return routes;
  traverse(root, (node) => {
    if (node.type !== "class_declaration" && node.type !== "class") return;
    for (const m of classMethods(node)) {
      routes.push(...loopbackMethodRoutes(source, m, "loopback"));
    }
  });
  return routes;
}

// -------------------------------------------------------------------
// Vue Router (frontend): routes: [{ path, component, children }]
// Page-routes (path -> component), no HTTP method. Tagged method "VIEW",
// kind "page", framework "vue-router". Nested children are path-composed.
// -------------------------------------------------------------------
function keyName(source, node) {
  return node ? text(source, node).replace(/['"]/g, "") : null;
}

function objectPairValue(source, objNode, key) {
  for (let i = 0; i < objNode.namedChildCount; i++) {
    const pair = objNode.namedChild(i);
    if (pair.type !== "pair") continue;
    if (keyName(source, pair.childForFieldName("key")) === key) return pair.childForFieldName("value");
  }
  return null;
}

// Resolve a `component` value to a name: Identifier, string, or lazy
// () => import('./User.vue') -> "User.vue".
function componentName(source, node) {
  if (!node) return null;
  if (node.type === "identifier") return text(source, node, 80);
  const s = getString(source, node);
  if (s != null) return s;
  let comp = null;
  traverse(node, (x) => {
    if (comp || x.type !== "call_expression") return;
    const fn = x.childForFieldName("function");
    if (fn && (fn.type === "import" || text(source, fn) === "import")) {
      const m = getString(source, firstArg(x));
      if (m != null) comp = m.replace(/^.*\//, ""); // basename
    }
  });
  return comp || text(source, node, 60);
}

function joinVuePath(base, child) {
  if (!child) return base || "/";
  if (child.startsWith("/")) return child;         // absolute child
  if (!base) return "/" + child;
  return (base.endsWith("/") ? base.slice(0, -1) : base) + "/" + child;
}

function walkRouteArray(source, arrayNode, basePath, out) {
  for (let i = 0; i < arrayNode.namedChildCount; i++) {
    const obj = arrayNode.namedChild(i);
    if (obj.type !== "object") continue;
    const pathVal = objectPairValue(source, obj, "path");
    const p = getString(source, pathVal);
    if (p == null) continue; // every Vue route has a path
    const full = joinVuePath(basePath, p);
    const nameVal = objectPairValue(source, obj, "name");
    const li = { startLine: obj.startPosition.row + 1, endLine: obj.endPosition.row + 1 };
    out.push(makeRoute({
      framework: "vue-router", method: "VIEW", path: full, kind: "page",
      handler: componentName(source, objectPairValue(source, obj, "component")),
      decorator: nameVal ? getString(source, nameVal) : null, // route name
      text: text(source, obj, 120), ...li,
    }));
    const children = objectPairValue(source, obj, "children");
    if (children && children.type === "array") walkRouteArray(source, children, full, out);
  }
}

function extractVueRouterRoutes(root, source, fw) {
  const out = [];
  if (!fw.vueRouter) return out;
  const arrays = new Set();
  traverse(root, (n) => {
    if (n.type === "variable_declarator") {
      const name = n.childForFieldName("name");
      const val = n.childForFieldName("value");
      if (name && text(source, name) === "routes" && val && val.type === "array") arrays.add(val);
    } else if (n.type === "pair") {
      const v = n.childForFieldName("value");
      if (keyName(source, n.childForFieldName("key")) === "routes" && v && v.type === "array") arrays.add(v);
    }
  });
  for (const arr of arrays) walkRouteArray(source, arr, "", out);
  return out;
}

// -------------------------------------------------------------------
// Public entry
// -------------------------------------------------------------------
function extractRoutesFromTree(source, tree) {
  const root = tree.rootNode;
  const fw = detectImports(root, source);
  const routes = [
    ...extractCallRoutes(root, source, fw),
    ...extractDecoratorRoutes(root, source, fw),
    ...extractLoopbackRoutes(root, source, fw),
    ...extractVueRouterRoutes(root, source, fw),
  ];
  routes.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  return routes;
}

/**
 * Attach extracted routes to a file's data: function-scoped routes go onto
 * their handler function (matched by name + startLine), file-scoped routes
 * (and unmatched ones) go to the file-level statements array.
 */
function attachRoutes(routes, functions, statements) {
  if (!routes || !routes.length) return;
  routes.forEach((rt) => {
    if (rt.scope === "function") {
      const fn = functions.find(
        (f) => f.name === rt.handler && f.startLine === rt.handlerLine
      );
      if (fn) {
        (fn.statements || (fn.statements = [])).push(rt);
        return;
      }
    }
    statements.push(rt);
  });
}

module.exports = { extractRoutesFromTree, attachRoutes };
