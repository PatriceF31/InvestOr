#!/usr/bin/env node
/**
 * generate-proxy-artifact.cjs
 * Recrée l'artifact ERC1967Proxy depuis le build-info après chaque compilation.
 * À appeler via : "postcompile" dans package.json
 */

const fs   = require("fs");
const path = require("path");

const BUILD_INFO_DIR = path.join(process.cwd(), "artifacts", "build-info");
const OUTPUT_DIR     = path.join(process.cwd(), "artifacts", "contracts", "Proxies.sol");
const OUTPUT_FILE    = path.join(OUTPUT_DIR, "ERC1967Proxy.json");
const SOURCE_KEY_RE  = /proxy\/ERC1967\/ERC1967Proxy\.sol$/;

function findOutputFile() {
  const files = fs.readdirSync(BUILD_INFO_DIR).filter(f => f.endsWith(".output.json"));
  if (!files.length) throw new Error("Aucun fichier build-info .output.json trouvé");
  // Prendre le plus récent
  return files
    .map(f => ({ f, mtime: fs.statSync(path.join(BUILD_INFO_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0].f;
}

function findInputFile() {
  const files = fs.readdirSync(BUILD_INFO_DIR)
    .filter(f => f.endsWith(".json") && !f.endsWith(".output.json"));
  if (!files.length) throw new Error("Aucun fichier build-info .json trouvé");
  return files
    .map(f => ({ f, mtime: fs.statSync(path.join(BUILD_INFO_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0].f;
}

try {
  const outputFile = findOutputFile();
  const inputFile  = findInputFile();
  const buildInfoId = inputFile.replace(".json", "");

  const data     = JSON.parse(fs.readFileSync(path.join(BUILD_INFO_DIR, outputFile), "utf8"));
  const contracts = data.output?.contracts ?? {};

  // Trouver la clé ERC1967Proxy (indépendamment de la version OZ)
  const sourceKey = Object.keys(contracts).find(k => SOURCE_KEY_RE.test(k));
  if (!sourceKey) {
    console.log("⚠️  ERC1967Proxy non trouvé dans le build-info — ignoré.");
    process.exit(0);
  }

  const contractData = contracts[sourceKey]["ERC1967Proxy"];
  const artifact = {
    _format:                "hh-sol-artifact-1",
    contractName:           "ERC1967Proxy",
    sourceName:             sourceKey,
    abi:                    contractData.abi,
    bytecode:               contractData.evm.bytecode.object,
    deployedBytecode:       contractData.evm.deployedBytecode.object,
    linkReferences:         contractData.evm.bytecode.linkReferences         ?? {},
    deployedLinkReferences: contractData.evm.deployedBytecode.linkReferences ?? {},
    immutableReferences:    contractData.evm.deployedBytecode.immutableReferences ?? {},
    inputSourceName:        sourceKey,
    buildInfoId,
  };

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(artifact, null, 2));
  console.log(`✅  ERC1967Proxy artifact généré (${sourceKey})`);
} catch (err) {
  console.error("❌  generate-proxy-artifact:", err.message);
  process.exit(1);
}
