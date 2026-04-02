#!/usr/bin/env node
/**
 * generate-proxy-artifact.cjs
 * Copie InvestOrProxy sous le nom ERC1967Proxy UNIQUEMENT dans le chemin
 * attendu par Ignition. Ne crée PAS de doublon dans contracts/Proxies.sol.
 */
const fs   = require("fs");
const path = require("path");

const ARTIFACTS_DIR = path.join(process.cwd(), "artifacts");
const SOURCE_FILE   = path.join(ARTIFACTS_DIR, "contracts", "Proxies.sol", "InvestOrProxy.json");

// Chemin Ignition uniquement
const IGNITION_DIR  = path.join(ARTIFACTS_DIR, "npm", "@openzeppelin", "contracts", "proxy", "ERC1967");
const IGNITION_FILE = path.join(IGNITION_DIR, "ERC1967Proxy.json");

try {
  if (!fs.existsSync(SOURCE_FILE)) {
    console.log("⚠️  InvestOrProxy non trouvé — ignoré.");
    process.exit(0);
  }

  const artifact = JSON.parse(fs.readFileSync(SOURCE_FILE, "utf8"));
  const proxyArtifact = { ...artifact, contractName: "ERC1967Proxy" };

  // Écrire UNIQUEMENT dans le chemin Ignition
  fs.mkdirSync(IGNITION_DIR, { recursive: true });
  fs.writeFileSync(IGNITION_FILE, JSON.stringify(proxyArtifact, null, 2));

  console.log(`✅  ERC1967Proxy artifact généré depuis InvestOrProxy (Ignition uniquement)`);
} catch (err) {
  console.error("❌  generate-proxy-artifact:", err.message);
  process.exit(1);
}
