/**
 * Regression test for the Java web-route extractor (Spring + JAX-RS).
 * Run: node test/extract-routes-java.test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { extractFileRoutes } = require("../java/extract-routes-java");

let passed = 0;
function check(name, cond) {
  assert.ok(cond, name);
  passed++;
}

function withTempFile(name, content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jroutes-test-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const find = (routes, p) => routes.find((r) => r.path === p);

// ----------------------------------------------------------------- Spring ----
withTempFile("UserController.java", `
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/users")
public class UserController {

    @GetMapping("/{id}")
    public User get(@PathVariable Long id) { return null; }

    @PostMapping
    public User create(@RequestBody User u) { return null; }

    @RequestMapping(value = "/search", method = RequestMethod.POST)
    public java.util.List<User> search() { return null; }

    @DeleteMapping(path = "/{id}/archive")
    public void archive(@PathVariable Long id) {}

    @RequestMapping(value = "/bulk", method = {RequestMethod.PUT, RequestMethod.PATCH})
    public void bulk() {}
}
`, (file) => {
  const r = extractFileRoutes(file);
  check("spring: 5 routes", r.length === 5);
  check("spring: all framework=spring", r.every((x) => x.framework === "spring"));
  check("spring: base path composed with method path",
    find(r, "/api/users/{id}").method === "GET");
  check("spring: @PostMapping no-arg uses base path",
    find(r, "/api/users").method === "POST");
  check("spring: @RequestMapping method= resolved",
    find(r, "/api/users/search").method === "POST");
  check("spring: path= attribute parsed",
    find(r, "/api/users/{id}/archive").method === "DELETE");
  check("spring: method array -> joined",
    find(r, "/api/users/bulk").method === "PUT,PATCH");
  check("spring: handler + function scope",
    find(r, "/api/users/{id}").handler === "get" &&
    find(r, "/api/users/{id}").scope === "function");
});

// ----------------------------------------------------------------- JAX-RS ----
withTempFile("OrderResource.java", `
package com.example;
import javax.ws.rs.*;

@Path("/orders")
public class OrderResource {

    @GET
    @Path("/{id}")
    public Order find(@PathParam("id") String id) { return null; }

    @POST
    public Order create(Order o) { return null; }

    @DELETE
    @Path("/{id}")
    public void remove(@PathParam("id") String id) {}
}
`, (file) => {
  const r = extractFileRoutes(file);
  check("jaxrs: 3 routes", r.length === 3);
  check("jaxrs: all framework=jaxrs", r.every((x) => x.framework === "jaxrs"));
  check("jaxrs: @GET + @Path composed", find(r, "/orders/{id}") &&
    r.filter((x) => x.path === "/orders/{id}").some((x) => x.method === "GET"));
  check("jaxrs: marker without @Path uses class base",
    find(r, "/orders").method === "POST");
  check("jaxrs: @DELETE method", r.some((x) => x.method === "DELETE" && x.path === "/orders/{id}"));
  check("jaxrs: function-scoped with handler",
    r.every((x) => x.scope === "function" && x.handler));
});

// --------------------------------------------------------- plain POJO -------
withTempFile("Plain.java", `
package com.example;
public class Plain {
    public int add(int a, int b) { return a + b; }
}
`, (file) => {
  const r = extractFileRoutes(file);
  check("plain class: no routes", r.length === 0);
});

// --------------------------------------------------- multi-path (AC2) -------
withTempFile("MultiPathController.java", `
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/items")
public class MultiPathController {

    @GetMapping({"/a", "/b"})
    public void multi() {}

    @RequestMapping(value = {"/x", "/y"}, method = RequestMethod.GET)
    public void mv() {}

    @PostMapping
    public void noArg() {}
}
`, (file) => {
  const r = extractFileRoutes(file);
  check("multi-path: array emits one route per path",
    find(r, "/api/items/a") && find(r, "/api/items/b"));
  check("multi-path: named value-array emits one route per path",
    find(r, "/api/items/x") && find(r, "/api/items/y"));
  check("multi-path: both array paths share the handler",
    find(r, "/api/items/a").handler === "multi" && find(r, "/api/items/b").handler === "multi");
  check("multi-path: no-arg mapping still emits exactly one route",
    r.filter((x) => x.handler === "noArg").length === 1 && find(r, "/api/items").handler === "noArg");
});

// ------------------------------------------ requestDTO (@RequestBody) -------
withTempFile("DtoController.java", `
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/orders")
public class DtoController {

    @PostMapping
    public Order create(@RequestBody OrderDto body) { return null; }

    @GetMapping("/{id}")
    public Order get(@PathVariable Long id) { return null; }
}
`, (file) => {
  const r = extractFileRoutes(file);
  check("requestDTO: @RequestBody type captured on route",
    find(r, "/api/orders").requestDTO === "OrderDto");
  check("requestDTO: null when no @RequestBody",
    find(r, "/api/orders/{id}").requestDTO === null);
});

// ----------------------------------------- non-literal paths (AC5) ----------
withTempFile("NonLiteralController.java", `
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
public class NonLiteralController {

    @GetMapping(Paths.USERS)
    public void byConstant() {}

    @GetMapping("\${app.users.path}")
    public void byPlaceholder() {}

    @RequestMapping(Const.API + "/orders")
    public void byConcat() {}
}
`, (file) => {
  const r = extractFileRoutes(file);
  check("non-literal: constant -> {lastSegment} token",
    find(r, "/api/{USERS}") && find(r, "/api/{USERS}").handler === "byConstant");
  check("non-literal: placeholder \${x} -> {x}",
    find(r, "/api/{app.users.path}") !== undefined);
  check("non-literal: string concat -> joined tokens",
    find(r, "/api/{API}/orders") !== undefined);
  check("non-literal: constant route not silently emitted as base-only",
    !r.some((x) => x.handler === "byConstant" && x.path === "/api"));
});

// --------------------------------- functional WebFlux (AC8 / call-based) ----
withTempFile("UserRoutes.java", `
package com.example;
import org.springframework.web.reactive.function.server.*;

public class UserRoutes {
    public RouterFunction<ServerResponse> routes(UserHandler h) {
        return RouterFunctions.route()
            .GET("/flux/users", h::all)
            .POST("/flux/users", h::create)
            .build();
    }
}
`, (file) => {
  const r = extractFileRoutes(file);
  check("webflux: builder GET captured", find(r, "/flux/users") &&
    r.some((x) => x.method === "GET" && x.path === "/flux/users"));
  check("webflux: builder POST captured",
    r.some((x) => x.method === "POST" && x.path === "/flux/users"));
  check("webflux: framework + file scope",
    r.every((x) => x.framework === "spring-webflux" && x.scope === "file"));
  check("webflux: handler from method reference",
    r.find((x) => x.method === "GET").handler === "all");
});

// import-gate: an uppercase .GET() without the WebFlux import is NOT a route.
withTempFile("CacheUser.java", `
package com.example;
public class CacheUser {
    void warm(Cache c) { c.GET("/not/a/route"); }
}
`, (file) => {
  const r = extractFileRoutes(file);
  check("webflux gate: no import -> no functional routes", r.length === 0);
});

// --------------------------- composed / meta-annotations (same-file) --------
withTempFile("ComposedController.java", `
package com.example;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api")
class ComposedController {
    @GetJson("/things")
    public Object things() { return null; }

    @PostJson
    public Object make() { return null; }
}

@GetMapping(produces = "application/json")
@interface GetJson { String[] value() default {}; }

@RequestMapping(method = RequestMethod.POST)
@interface PostJson {}
`, (file) => {
  const r = extractFileRoutes(file);
  check("composed: @GetJson -> GET, path from usage + base",
    find(r, "/api/things") && find(r, "/api/things").method === "GET" &&
    find(r, "/api/things").decorator === "@GetJson");
  check("composed: @PostJson (no path) -> POST on base",
    r.some((x) => x.method === "POST" && x.path === "/api" && x.handler === "make"));
});

// a custom annotation NOT meta-annotated with a mapping is not a route.
withTempFile("PlainAnno.java", `
package com.example;
class C {
    @Audited
    public void run() {}
}
@interface Audited {}
`, (file) => {
  const r = extractFileRoutes(file);
  check("composed gate: non-mapping custom annotation -> no route", r.length === 0);
});

console.log(`\n✅ All ${passed} assertions passed.`);
