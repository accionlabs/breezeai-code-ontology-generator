/**
 * Regression test for the VB.NET / ASP.NET web-route extractor.
 * Covers controller actions with <HttpGet>/<Route> attributes, the
 * [controller] token, stacked verbs, and class-base composition.
 * Run: node test/extract-routes-vbnet.test.js
 */
const assert = require("assert");
const { extractRoutesFromSource } = require("../vbnet/extract-routes-vbnet");

let passed = 0;
function check(name, cond) {
  assert.ok(cond, name);
  passed++;
}

const find = (routes, p) => routes.find((r) => r.path === p);

// ------------------------------------------------------------ Controller ----
const controller = `Imports Microsoft.AspNetCore.Mvc

<ApiController>
<Route("api/[controller]")>
Public Class UsersController
    Inherits ControllerBase

    <HttpGet>
    Public Function GetAll() As IActionResult
        Return Ok()
    End Function

    <HttpGet("{id}")>
    Public Function GetUser(id As Integer) As IActionResult
        Return Ok()
    End Function

    <HttpPost>
    Public Function Create() As IActionResult
        Return Ok()
    End Function

    <HttpPut("{id}")>
    <HttpPatch("{id}")>
    Public Function Update(id As Integer) As IActionResult
        Return Ok()
    End Function

    <Route("search")>
    Public Function Search() As IActionResult
        Return Ok()
    End Function
End Class`;

(() => {
  const r = extractRoutesFromSource(controller);
  check("vbnet: framework aspnet", r.every((x) => x.framework === "aspnet"));
  check("vbnet: [controller] token expanded + <HttpGet> no template -> base",
    find(r, "api/Users") && find(r, "api/Users").method === "GET" &&
    find(r, "api/Users").handler === "GetAll");
  check("vbnet: base + template composed",
    r.some((x) => x.path === "api/Users/{id}" && x.method === "GET" && x.handler === "GetUser"));
  check("vbnet: <HttpPost> -> base POST",
    r.some((x) => x.path === "api/Users" && x.method === "POST" && x.handler === "Create"));
  check("vbnet: stacked verbs -> two routes",
    r.filter((x) => x.handler === "Update").length === 2);
  check("vbnet: PUT + PATCH both present",
    r.some((x) => x.handler === "Update" && x.method === "PUT") &&
    r.some((x) => x.handler === "Update" && x.method === "PATCH"));
  check("vbnet: <Route> without verb -> ANY", find(r, "api/Users/search").method === "ANY");
  check("vbnet: function-scoped with handlerLine at Function line",
    r.every((x) => x.scope === "function" && x.handlerLine != null));
  check("vbnet: GetAll handlerLine = its Function line (9)",
    find(r, "api/Users").handlerLine === 9);
})();

// ------------------------------------------------------ same-line attrs ----
// VB allows comma-separated attributes inside one <...>.
(() => {
  const src = `<Route("orders")>
Public Class OrdersController
    <HttpGet("{id}"), Produces("application/json")>
    Public Function Get(id As Integer) As IActionResult
        Return Ok()
    End Function
End Class`;
  const r = extractRoutesFromSource(src);
  check("vbnet: comma-separated attrs -> route extracted",
    find(r, "orders/{id}") && find(r, "orders/{id}").method === "GET");
})();

// ------------------------------------------- MVC5 <RoutePrefix> + Namespace ----
// Real-repo shape (recaptcha-mvc): MVC5 uses <RoutePrefix> on the class (not
// <Route>), inside a Namespace, with no method modifier and a BOM.
(() => {
  const src = "﻿Imports System.Web.Mvc\n" +
`Namespace Controllers
    <RoutePrefix("auth")>
    Public Class AuthController
        Inherits Controller
        <Route("sign-in")>
        <HttpGet>
        Function SignIn() As ActionResult
        End Function
        <Route("sign-in")>
        <HttpPost>
        Function SignInPost() As ActionResult
        End Function
    End Class
End Namespace`;
  const r = extractRoutesFromSource(src);
  check("vbnet: RoutePrefix composed into path", find(r, "auth/sign-in") != null);
  check("vbnet: GET + POST under prefix",
    r.some((x) => x.method === "GET" && x.path === "auth/sign-in") &&
    r.some((x) => x.method === "POST" && x.path === "auth/sign-in"));
  check("vbnet: handler from no-modifier Function", find(r, "auth/sign-in").handler === "SignIn");
})();

// ------------------------------------------------------------- plain class ----
(() => {
  const src = `Public Class Calculator
    Public Function Add(a As Integer, b As Integer) As Integer
        Return a + b
    End Function
End Class`;
  check("vbnet: plain class -> no routes", extractRoutesFromSource(src).length === 0);
})();

console.log(`\n✅ All ${passed} assertions passed.`);
