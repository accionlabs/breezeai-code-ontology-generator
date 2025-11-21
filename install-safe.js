const isNpx = process.env.npm_execpath && process.env.npm_execpath.includes("npx");

if (isNpx) {
  console.log("Skipping postinstall during npx install.");
  process.exit(0);   // IMPORTANT: exit cleanly, no error!
}

try {
  require("child_process").execSync("patch-package && npm rebuild tree-sitter-perl", {
    stdio: "inherit",
  });
  process.exit(0);
} catch (err) {
  console.error("Postinstall failed:", err);
  process.exit(0);  // DO NOT FAIL INSTALL!
}
