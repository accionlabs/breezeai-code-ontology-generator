/**
 * Regression test for the C# / ASP.NET web-route extractor.
 * Covers controllers ([HttpGet]/[Route] + [controller] token) and minimal APIs.
 * Run: node test/extract-routes-csharp.test.js
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { extractFileRoutes } = require("../csharp/extract-routes-csharp");

let passed = 0;
function check(name, cond) {
  assert.ok(cond, name);
  passed++;
}

function withTempFile(name, content, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "csroutes-test-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  try {
    return fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const find = (routes, p) => routes.find((r) => r.path === p);

// ------------------------------------------------------------ Controllers ----
withTempFile("UsersController.cs", `
using Microsoft.AspNetCore.Mvc;

[ApiController]
[Route("api/[controller]")]
public class UsersController : ControllerBase
{
    [HttpGet]
    public IActionResult GetAll() => Ok();

    [HttpGet("{id}")]
    public IActionResult Get(int id) => Ok();

    [HttpPost]
    public IActionResult Create() => Ok();

    [HttpPut("{id}")]
    [HttpPatch("{id}")]
    public IActionResult Update(int id) => Ok();

    [Route("search")]
    public IActionResult Search() => Ok();
}
`, (file) => {
  const r = extractFileRoutes(file);
  check("controllers: framework aspnet", r.every((x) => x.framework === "aspnet"));
  check("controllers: [controller] token expanded", find(r, "api/Users").method === "GET" &&
    find(r, "api/Users").handler === "GetAll");
  check("controllers: base + template composed", find(r, "api/Users/{id}") &&
    r.some((x) => x.path === "api/Users/{id}" && x.method === "GET" && x.handler === "Get"));
  check("controllers: [HttpPost] no template -> base", find(r, "api/Users").handler &&
    r.some((x) => x.path === "api/Users" && x.method === "POST"));
  check("controllers: stacked verbs -> two routes",
    r.filter((x) => x.handler === "Update").length === 2);
  check("controllers: PUT + PATCH both present",
    r.some((x) => x.handler === "Update" && x.method === "PUT") &&
    r.some((x) => x.handler === "Update" && x.method === "PATCH"));
  check("controllers: [Route] w/o verb -> ANY", find(r, "api/Users/search").method === "ANY");
  check("controllers: function-scoped + handlerLine",
    r.every((x) => x.scope === "function" && x.handlerLine != null));
});

// ----------------------------------------------------------- Minimal APIs ----
withTempFile("Program.cs", `
var builder = WebApplication.CreateBuilder(args);
var app = builder.Build();

app.MapGet("/hello", () => "Hi");
app.MapPost("/users", (User u) => Results.Ok());
app.MapDelete("/users/{id}", (int id) => Results.NoContent());
app.MapMethods("/multi", new[] { "GET", "POST" }, () => Results.Ok());
app.MapHub<ChatHub>("/chat");

app.Run();
`, (file) => {
  const r = extractFileRoutes(file);
  check("minimal: framework aspnet", r.every((x) => x.framework === "aspnet"));
  check("minimal: MapGet", find(r, "/hello").method === "GET");
  check("minimal: MapPost", find(r, "/users").method === "POST");
  check("minimal: MapDelete param path", find(r, "/users/{id}").method === "DELETE");
  check("minimal: MapMethods joined", find(r, "/multi").method === "GET,POST");
  check("minimal: MapHub -> ws", find(r, "/chat").kind === "ws" && find(r, "/chat").method === "WS");
  check("minimal: file-scoped", r.every((x) => x.scope === "file"));
});

// ----------------------------------------------------------- plain class -----
withTempFile("Plain.cs", `
public class Calculator {
    public int Add(int a, int b) => a + b;
}
`, (file) => {
  check("plain class: no routes", extractFileRoutes(file).length === 0);
});

console.log(`\n✅ All ${passed} assertions passed.`);
