import { expect } from "chai";
import hre from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";

// ─── Constantes ──────────────────────────────────────────────────────────────

const ONE_USDC      = 1_000_000n;
const HUNDRED_USDC  = 100n * ONE_USDC;
const THOUSAND_USDC = 1_000n * ONE_USDC;
const ONE_EURC      = 1_000_000n;
const HUNDRED_EURC  = 100n * ONE_EURC;
const THOUSAND_EURC = 1_000n * ONE_EURC;

const FALLBACK_PRICE    = 90_00000000n;  // $90/g (8 dec)
const EUR_USD_RATE      = 108_000_000n;  // 1.08 (8 dec)
const EUR_USD_FALLBACK  = 108_000_000n;  // même valeur pour les tests

// 100 USDC / $90 * 1e5 = 1111 GLD (arrondi)
const EXPECTED_GLD_FOR_100_USDC = 1111n;
// 100 EURC * 1.08 / $90 * 1e5 = 1200 GLD
const EXPECTED_GLD_FOR_100_EURC = 1200n;

// ─── Suite principale ─────────────────────────────────────────────────────────

describe("Exchange V4 — Multi-token USDC + EURC avec oracle EUR/USD", () => {
  let exchange:        any;
  let gld:             any;
  let treasury:        any;
  let mockUSDC:        any;
  let mockEURC:        any;
  let mockEurUsdOracle: any;
  let owner:           HardhatEthersSigner;
  let alice:           HardhatEthersSigner;
  let bob:             HardhatEthersSigner;
  let ethers:          any;

  // ─── beforeEach ────────────────────────────────────────────────────────────

  beforeEach(async () => {
    const connection = await hre.network.connect();
    ethers = (connection as any).ethers;
    [owner, alice, bob] = await ethers.getSigners();

    const ProxyFactory = await ethers.getContractFactory("InvestOrProxy");

    // Mock tokens
    mockUSDC = await (await ethers.getContractFactory("MockUSDC")).deploy();
    mockEURC = await (await ethers.getContractFactory("MockUSDC")).deploy();

    // Mock oracle EUR/USD
    mockEurUsdOracle = await (await ethers.getContractFactory("MockChainlinkOracle")).deploy(EUR_USD_RATE, 8);
    await mockEurUsdOracle.setUpdatedAt(await ethers.provider.getBlock("latest").then((b: any) => b.timestamp));

    // GLD
    const gldImpl  = await (await ethers.getContractFactory("GLD")).deploy();
    const gldProxy = await ProxyFactory.deploy(
      await gldImpl.getAddress(),
      gldImpl.interface.encodeFunctionData("initialize", [owner.address])
    );
    gld = await ethers.getContractAt("GLD", await gldProxy.getAddress());

    // Treasury V2 (USDC + EURC)
    const treasuryImpl  = await (await ethers.getContractFactory("contracts/Treasury.sol:Treasury")).deploy();
    const treasuryProxy = await ProxyFactory.deploy(
      await treasuryImpl.getAddress(),
      treasuryImpl.interface.encodeFunctionData("initialize", [
        owner.address,
        await mockUSDC.getAddress(),
        await mockEURC.getAddress(),
      ])
    );
    treasury = await ethers.getContractAt("contracts/Treasury.sol:Treasury", await treasuryProxy.getAddress());

    // Exchange V4
    const exchangeImpl  = await (await ethers.getContractFactory("contracts/Exchange.sol:Exchange")).deploy();
    const exchangeProxy = await ProxyFactory.deploy(
      await exchangeImpl.getAddress(),
      exchangeImpl.interface.encodeFunctionData("initialize", [
        owner.address,
        await gldProxy.getAddress(),
        await treasuryProxy.getAddress(),
        ethers.ZeroAddress,
        FALLBACK_PRICE,
      ])
    );
    exchange = await ethers.getContractAt("contracts/Exchange.sol:Exchange", await exchangeProxy.getAddress());

    // Configurer EURC et oracle EUR/USD
    await exchange.connect(owner).setEurc(await mockEURC.getAddress());
    await exchange.connect(owner).setEurUsdOracle(await mockEurUsdOracle.getAddress());

    // Rôles
    await gld.setMinter(await exchangeProxy.getAddress());
    await treasury.setOperator(await exchangeProxy.getAddress());

    // Fonds
    await mockUSDC.mint(alice.address, THOUSAND_USDC);
    await mockEURC.mint(alice.address, THOUSAND_EURC);
    await mockUSDC.mint(bob.address,   THOUSAND_USDC);
    await mockEURC.mint(bob.address,   THOUSAND_EURC);

    // Pré-alimenter Treasury
    await mockUSDC.mint(owner.address, THOUSAND_USDC * 10n);
    await mockEURC.mint(owner.address, THOUSAND_EURC * 10n);
    await mockUSDC.connect(owner).approve(await treasury.getAddress(), THOUSAND_USDC * 10n);
    await mockEURC.connect(owner).approve(await treasury.getAddress(), THOUSAND_EURC * 10n);
    await treasury.connect(owner).deposit(THOUSAND_USDC * 10n, await mockUSDC.getAddress());
    await treasury.connect(owner).deposit(THOUSAND_EURC * 10n, await mockEURC.getAddress());
  });

  async function aliceBuysUsdc(amount = HUNDRED_USDC) {
    await mockUSDC.connect(alice).approve(await exchange.getAddress(), amount);
    await exchange.connect(alice).buy(amount, await mockUSDC.getAddress());
  }

  async function aliceBuysEurc(amount = HUNDRED_EURC) {
    await mockEURC.connect(alice).approve(await exchange.getAddress(), amount);
    await exchange.connect(alice).buy(amount, await mockEURC.getAddress());
  }

  // ── 1. Oracle EUR/USD ─────────────────────────────────────────────────────

  describe("Oracle EUR/USD", () => {
    it("getEurUsdRate retourne le taux oracle si disponible", async () => {
      const [rate, isLive] = await exchange.getEurUsdRate();
      expect(rate).to.equal(EUR_USD_RATE);
      expect(isLive).to.be.true;
    });

    it("getEurUsdRate retourne le fallback si oracle indisponible", async () => {
      await exchange.connect(owner).setEurUsdOracle(ethers.ZeroAddress);
      const [rate, isLive] = await exchange.getEurUsdRate();
      expect(rate).to.equal(EUR_USD_FALLBACK);
      expect(isLive).to.be.false;
    });

    it("setEurUsdOracle met à jour l'oracle", async () => {
      const newOracle = await (await ethers.getContractFactory("MockChainlinkOracle")).deploy(EUR_USD_RATE, 8);
      await exchange.connect(owner).setEurUsdOracle(await newOracle.getAddress());
      expect(await exchange.eurusdOracle()).to.equal(await newOracle.getAddress());
    });

    it("setEurUsdOracle émet EurUsdOracleUpdated", async () => {
      const newOracle = await (await ethers.getContractFactory("MockChainlinkOracle")).deploy(EUR_USD_RATE, 8);
      await expect(exchange.connect(owner).setEurUsdOracle(await newOracle.getAddress()))
        .to.emit(exchange, "EurUsdOracleUpdated");
    });

    it("setEurUsdFallbackRate met à jour le taux fallback", async () => {
      await exchange.connect(owner).setEurUsdFallbackRate(110_000_000n);
      expect(await exchange.eurusdFallbackRate()).to.equal(110_000_000n);
    });

    it("non-owner ne peut pas setEurUsdOracle", async () => {
      await expect(
        exchange.connect(alice).setEurUsdOracle(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(exchange, "OwnableUnauthorizedAccount");
    });
  });

  // ── 2. previewBuy avec conversion EUR/USD ─────────────────────────────────

  describe("previewBuy — conversion EUR/USD", () => {
    it("previewBuy USDC sans conversion — résultat attendu", async () => {
      expect(await exchange.previewBuy(HUNDRED_USDC, await mockUSDC.getAddress()))
        .to.equal(EXPECTED_GLD_FOR_100_USDC);
    });

    it("previewBuy EURC avec taux 1.08 — plus de GLD qu'en USDC", async () => {
      const gldFromEurc = await exchange.previewBuy(HUNDRED_EURC, await mockEURC.getAddress());
      const gldFromUsdc = await exchange.previewBuy(HUNDRED_USDC, await mockUSDC.getAddress());
      expect(gldFromEurc).to.be.gt(gldFromUsdc);
    });

    it("previewBuy EURC 100 EURC × 1.08 / $90 = 1200 GLD", async () => {
      expect(await exchange.previewBuy(HUNDRED_EURC, await mockEURC.getAddress()))
        .to.equal(EXPECTED_GLD_FOR_100_EURC);
    });

    it("previewBuy EURC avec taux 1.00 = même résultat que USDC", async () => {
      await mockEurUsdOracle.setPrice(100_000_000n); // 1.00
      const gldFromEurc = await exchange.previewBuy(HUNDRED_EURC, await mockEURC.getAddress());
      const gldFromUsdc = await exchange.previewBuy(HUNDRED_USDC, await mockUSDC.getAddress());
      expect(gldFromEurc).to.equal(gldFromUsdc);
    });

    it("previewBuy EURC avec taux 1.20 — encore plus de GLD que 1.08", async () => {
      const gldAt108 = await exchange.previewBuy(HUNDRED_EURC, await mockEURC.getAddress());
      await mockEurUsdOracle.setPrice(120_000_000n); // 1.20
      const gldAt120 = await exchange.previewBuy(HUNDRED_EURC, await mockEURC.getAddress());
      expect(gldAt120).to.be.gt(gldAt108);
    });

    it("previewBuy EURC utilise fallback si oracle KO", async () => {
      await exchange.connect(owner).setEurUsdOracle(ethers.ZeroAddress);
      // Avec fallback 1.08 — même résultat
      expect(await exchange.previewBuy(HUNDRED_EURC, await mockEURC.getAddress()))
        .to.equal(EXPECTED_GLD_FOR_100_EURC);
    });
  });

  // ── 3. previewSell avec conversion EUR/USD ────────────────────────────────

  describe("previewSell — conversion EUR/USD", () => {
    it("previewSell USDC sans conversion", async () => {
      const usdc = await exchange.previewSell(1000n, await mockUSDC.getAddress());
      expect(usdc).to.be.gt(0n);
    });

    it("previewSell EURC retourne moins d'EURC que d'USDC (÷ taux)", async () => {
      const eurcOut = await exchange.previewSell(1000n, await mockEURC.getAddress());
      const usdcOut = await exchange.previewSell(1000n, await mockUSDC.getAddress());
      // EURC = USD / 1.08 < USD
      expect(eurcOut).to.be.lt(usdcOut);
    });

    it("previewSell EURC avec taux 1.00 = même montant que USDC", async () => {
      await mockEurUsdOracle.setPrice(100_000_000n);
      const eurcOut = await exchange.previewSell(1000n, await mockEURC.getAddress());
      const usdcOut = await exchange.previewSell(1000n, await mockUSDC.getAddress());
      expect(eurcOut).to.equal(usdcOut);
    });
  });

  // ── 4. Achat avec conversion ──────────────────────────────────────────────

  describe("Buy — conversion EUR/USD appliquée", () => {
    it("achat EURC mint plus de GLD qu'achat USDC (taux 1.08)", async () => {
      await aliceBuysUsdc();
      const gldAfterUsdc = await gld.balanceOf(alice.address);

      // Reset alice
      await gld.burn(alice.address, gldAfterUsdc);

      await aliceBuysEurc();
      const gldAfterEurc = await gld.balanceOf(alice.address);

      expect(gldAfterEurc).to.be.gt(gldAfterUsdc);
    });

    it("achat EURC 100€ × 1.08 = 108 USD équivalent → 1200 GLD", async () => {
      await aliceBuysEurc();
      expect(await gld.balanceOf(alice.address)).to.equal(EXPECTED_GLD_FOR_100_EURC);
    });

    it("Treasury EURC reçoit les fonds", async () => {
      const before = await treasury.totalDepositedByToken(await mockEURC.getAddress());
      await aliceBuysEurc();
      expect(await treasury.totalDepositedByToken(await mockEURC.getAddress()))
        .to.be.gt(before);
    });
  });

  // ── 5. Vente avec conversion ──────────────────────────────────────────────

  describe("Sell — conversion USD→EURC", () => {
    beforeEach(async () => {
      await aliceBuysUsdc();
    });

    it("vente GLD→EURC retourne moins d'EURC que d'USDC (÷ 1.08)", async () => {
      const gldBalance = await gld.balanceOf(alice.address);

      const eurcExpected = await exchange.previewSell(gldBalance, await mockEURC.getAddress());
      const usdcExpected = await exchange.previewSell(gldBalance, await mockUSDC.getAddress());

      expect(eurcExpected).to.be.lt(usdcExpected);
    });

    it("vente GLD→EURC avec taux 1.08 : montant correct", async () => {
      const gldBalance  = await gld.balanceOf(alice.address);
      const eurcBefore  = await mockEURC.balanceOf(alice.address);
      const eurcExpected = await exchange.previewSell(gldBalance, await mockEURC.getAddress());

      await exchange.connect(alice).sell(gldBalance, await mockEURC.getAddress());

      expect(await mockEURC.balanceOf(alice.address)).to.equal(eurcBefore + eurcExpected);
    });

    it("vente GLD→EURC avec taux 1.00 = même montant que USDC", async () => {
      await mockEurUsdOracle.setPrice(100_000_000n);
      const gldBalance = await gld.balanceOf(alice.address);
      const eurcOut    = await exchange.previewSell(gldBalance, await mockEURC.getAddress());
      const usdcOut    = await exchange.previewSell(gldBalance, await mockUSDC.getAddress());
      expect(eurcOut).to.equal(usdcOut);
    });

    it("emit TokensSold avec le montant EURC converti", async () => {
      const gldBalance   = await gld.balanceOf(alice.address);
      const eurcExpected = await exchange.previewSell(gldBalance, await mockEURC.getAddress());
      await expect(exchange.connect(alice).sell(gldBalance, await mockEURC.getAddress()))
        .to.emit(exchange, "TokensSold")
        .withArgs(alice.address, await mockEURC.getAddress(), gldBalance, eurcExpected, FALLBACK_PRICE);
    });
  });

  // ── 6. Scénario complet achat EURC + vente EURC ───────────────────────────

  describe("Scénario achat EURC → vente EURC (round trip)", () => {
    it("achat 100 EURC puis vente de tout le GLD récupère moins de 100 EURC (fees)", async () => {
      // Activer les fees pour ce test (300 bps = 3%)
      await exchange.connect(owner).setFeeBps(300n);
      const eurcBefore = await mockEURC.balanceOf(alice.address);
      await aliceBuysEurc(HUNDRED_EURC);
      const gldBalance = await gld.balanceOf(alice.address);
      await exchange.connect(alice).sell(gldBalance, await mockEURC.getAddress());
      const eurcAfter = await mockEURC.balanceOf(alice.address);
      // Doit avoir moins d'EURC à cause des fees (2 × 3%)
      expect(eurcAfter).to.be.lt(eurcBefore);
      // Mais proche — perte max ~10%
      expect(eurcAfter).to.be.gt(eurcBefore * 90n / 100n);
    });
  });

  // ── 7. Admin EUR/USD ──────────────────────────────────────────────────────

  describe("Admin — setEurUsdOracle / setEurUsdFallbackRate", () => {
    it("eurusdFallbackRate par défaut = 1.08", async () => {
      expect(await exchange.eurusdFallbackRate()).to.equal(108_000_000n);
    });

    it("setEurUsdFallbackRate met à jour le taux", async () => {
      await exchange.connect(owner).setEurUsdFallbackRate(115_000_000n);
      expect(await exchange.eurusdFallbackRate()).to.equal(115_000_000n);
    });

    it("setEurUsdFallbackRate émet EurUsdFallbackRateUpdated", async () => {
      await expect(exchange.connect(owner).setEurUsdFallbackRate(115_000_000n))
        .to.emit(exchange, "EurUsdFallbackRateUpdated")
        .withArgs(108_000_000n, 115_000_000n);
    });

    it("non-owner ne peut pas setEurUsdFallbackRate", async () => {
      await expect(
        exchange.connect(alice).setEurUsdFallbackRate(115_000_000n)
      ).to.be.revertedWithCustomError(exchange, "OwnableUnauthorizedAccount");
    });
  });

  // ── 8. UUPS ───────────────────────────────────────────────────────────────

  describe("Upgradeability (UUPS)", () => {
    it("owner peut upgrader", async () => {
      const newImpl = await (await ethers.getContractFactory("contracts/Exchange.sol:Exchange")).deploy();
      await expect(exchange.upgradeToAndCall(await newImpl.getAddress(), "0x"))
        .to.not.revert(ethers);
    });

    it("non-owner ne peut pas upgrader", async () => {
      const newImpl = await (await ethers.getContractFactory("contracts/Exchange.sol:Exchange")).deploy();
      await expect(
        exchange.connect(alice).upgradeToAndCall(await newImpl.getAddress(), "0x")
      ).to.be.revertedWithCustomError(exchange, "OwnableUnauthorizedAccount");
    });
  });
});
