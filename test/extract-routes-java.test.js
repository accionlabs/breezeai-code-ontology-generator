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

console.log(`\n✅ All ${passed} assertions passed.`);
