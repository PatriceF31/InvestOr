// scripts/deploy-morpho-yield-strategy.ts
//
// Déploie la brique "poche rendement" (2.2) sur Sepolia :
//   1. Crée l'oracle MorphoChainlinkOracleV2 (cbBTC/USDC, via Chainlink BTC/USD)
//   2. Crée le marché Morpho Blue isolé (cbBTC collatéral, USDC prêté, LLTV 86%)
//   3. Déploie MorphoYieldStrategy (proxy UUPS)
//   4. Configure le marché sur la stratégie
//   5. Transfère l'ownership de la stratégie à Reserve
//
// Ce script s'arrête à l'étape 5 — toutes exécutables par le wallet de
// déploiement seul. L'étape 6 (Treasury.yieldStrategy via Reserve) N'EST PAS
// incluse ici : Reserve est owned par le Gnosis Safe (2/3), pas par un EOA.
// Cette dernière étape doit être proposée et signée via le Safe (voir le
// récapitulatif affiché en fin de script pour les paramètres exacts à entrer
// dans app.safe.global → Transaction Builder).
//
// Prérequis : adresses TREASURY_PROXY / RESERVE_PROXY à jour ci-dessous.
// Usage (Hardhat 3, réseau Sepolia configuré) :
//   npx hardhat run scripts/deploy-morpho-yield-strategy.ts --network sepolia

import { network } from "hardhat";

// ─── Adresses externes vérifiées (Sepolia) ─────────────────────────────────
const MORPHO_BLUE           = "0xd011EE229E7459ba1ddd22631eF7bF528d424A14";
const MORPHO_ORACLE_FACTORY = "0xa6c843fc53aAf6EF1d173C4710B26419667bF6CD";
const CHAINLINK_BTC_USD     = "0x1b44F3514812d835EB1BDB0acB33d3fA3351Ee43";
const ADAPTIVE_CURVE_IRM    = "0x8C5dDCD3F601c91D1BF51c8ec26066010ACAbA7c";
const USDC_CIRCLE           = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";
const CBBTC                 = "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf";
const LLTV_86                = 860000000000000000n; // 86 % en WAD (18 décimales)

// ─── Adresses InvestOr existantes — À VÉRIFIER avant exécution ────────────
const TREASURY_PROXY = "0xcCb3508f3Dc41e0AeE7FFedB0f410aB555Ff40af";
const RESERVE_PROXY  = "0x130A6A02eee28C4f9A5b01B854ce4aE7BE7D65Ce";

async function main() {
  const { ethers } = await network.create();
  const [deployer] = await ethers.getSigners();
  console.log("Déploiement depuis :", deployer.address);
  console.log("");

  // ── 1. Oracle MorphoChainlinkOracleV2 (base = collatéral cbBTC, quote = loan USDC) ──
  const oracleFactoryAbi = [
    "function createMorphoChainlinkOracleV2(address baseVault, uint256 baseVaultConversionSample, address baseFeed1, address baseFeed2, uint256 baseTokenDecimals, address quoteVault, uint256 quoteVaultConversionSample, address quoteFeed1, address quoteFeed2, uint256 quoteTokenDecimals, bytes32 salt) external returns (address oracle)",
    "event CreateMorphoChainlinkOracleV2(address caller, address oracle)",
  ];
  const oracleFactory = new ethers.Contract(MORPHO_ORACLE_FACTORY, oracleFactoryAbi, deployer);

  // Salt spécifique au projet pour éviter toute collision CREATE2 avec un autre déployeur
  const salt = ethers.keccak256(ethers.toUtf8Bytes("InvestOr-cbBTC-USDC-v1"));

  console.log("1/5 — Création de l'oracle cbBTC/USDC...");
  const oracleTx = await oracleFactory.createMorphoChainlinkOracleV2(
    ethers.ZeroAddress, 1n,                                    // baseVault, baseVaultConversionSample — cbBTC n'est pas un ERC4626
    CHAINLINK_BTC_USD, ethers.ZeroAddress, 8n,                  // baseFeed1, baseFeed2, baseTokenDecimals (cbBTC = 8 décimales)
    ethers.ZeroAddress, 1n,                                     // quoteVault, quoteVaultConversionSample — USDC n'est pas un ERC4626
    ethers.ZeroAddress, ethers.ZeroAddress, 6n,                 // quoteFeed1/2 = aucun (USDC ≈ 1 $), quoteTokenDecimals = 6
    salt
  );
  const oracleReceipt = await oracleTx.wait();

  const parsedEvent = oracleReceipt!.logs
    .map((log) => { try { return oracleFactory.interface.parseLog(log); } catch { return null; } })
    .find((parsed) => parsed?.name === "CreateMorphoChainlinkOracleV2");
  if (!parsedEvent) throw new Error("Event CreateMorphoChainlinkOracleV2 introuvable dans le reçu");
  const oracleAddress: string = parsedEvent.args.oracle;
  console.log("     Oracle déployé :", oracleAddress);
  console.log("");

  // ── 2. Marché Morpho Blue isolé ─────────────────────────────────────────
  const marketParams = {
    loanToken: USDC_CIRCLE,
    collateralToken: CBBTC,
    oracle: oracleAddress,
    irm: ADAPTIVE_CURVE_IRM,
    lltv: LLTV_86,
  };

  const morphoAbi = [
    "function createMarket((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams) external",
  ];
  const morpho = new ethers.Contract(MORPHO_BLUE, morphoAbi, deployer);

  console.log("2/5 — Création du marché Morpho Blue cbBTC/USDC (LLTV 86%)...");
  const marketTx = await morpho.createMarket(marketParams);
  await marketTx.wait();
  console.log("     Marché créé.");
  console.log("");

  // ── 3. Déploiement de MorphoYieldStrategy (via InvestOrProxy, ERC1967) ──
  console.log("3/5 — Déploiement de MorphoYieldStrategy...");
  const strategyImpl = await ethers.deployContract("MorphoYieldStrategy");
  await strategyImpl.waitForDeployment();
  console.log("     Implémentation déployée :", await strategyImpl.getAddress());

  const strategyInitData = strategyImpl.interface.encodeFunctionData("initialize", [
    deployer.address, MORPHO_BLUE, TREASURY_PROXY, // initialOwner temporaire — transféré à Reserve à l'étape 5
  ]);
  const strategyProxyRaw = await ethers.deployContract("InvestOrProxy", [
    await strategyImpl.getAddress(), strategyInitData,
  ]);
  await strategyProxyRaw.waitForDeployment();
  const strategyAddress = await strategyProxyRaw.getAddress();
  const strategy = await ethers.getContractAt("MorphoYieldStrategy", strategyAddress);
  console.log("     MorphoYieldStrategy (proxy) déployée :", strategyAddress);
  console.log("");

  // ── 4. Configuration du marché sur la stratégie ─────────────────────────
  console.log("4/5 — Configuration du marché sur la stratégie...");
  await (await strategy.setMarketParams(
    marketParams.loanToken,
    marketParams.collateralToken,
    marketParams.oracle,
    marketParams.irm,
    marketParams.lltv
  )).wait();
  console.log("     OK.");
  console.log("");

  // ── 5. Transfert de l'ownership à Reserve ───────────────────────────────
  console.log("5/5 — Transfert de l'ownership de la stratégie à Reserve...");
  await (await strategy.transferOwnership(RESERVE_PROXY)).wait();
  console.log("     OK — Reserve est désormais owner de MorphoYieldStrategy.");
  console.log("");

  console.log("=== Récapitulatif ===");
  console.log("Oracle cbBTC/USDC   :", oracleAddress);
  console.log("Marché Morpho Blue  : loanToken=USDC, collateralToken=cbBTC, LLTV=86%");
  console.log("MorphoYieldStrategy :", strategyAddress);
  console.log("");
  console.log("=== Dernière étape — À FAIRE VIA LE SAFE (2/3), PAS CE SCRIPT ===");
  console.log("Reserve est owned par le Gnosis Safe. Proposer cette transaction dans");
  console.log("app.safe.global → Transaction Builder :");
  console.log("  Contrat cible : Reserve —", RESERVE_PROXY);
  console.log("  Fonction      : setTreasuryYieldStrategy(address newStrategy)");
  console.log("  Paramètre     :", strategyAddress);
  console.log("Après signature (2/3) et exécution, Treasury.yieldStrategy sera câblé.");
  console.log("");
  console.log("IMPORTANT — ce marché est tout neuf, sans emprunteur organique.");
  console.log("Avant tout rebalance(), bootstrapper manuellement le marché :");
  console.log("  - un wallet de test dépose du cbBTC en collatéral (supplyCollateral)");
  console.log("  - puis emprunte de l'USDC (borrow) pour générer une utilisation réelle");
  console.log("Sans ça, Treasury.rebalance() déposera de l'USDC qui ne rapportera 0%.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
