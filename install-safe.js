const { execSync } = require("child_process");
const isWindows = process.platform === "win32";
const isNpx = process.env.npm_execpath && process.env.npm_execpath.includes("npx");

// On Windows with npx, we need to handle native module building differently
if (isNpx) {
  console.log("⚙️  Detected npx installation, running setup...");
}

try {
  // Apply patches first
  try {
    execSync("npx patch-package", {
      stdio: "inherit",
      shell: isWindows ? "cmd.exe" : undefined
    });
  } catch (err) {
    console.warn("⚠️  patch-package failed (this is usually okay):", err.message);
  }

  // Try to rebuild native modules
  try {
    const rebuildCmd = isWindows 
      ? "npm rebuild tree-sitter tree-sitter-perl --ignore-scripts=false"
      : "npm rebuild tree-sitter-perl";
    
    execSync(rebuildCmd, {
      stdio: "inherit",
      shell: isWindows ? "cmd.exe" : undefined
    });
  } catch (err) {
    console.warn("⚠️  Native module rebuild failed (tree-sitter-perl may not work):", err.message);
  }

  console.log("✅ Post-install setup completed");
  process.exit(0);
} catch (err) {
  console.error("⚠️  Postinstall had issues:", err.message);
  console.log("✅ Continuing anyway - some features may not work");
  process.exit(0);  // DO NOT FAIL INSTALL!
}
