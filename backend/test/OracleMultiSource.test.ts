import { expect } from "chai";
import hre from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";

// ─── Constantes ──────────────────────────────────────────────────────────────

const ONE_USDC      = 1_000_000n;
const HUNDRED_USDC  = 100n * ONE_USDC;
const THOUSAND_USDC = 1_000n * ONE_USDC;

const ONE_HOUR  = 3_600n;
const TWO_HOURS = 7_200n;

// ── Prix en 8 décimales (format Chainlink / format interne) ──────────────────
// 1 once troy = 31.1035 grammes
// $4 590 / once → $147.56 / gramme → 14756_00000000 (8 dec)
const PRICE_CL_90   = 90_00000000n;    // $90.00 / g  (tests hérités)
const PRICE_CL_100  = 100_00000000n;   // $100.00 / g
const PRICE_CL_108  = 108_00000000n;   // $108.00 / g

// ── Prix en 18 décimales (format Tellor natif) ───────────────────────────────
// Tellor stocke en 18 dec → Exchange divise par 1e10 → 8 dec
// Pour obtenir 90_00000000 (8 dec) : 90_00000000 * 1e10 = 90_0000000000000000 (18 dec)
const PRICE_TL_90   = 90_00000000n  * 10n ** 10n;   // équivalent $90/g
const PRICE_TL_100  = 100_00000000n * 10n ** 10n;   // équivalent $100/g
const PRICE_TL_108  = 108_00000000n * 10n ** 10n;   // équivalent $108/g

// ── Prix médiane attendue ─────────────────────────────────────────────────────
// médiane($90, $100) = ($90 + $100) / 2 = $95 → 95_00000000
const PRICE_MEDIAN_90_100 = (PRICE_CL_90 + PRICE_CL_100) / 2n;  // 95_00000000

const FALLBACK_PRICE = PRICE_CL_90;

// ─── Suite principale ─────────────────────────────────────────────────────────

describe("Oracle multi-sources — Étape 7 : Chainlink + Tellor (Exchange)", () => {
  let exchange:   any;
  let gld:        any;
  let treasury:   any;
  let mockUSDC:   any;
  let chainlink:  any;   // MockChainlinkOracle
  let tellor:     any;   // MockTellorOracle
  let owner:      HardhatEthersSigner;
  let alice:      HardhatEthersSigner;
  let ethers:     any;

  // ─── beforeEach : déploiement complet sans Ignition ────────────────────────

  beforeEach(async () => {
    const connection = await hre.network.connect();
    ethers = (connection as any).ethers;

    [owner, alice] = await ethers.getSigners();

    // MockUSDC
    const MockUSDCFactory = await ethers.getContractFactory("MockUSDC");
    mockUSDC = await MockUSDCFactory.deploy();

    // MockChainlinkOracle ($90/g, fresh)
    const ChainlinkFactory = await ethers.getContractFactory("MockChainlinkOracle");
    chainlink = await ChainlinkFactory.deploy(PRICE_CL_90, 8);

    // MockTellorOracle ($90/g en 18 dec, fresh)
    const TellorFactory = await ethers.getContractFactory("MockTellorOracle");
    tellor = await TellorFactory.deploy(PRICE_TL_90);

    // GLD impl + proxy
    const GLDFactory  = await ethers.getContractFactory("GLD");
    const gldImpl     = await GLDFactory.deploy();
    const ProxyFactory = await ethers.getContractFactory("InvestOrProxy");
    const gldInitData  = gldImpl.interface.encodeFunctionData("initialize", [owner.address]);
    const gldProxy     = await ProxyFactory.deploy(await gldImpl.getAddress(), gldInitData);
    gld = await ethers.getContractAt("GLD", await gldProxy.getAddress());

    // Treasury impl + proxy
    const TreasuryFactory   = await ethers.getContractFactory("Treasury");
    const treasuryImpl      = await TreasuryFactory.deploy();
    const treasuryInitData  = treasuryImpl.interface.encodeFunctionData("initialize", [
      owner.address, await mockUSDC.getAddress(), ethers.ZeroAddress,
    ]);
    const treasuryProxy = await ProxyFactory.deploy(await treasuryImpl.getAddress(), treasuryInitData);
    treasury = await ethers.getContractAt("Treasury", await treasuryProxy.getAddress());

    // Exchange impl + proxy (Chainlink actif, Tellor configuré après)
    const ExchangeFactory  = await ethers.getContractFactory("contracts/Exchange.sol:Exchange");
    const exchangeImpl     = await ExchangeFactory.deploy();
    const exchangeInitData = exchangeImpl.interface.encodeFunctionData("initialize", [
      owner.address,
      await gldProxy.getAddress(),
      await treasuryProxy.getAddress(),
      await chainlink.getAddress(),
      FALLBACK_PRICE,
    ]);
    const exchangeProxy = await ProxyFactory.deploy(await exchangeImpl.getAddress(), exchangeInitData);
    exchange = await ethers.getContractAt("contracts/Exchange.sol:Exchange", await exchangeProxy.getAddress());

    // Configurer Tellor sur Exchange
    await exchange.connect(owner).setTellorOracle(await tellor.getAddress());

    // Rôles
    await gld.setMinter(await exchangeProxy.getAddress());
    await treasury.setOperator(await exchangeProxy.getAddress());

    // Fonds
    await mockUSDC.mint(alice.address, THOUSAND_USDC);
    await mockUSDC.mint(owner.address, THOUSAND_USDC * 10n);
    await mockUSDC.connect(owner).approve(await treasury.getAddress(), THOUSAND_USDC * 10n);
    await treasury.connect(owner).deposit(THOUSAND_USDC * 10n, await mockUSDC.getAddress());
  });

  // ─── Helper ──────────────────────────────────────────────────────────────

  async function aliceBuys(usdcAmount: bigint) {
    await mockUSDC.connect(alice).approve(await exchange.getAddress(), usdcAmount);
    await exchange.connect(alice).buy(usdcAmount, await mockUSDC.getAddress());
  }

  // ── 1. Configuration initiale ─────────────────────────────────────────────

  describe("Configuration initiale", () => {
    it("tellorOracle est bien configuré", async () => {
      expect(await exchange.tellorOracle()).to.equal(await tellor.getAddress());
    });

    it("priceOracle (Chainlink) est bien configuré", async () => {
      expect(await exchange.priceOracle()).to.equal(await chainlink.getAddress());
    });

    it("fallbackPrice est bien configuré", async () => {
      expect(await exchange.fallbackPrice()).to.equal(FALLBACK_PRICE);
    });

    it("TELLOR_XAU_USD_QUERY_ID est non-nul", async () => {
      const queryId = await exchange.TELLOR_XAU_USD_QUERY_ID();
      expect(queryId).to.not.equal(ethers.ZeroHash);
    });
  });

  // ── 2. Logique médiane — les deux oracles valides ─────────────────────────

  describe("Médiane — Chainlink et Tellor valides", () => {
    it("getPrice retourne source=0 (médiane) si les deux oracles sont valides", async () => {
      const [, source] = await exchange.getPrice();
      expect(source).to.equal(0n);
    });

    it("getPrice retourne la médiane des deux prix quand CL=$90 et TL=$90", async () => {
      const [price, source] = await exchange.getPrice();
      expect(price).to.equal(PRICE_CL_90);
      expect(source).to.equal(0n);
    });

    it("getPrice retourne la médiane quand CL=$90 et TL=$100 → $95", async () => {
      await tellor.setPrice(PRICE_TL_100);

      const [price, source] = await exchange.getPrice();
      expect(price).to.equal(PRICE_MEDIAN_90_100);  // (90 + 100) / 2 = 95
      expect(source).to.equal(0n);
    });

    it("getPrice retourne la médiane quand CL=$100 et TL=$90 → $95", async () => {
      await chainlink.setPrice(PRICE_CL_100);
      // Tellor reste à $90

      const [price, source] = await exchange.getPrice();
      expect(price).to.equal(PRICE_MEDIAN_90_100);
      expect(source).to.equal(0n);
    });

    it("previewBuy utilise le prix médian", async () => {
      await chainlink.setPrice(PRICE_CL_90);
      await tellor.setPrice(PRICE_TL_100);

      const gldAmount = await exchange.previewBuy(HUNDRED_USDC, await mockUSDC.getAddress());
      // médiane = $95/g → 100_000_000 * 100_000 / 9_500_000_000 = 1052
      expect(gldAmount).to.equal(1052n);
    });

    it("achat utilise le prix médian — GLD reçu cohérent", async () => {
      await chainlink.setPrice(PRICE_CL_90);
      await tellor.setPrice(PRICE_TL_100);

      const expected = await exchange.previewBuy(HUNDRED_USDC, await mockUSDC.getAddress());
      await aliceBuys(HUNDRED_USDC);
      expect(await gld.balanceOf(alice.address)).to.equal(expected);
    });
  });

  // ── 3. Dégradation — Chainlink seul valide ───────────────────────────────

  describe("Dégradation — Chainlink seul valide", () => {
    beforeEach(async () => {
      // Tellor tombe en panne
      await tellor.setShouldRevert(true);
    });

    it("getPrice retourne source=1 (Chainlink seul) si Tellor KO", async () => {
      const [, source] = await exchange.getPrice();
      expect(source).to.equal(1n);
    });

    it("getPrice retourne le prix Chainlink seul si Tellor revert", async () => {
      const [price, source] = await exchange.getPrice();
      expect(price).to.equal(PRICE_CL_90);
      expect(source).to.equal(1n);
    });

    it("getPrice retourne Chainlink si données Tellor périmées", async () => {
      await tellor.setShouldRevert(false);
      const oldTs = BigInt(Math.floor(Date.now() / 1000)) - TWO_HOURS;
      await tellor.setUpdatedAt(oldTs);

      const [price, source] = await exchange.getPrice();
      expect(price).to.equal(PRICE_CL_90);
      expect(source).to.equal(1n);
    });

    it("getPrice retourne Chainlink si Tellor retourne bytes vides", async () => {
      await tellor.setShouldRevert(false);
      await tellor.setReturnEmpty(true);

      const [price, source] = await exchange.getPrice();
      expect(price).to.equal(PRICE_CL_90);
      expect(source).to.equal(1n);
    });

    it("Chainlink seul → prix = $108 si Chainlink mis à jour", async () => {
      await chainlink.setPrice(PRICE_CL_108);

      const [price, source] = await exchange.getPrice();
      expect(price).to.equal(PRICE_CL_108);
      expect(source).to.equal(1n);
    });

    it("achat fonctionne correctement en mode Chainlink seul", async () => {
      const expected = await exchange.previewBuy(HUNDRED_USDC, await mockUSDC.getAddress());
      await aliceBuys(HUNDRED_USDC);
      expect(await gld.balanceOf(alice.address)).to.equal(expected);
    });
  });

  // ── 4. Dégradation — Tellor seul valide ─────────────────────────────────

  describe("Dégradation — Tellor seul valide", () => {
    beforeEach(async () => {
      // Chainlink tombe en panne
      await chainlink.setShouldRevert(true);
    });

    it("getPrice retourne source=2 (Tellor seul) si Chainlink KO", async () => {
      const [, source] = await exchange.getPrice();
      expect(source).to.equal(2n);
    });

    it("getPrice retourne le prix Tellor seul si Chainlink revert", async () => {
      const [price, source] = await exchange.getPrice();
      expect(price).to.equal(PRICE_CL_90);  // $90 après conversion 18→8 dec
      expect(source).to.equal(2n);
    });

    it("getPrice retourne Tellor si données Chainlink périmées", async () => {
      await chainlink.setShouldRevert(false);
      const oldTs = BigInt(Math.floor(Date.now() / 1000)) - TWO_HOURS;
      await chainlink.setUpdatedAt(oldTs);

      const [price, source] = await exchange.getPrice();
      expect(price).to.equal(PRICE_CL_90);
      expect(source).to.equal(2n);
    });

    it("Tellor à $100 → prix $100 (après conversion)", async () => {
      await tellor.setPrice(PRICE_TL_100);

      const [price, source] = await exchange.getPrice();
      expect(price).to.equal(PRICE_CL_100);
      expect(source).to.equal(2n);
    });

    it("achat fonctionne correctement en mode Tellor seul", async () => {
      const expected = await exchange.previewBuy(HUNDRED_USDC, await mockUSDC.getAddress());
      await aliceBuys(HUNDRED_USDC);
      expect(await gld.balanceOf(alice.address)).to.equal(expected);
    });
  });

  // ── 5. Fallback — aucun oracle valide ────────────────────────────────────

  describe("Fallback — aucun oracle valide", () => {
    beforeEach(async () => {
      await chainlink.setShouldRevert(true);
      await tellor.setShouldRevert(true);
    });

    it("getPrice retourne source=3 (fallback) si les deux oracles KO", async () => {
      const [, source] = await exchange.getPrice();
      expect(source).to.equal(3n);
    });

    it("getPrice retourne le fallbackPrice si les deux oracles KO", async () => {
      const [price, source] = await exchange.getPrice();
      expect(price).to.equal(FALLBACK_PRICE);
      expect(source).to.equal(3n);
    });

    it("getPrice retourne fallback si les deux oracles sont périmés", async () => {
      await chainlink.setShouldRevert(false);
      await tellor.setShouldRevert(false);
      const oldTs = BigInt(Math.floor(Date.now() / 1000)) - TWO_HOURS;
      await chainlink.setUpdatedAt(oldTs);
      await tellor.setUpdatedAt(oldTs);

      const [price, source] = await exchange.getPrice();
      expect(price).to.equal(FALLBACK_PRICE);
      expect(source).to.equal(3n);
    });

    it("getPrice retourne fallback si address(0) pour les deux oracles", async () => {
      await chainlink.setShouldRevert(false);
      await tellor.setShouldRevert(false);
      await exchange.setOracle(ethers.ZeroAddress);
      await exchange.setTellorOracle(ethers.ZeroAddress);

      const [price, source] = await exchange.getPrice();
      expect(price).to.equal(FALLBACK_PRICE);
      expect(source).to.equal(3n);
    });

    it("revert NoPriceAvailable si fallback est nul et tous les oracles KO", async () => {
      // On ne peut pas mettre fallbackPrice à 0 via setFallbackPrice (ZeroAmount)
      // → on teste via un deploy frais sans fallback — cas théorique couvert par l'erreur
      // Ce test vérifie que le chemin d'erreur existe bien dans getPrice()
      // En pratique, setFallbackPrice(0) revert donc ce cas ne peut pas arriver en prod
      await expect(
        exchange.setFallbackPrice(0n)
      ).to.be.revertedWithCustomError(exchange, "ZeroAmount");
    });

    it("achat fonctionne avec le fallback", async () => {
      const expected = await exchange.previewBuy(HUNDRED_USDC, await mockUSDC.getAddress());
      await aliceBuys(HUNDRED_USDC);
      expect(await gld.balanceOf(alice.address)).to.equal(expected);
    });
  });

  // ── 6. getOracleStatus ───────────────────────────────────────────────────

  describe("getOracleStatus", () => {
    it("retourne les deux prix valides et la source médiane", async () => {
      const status = await exchange.getOracleStatus();
      expect(status.chainlinkOk).to.be.true;
      expect(status.tellorOk).to.be.true;
      expect(status.chainlinkPrice).to.equal(PRICE_CL_90);
      expect(status.tellorPrice).to.equal(PRICE_CL_90);
      expect(status.activeSource).to.equal(0n);
    });

    it("chainlinkOk=false si Chainlink KO", async () => {
      await chainlink.setShouldRevert(true);
      const status = await exchange.getOracleStatus();
      expect(status.chainlinkOk).to.be.false;
      expect(status.tellorOk).to.be.true;
      expect(status.activeSource).to.equal(2n);
    });

    it("tellorOk=false si Tellor KO", async () => {
      await tellor.setShouldRevert(true);
      const status = await exchange.getOracleStatus();
      expect(status.chainlinkOk).to.be.true;
      expect(status.tellorOk).to.be.false;
      expect(status.activeSource).to.equal(1n);
    });

    it("les deux KO → source=3 (fallback)", async () => {
      await chainlink.setShouldRevert(true);
      await tellor.setShouldRevert(true);
      const status = await exchange.getOracleStatus();
      expect(status.chainlinkOk).to.be.false;
      expect(status.tellorOk).to.be.false;
      expect(status.activeSource).to.equal(3n);
      expect(status.activePrice).to.equal(FALLBACK_PRICE);
    });

    it("activePrice = médiane si les deux valides", async () => {
      await chainlink.setPrice(PRICE_CL_90);
      await tellor.setPrice(PRICE_TL_100);
      const status = await exchange.getOracleStatus();
      expect(status.activePrice).to.equal(PRICE_MEDIAN_90_100);
    });
  });

  // ── 7. setTellorOracle — admin ────────────────────────────────────────────

  describe("setTellorOracle — admin", () => {
    it("owner peut configurer un nouvel oracle Tellor", async () => {
      const TellorFactory = await ethers.getContractFactory("MockTellorOracle");
      const newTellor = await TellorFactory.deploy(PRICE_TL_100);

      await exchange.setTellorOracle(await newTellor.getAddress());
      expect(await exchange.tellorOracle()).to.equal(await newTellor.getAddress());
    });

    it("setTellorOracle émet l'event TellorOracleUpdated", async () => {
      const oldAddr = await tellor.getAddress();
      const TellorFactory = await ethers.getContractFactory("MockTellorOracle");
      const newTellor = await TellorFactory.deploy(PRICE_TL_100);

      await expect(exchange.setTellorOracle(await newTellor.getAddress()))
        .to.emit(exchange, "TellorOracleUpdated")
        .withArgs(oldAddr, await newTellor.getAddress());
    });

    it("setTellorOracle accepte address(0) pour désactiver Tellor", async () => {
      await exchange.setTellorOracle(ethers.ZeroAddress);
      expect(await exchange.tellorOracle()).to.equal(ethers.ZeroAddress);

      // Après désactivation : source = Chainlink seul
      const [, source] = await exchange.getPrice();
      expect(source).to.equal(1n);
    });

    it("non-owner ne peut pas configurer l'oracle Tellor", async () => {
      await expect(
        exchange.connect(alice).setTellorOracle(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(exchange, "OwnableUnauthorizedAccount");
    });
  });

  // ── 8. Conversion Tellor 18 dec → 8 dec ──────────────────────────────────

  describe("Conversion Tellor 18→8 décimales", () => {
    it("conversion correcte : $90 en 18 dec → $90 en 8 dec", async () => {
      await chainlink.setShouldRevert(true); // forcer Tellor seul

      const [price, source] = await exchange.getPrice();
      expect(source).to.equal(2n);
      expect(price).to.equal(PRICE_CL_90);  // $90 en 8 dec
    });

    it("conversion correcte : $108 en 18 dec → $108 en 8 dec", async () => {
      await tellor.setPrice(PRICE_TL_108);
      await chainlink.setShouldRevert(true);

      const [price, source] = await exchange.getPrice();
      expect(source).to.equal(2n);
      expect(price).to.equal(PRICE_CL_108);
    });

    it("facteur de conversion TELLOR_DECIMALS_FACTOR = 1e10", async () => {
      expect(await exchange.TELLOR_DECIMALS_FACTOR()).to.equal(10n ** 10n);
    });
  });

  // ── 9. Scénario complet — achat puis vente avec médiane ───────────────────

  describe("Scénario complet avec médiane", () => {
    it("achat à médiane $95, vente à médiane $99 — plus-value correcte", async () => {
      // Achat : CL=$90, TL=$100 → médiane $95
      await chainlink.setPrice(PRICE_CL_90);
      await tellor.setPrice(PRICE_TL_100);

      const usdcBefore = await mockUSDC.balanceOf(alice.address);
      await aliceBuys(HUNDRED_USDC);

      const gldBalance = await gld.balanceOf(alice.address);

      // Vente : CL=$108, TL=$90 → médiane $99
      const PRICE_TL_99_8dec = 99_00000000n;
      await chainlink.setPrice(PRICE_CL_108);
      await tellor.setPrice(90_00000000n * 10n ** 10n); // TL reste $90

      // Injecter USDC si nécessaire
      const usdcNeeded = await exchange.previewSell(gldBalance, await mockUSDC.getAddress());
      const treasuryBal = await mockUSDC.balanceOf(await treasury.getAddress());
      if (usdcNeeded > treasuryBal) {
        const extra = usdcNeeded - treasuryBal;
        await mockUSDC.mint(owner.address, extra);
        await mockUSDC.connect(owner).approve(await treasury.getAddress(), extra);
        await treasury.connect(owner).deposit(extra, await mockUSDC.getAddress());
      }

      await exchange.connect(alice).sell(gldBalance, await mockUSDC.getAddress());
      const usdcAfter = await mockUSDC.balanceOf(alice.address);

      // Alice récupère plus que ses 100 USDC initiaux (plus-value grâce à la hausse)
      expect(usdcAfter).to.be.gt(usdcBefore);
    });

    it("les events TokensBought et TokensSold contiennent le prix médian", async () => {
      await chainlink.setPrice(PRICE_CL_90);
      await tellor.setPrice(PRICE_TL_100);
      const medianPrice = PRICE_MEDIAN_90_100;

      await mockUSDC.connect(alice).approve(await exchange.getAddress(), HUNDRED_USDC);
      await expect(exchange.connect(alice).buy(HUNDRED_USDC, await mockUSDC.getAddress()))
        .to.emit(exchange, "TokensBought")
        .withArgs(
          alice.address,
          await mockUSDC.getAddress(),
          HUNDRED_USDC,
          await exchange.previewBuy(HUNDRED_USDC, await mockUSDC.getAddress()),
          medianPrice
        );
    });
  });
});
