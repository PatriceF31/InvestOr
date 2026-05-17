import { expect } from "chai";
import hre from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";

// ─── Constantes ──────────────────────────────────────────────────────────────

const ONE_USDC      = 1_000_000n;
const HUNDRED_USDC  = 100n * ONE_USDC;
const THOUSAND_USDC = 1_000n * ONE_USDC;

const TWO_HOURS = 7_200n;

// ── Prix en 8 décimales (Chainlink / format interne) ─────────────────────────
const PRICE_CL_90  = 90_00000000n;
const PRICE_CL_100 = 100_00000000n;
const PRICE_CL_108 = 108_00000000n;

// ── Prix en 18 décimales (Tellor natif) ──────────────────────────────────────
const PRICE_TL_90  = PRICE_CL_90  * 10n ** 10n;
const PRICE_TL_100 = PRICE_CL_100 * 10n ** 10n;
const PRICE_TL_108 = PRICE_CL_108 * 10n ** 10n;

// ── Prix médiane ──────────────────────────────────────────────────────────────
const PRICE_MEDIAN_90_100 = (PRICE_CL_90 + PRICE_CL_100) / 2n;  // 95_00000000

const RATIO_100 = 10_000n;

// ─── Suite principale ─────────────────────────────────────────────────────────

describe("Oracle multi-sources — Étape 7 : Chainlink + Tellor (Reserve)", () => {
  let reserve:   any;
  let exchange:  any;
  let gld:       any;
  let treasury:  any;
  let mockUSDC:  any;
  let chainlink: any;
  let tellor:    any;
  let owner:     HardhatEthersSigner;
  let alice:     HardhatEthersSigner;
  let ethers:    any;

  // ─── beforeEach ────────────────────────────────────────────────────────────

  beforeEach(async () => {
    const connection = await hre.network.connect();
    ethers = (connection as any).ethers;

    [owner, alice] = await ethers.getSigners();

    // MockUSDC
    const MockUSDCFactory = await ethers.getContractFactory("MockUSDC");
    mockUSDC = await MockUSDCFactory.deploy();

    // Oracles
    const ChainlinkFactory = await ethers.getContractFactory("MockChainlinkOracle");
    chainlink = await ChainlinkFactory.deploy(PRICE_CL_90, 8);

    const TellorFactory = await ethers.getContractFactory("MockTellorOracle");
    tellor = await TellorFactory.deploy(PRICE_TL_90);

    const ProxyFactory = await ethers.getContractFactory("InvestOrProxy");

    // GLD
    const gldImpl     = await (await ethers.getContractFactory("GLD")).deploy();
    const gldProxy    = await ProxyFactory.deploy(
      await gldImpl.getAddress(),
      gldImpl.interface.encodeFunctionData("initialize", [owner.address])
    );
    gld = await ethers.getContractAt("GLD", await gldProxy.getAddress());

    // Treasury
    const treasuryImpl   = await (await ethers.getContractFactory("Treasury")).deploy();
    const treasuryProxy  = await ProxyFactory.deploy(
      await treasuryImpl.getAddress(),
      treasuryImpl.interface.encodeFunctionData("initialize", [
        owner.address, await mockUSDC.getAddress(),
      ])
    );
    treasury = await ethers.getContractAt("Treasury", await treasuryProxy.getAddress());

    // Exchange
    const exchangeImpl   = await (await ethers.getContractFactory("contracts/Exchange.sol:Exchange")).deploy();
    const exchangeProxy  = await ProxyFactory.deploy(
      await exchangeImpl.getAddress(),
      exchangeImpl.interface.encodeFunctionData("initialize", [
        owner.address,
        await gldProxy.getAddress(),
        await treasuryProxy.getAddress(),
        await chainlink.getAddress(),
        PRICE_CL_90,
      ])
    );
    exchange = await ethers.getContractAt("contracts/Exchange.sol:Exchange", await exchangeProxy.getAddress());
    await exchange.connect(owner).setTellorOracle(await tellor.getAddress());

    // Reserve
    const reserveImpl   = await (await ethers.getContractFactory("contracts/Reserve.sol:Reserve")).deploy();
    const reserveProxy  = await ProxyFactory.deploy(
      await reserveImpl.getAddress(),
      reserveImpl.interface.encodeFunctionData("initialize", [
        owner.address,
        await gldProxy.getAddress(),
        await treasuryProxy.getAddress(),
        await exchangeProxy.getAddress(),
        await chainlink.getAddress(),
        RATIO_100,
      ])
    );
    reserve = await ethers.getContractAt("contracts/Reserve.sol:Reserve", await reserveProxy.getAddress());
    await reserve.connect(owner).setTellorOracle(await tellor.getAddress());

    // Rôles
    await gld.setMinter(await exchangeProxy.getAddress());
    await treasury.setOperator(await exchangeProxy.getAddress());
    await exchange.transferOwnership(await reserve.getAddress());

    // Fonds alice
    await mockUSDC.mint(alice.address, THOUSAND_USDC);
  });

  // ─── Helper ──────────────────────────────────────────────────────────────

  async function aliceBuys(usdcAmount: bigint) {
    await mockUSDC.connect(alice).approve(await exchange.getAddress(), usdcAmount);
    await exchange.connect(alice).buy(usdcAmount);
  }

  // ── 1. Configuration ──────────────────────────────────────────────────────

  describe("Configuration initiale", () => {
    it("oracle Chainlink configuré", async () => {
      // Reserve.oracle est l'interface IOracle, on vérifie via getOracleStatus
      const status = await reserve.getOracleStatus();
      expect(status.chainlinkOk).to.be.true;
    });

    it("oracle Tellor configuré", async () => {
      expect(await reserve.tellorOracle()).to.equal(await tellor.getAddress());
    });

    it("TELLOR_XAU_USD_QUERY_ID non-nul", async () => {
      expect(await reserve.TELLOR_XAU_USD_QUERY_ID()).to.not.equal(ethers.ZeroHash);
    });
  });

  // ── 2. getPrice — logique médiane ─────────────────────────────────────────

  describe("getPrice Reserve — logique médiane", () => {
    it("retourne la médiane si les deux oracles valides (CL=$90, TL=$90 → $90)", async () => {
      expect(await reserve.getPrice()).to.equal(PRICE_CL_90);
    });

    it("retourne la médiane si CL=$90 et TL=$100 → $95", async () => {
      await tellor.setPrice(PRICE_TL_100);
      expect(await reserve.getPrice()).to.equal(PRICE_MEDIAN_90_100);
    });

    it("retourne Chainlink seul si Tellor KO", async () => {
      await tellor.setShouldRevert(true);
      expect(await reserve.getPrice()).to.equal(PRICE_CL_90);
    });

    it("retourne Chainlink seul si données Tellor périmées", async () => {
      const oldTs = BigInt(Math.floor(Date.now() / 1000)) - TWO_HOURS;
      await tellor.setUpdatedAt(oldTs);
      expect(await reserve.getPrice()).to.equal(PRICE_CL_90);
    });

    it("retourne Tellor seul si Chainlink KO", async () => {
      await chainlink.setShouldRevert(true);
      expect(await reserve.getPrice()).to.equal(PRICE_CL_90);
    });

    it("retourne Tellor seul si données Chainlink périmées", async () => {
      const oldTs = BigInt(Math.floor(Date.now() / 1000)) - TWO_HOURS;
      await chainlink.setUpdatedAt(oldTs);
      expect(await reserve.getPrice()).to.equal(PRICE_CL_90);
    });

    it("retourne le fallback Exchange si les deux KO", async () => {
      await chainlink.setShouldRevert(true);
      await tellor.setShouldRevert(true);
      // fallback Exchange = PRICE_CL_90 (défini à l'init)
      expect(await reserve.getPrice()).to.equal(PRICE_CL_90);
    });

    it("retourne le fallback Exchange si address(0) pour les deux", async () => {
      await reserve.connect(owner).setOracle(ethers.ZeroAddress);
      await reserve.connect(owner).setTellorOracle(ethers.ZeroAddress);
      // Exchange.fallbackPrice = PRICE_CL_90
      expect(await reserve.getPrice()).to.equal(PRICE_CL_90);
    });
  });

  // ── 3. getOracleStatus Reserve ────────────────────────────────────────────

  describe("getOracleStatus Reserve", () => {
    it("les deux oracles valides → chainlinkOk=true, tellorOk=true", async () => {
      const s = await reserve.getOracleStatus();
      expect(s.chainlinkOk).to.be.true;
      expect(s.tellorOk).to.be.true;
    });

    it("chainlinkOk=false si Chainlink KO", async () => {
      await chainlink.setShouldRevert(true);
      const s = await reserve.getOracleStatus();
      expect(s.chainlinkOk).to.be.false;
      expect(s.tellorOk).to.be.true;
    });

    it("tellorOk=false si Tellor KO", async () => {
      await tellor.setShouldRevert(true);
      const s = await reserve.getOracleStatus();
      expect(s.chainlinkOk).to.be.true;
      expect(s.tellorOk).to.be.false;
    });

    it("activePrice = médiane si les deux valides", async () => {
      await tellor.setPrice(PRICE_TL_100);
      const s = await reserve.getOracleStatus();
      expect(s.activePrice).to.equal(PRICE_MEDIAN_90_100);
    });

    it("activePrice = fallback si les deux KO", async () => {
      await chainlink.setShouldRevert(true);
      await tellor.setShouldRevert(true);
      const s = await reserve.getOracleStatus();
      expect(s.activePrice).to.equal(PRICE_CL_90);
    });
  });

  // ── 4. Impact sur checkReserve / isHealthy ────────────────────────────────

  describe("Impact de la médiane sur checkReserve", () => {
    it("ratio correct quand prix médian = $90 (égal aux USDC déposés)", async () => {
      await aliceBuys(HUNDRED_USDC);
      const [,,, ratio] = await reserve.checkReserve();
      expect(ratio).to.be.gte(9990n); // ~100%
    });

    it("ratio diminue si médiane monte (CL=$108, TL=$90 → $99)", async () => {
      await aliceBuys(HUNDRED_USDC);
      const [,,, ratioBefore] = await reserve.checkReserve();

      await chainlink.setPrice(PRICE_CL_108);
      // Tellor reste $90 → médiane = (108+90)/2 = $99
      const [,,, ratioAfter] = await reserve.checkReserve();

      expect(ratioAfter).to.be.lt(ratioBefore);
    });

    it("isHealthy=false si prix médian provoque un déficit", async () => {
      await aliceBuys(HUNDRED_USDC);
      // Les deux oracles à $108 → médiane $108, ratio ~83%
      await chainlink.setPrice(PRICE_CL_108);
      await tellor.setPrice(PRICE_TL_108);
      expect(await reserve.isHealthy()).to.be.false;
    });

    it("isHealthy=true si Tellor KO et Chainlink à $90 (pas de déficit)", async () => {
      await aliceBuys(HUNDRED_USDC);
      await tellor.setShouldRevert(true);
      // Chainlink seul à $90 → ratio ~100%
      expect(await reserve.isHealthy()).to.be.true;
    });

    it("ratio avec Tellor seul cohérent (Chainlink KO, Tellor $90)", async () => {
      await aliceBuys(HUNDRED_USDC);
      await chainlink.setShouldRevert(true);
      const [,,, ratio] = await reserve.checkReserve();
      expect(ratio).to.be.gte(9990n);
    });
  });

  // ── 5. proofOfReserve avec multi-oracle ───────────────────────────────────

  describe("proofOfReserve avec multi-oracle", () => {
    it("pause Exchange si médiane provoque un déficit", async () => {
      await aliceBuys(HUNDRED_USDC);
      await chainlink.setPrice(PRICE_CL_108);
      await tellor.setPrice(PRICE_TL_108);  // médiane $108 → déficit

      expect(await exchange.paused()).to.be.false;
      await reserve.proofOfReserve();
      expect(await exchange.paused()).to.be.true;
    });

    it("ne pause pas Exchange si Tellor KO mais Chainlink sain", async () => {
      await aliceBuys(HUNDRED_USDC);
      await tellor.setShouldRevert(true);
      // Chainlink seul à $90 → pas de déficit

      await reserve.proofOfReserve();
      expect(await exchange.paused()).to.be.false;
    });

    it("pause Exchange si Chainlink KO mais Tellor déficitaire", async () => {
      await aliceBuys(HUNDRED_USDC);
      await chainlink.setShouldRevert(true);
      await tellor.setPrice(PRICE_TL_108);  // Tellor seul à $108 → déficit

      await reserve.proofOfReserve();
      expect(await exchange.paused()).to.be.true;
    });

    it("réactive Exchange si prix médian restauré", async () => {
      await aliceBuys(HUNDRED_USDC);
      await chainlink.setPrice(PRICE_CL_108);
      await tellor.setPrice(PRICE_TL_108);
      await reserve.proofOfReserve(); // pause

      // Restaurer les deux oracles
      await chainlink.setPrice(PRICE_CL_90);
      await tellor.setPrice(PRICE_TL_90);
      await reserve.proofOfReserve(); // unpause

      expect(await exchange.paused()).to.be.false;
    });

    it("fallback Exchange utilisé si les deux KO — pas de panique inutile", async () => {
      await aliceBuys(HUNDRED_USDC);
      await chainlink.setShouldRevert(true);
      await tellor.setShouldRevert(true);
      // fallback = $90 → ratio ~100% → pas de déficit

      await reserve.proofOfReserve();
      expect(await exchange.paused()).to.be.false;
    });
  });

  // ── 6. setTellorOracle et setExchangeTellorOracle — admin ─────────────────

  describe("setTellorOracle — admin Reserve", () => {
    it("owner peut configurer un nouvel oracle Tellor sur Reserve", async () => {
      const TellorFactory = await ethers.getContractFactory("MockTellorOracle");
      const newTellor = await TellorFactory.deploy(PRICE_TL_100);

      await reserve.connect(owner).setTellorOracle(await newTellor.getAddress());
      expect(await reserve.tellorOracle()).to.equal(await newTellor.getAddress());
    });

    it("setTellorOracle émet l'event TellorOracleUpdated", async () => {
      const oldAddr = await tellor.getAddress();
      const TellorFactory = await ethers.getContractFactory("MockTellorOracle");
      const newTellor = await TellorFactory.deploy(PRICE_TL_100);

      await expect(reserve.connect(owner).setTellorOracle(await newTellor.getAddress()))
        .to.emit(reserve, "TellorOracleUpdated")
        .withArgs(oldAddr, await newTellor.getAddress());
    });

    it("setTellorOracle accepte address(0) pour désactiver Tellor", async () => {
      await reserve.connect(owner).setTellorOracle(ethers.ZeroAddress);
      expect(await reserve.tellorOracle()).to.equal(ethers.ZeroAddress);
    });

    it("non-owner ne peut pas configurer l'oracle Tellor de Reserve", async () => {
      await expect(
        reserve.connect(alice).setTellorOracle(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(reserve, "OwnableUnauthorizedAccount");
    });

    it("setExchangeTellorOracle propage le Tellor vers Exchange", async () => {
      const TellorFactory = await ethers.getContractFactory("MockTellorOracle");
      const newTellor = await TellorFactory.deploy(PRICE_TL_100);

      await reserve.connect(owner).setExchangeTellorOracle(await newTellor.getAddress());
      expect(await exchange.tellorOracle()).to.equal(await newTellor.getAddress());
    });

    it("non-owner ne peut pas propager le Tellor vers Exchange", async () => {
      await expect(
        reserve.connect(alice).setExchangeTellorOracle(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(reserve, "OwnableUnauthorizedAccount");
    });
  });

  // ── 7. Cohérence des queryId entre Exchange et Reserve ────────────────────

  describe("Cohérence Exchange ↔ Reserve", () => {
    it("TELLOR_XAU_USD_QUERY_ID identique dans Exchange et Reserve", async () => {
      const ExchangeFactory = await ethers.getContractFactory("contracts/Exchange.sol:Exchange");
      const exchangeImpl    = await ExchangeFactory.deploy();
      // On lit depuis les contrats déployés (pas les impls — via les proxies)
      const qidExchange = await exchange.TELLOR_XAU_USD_QUERY_ID();
      const qidReserve  = await reserve.TELLOR_XAU_USD_QUERY_ID();
      expect(qidExchange).to.equal(qidReserve);
    });

    it("TELLOR_DECIMALS_FACTOR identique dans Exchange et Reserve", async () => {
      expect(await exchange.TELLOR_DECIMALS_FACTOR()).to.equal(
        await reserve.TELLOR_DECIMALS_FACTOR()
      );
    });

    it("même mock Tellor → même prix dans Exchange et Reserve", async () => {
      await tellor.setPrice(PRICE_TL_100);
      await chainlink.setShouldRevert(true); // forcer Tellor seul dans les deux

      const [priceExchange,] = await exchange.getPrice();
      const priceReserve = await reserve.getPrice();

      expect(priceExchange).to.equal(priceReserve);
    });
  });
});
