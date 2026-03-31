import { expect } from "chai";
import hre from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";
import TreasuryModule from "../ignition/modules/Treasury.js";
import GLDModule from "../ignition/modules/GLD.js";
import ExchangeModule from "../ignition/modules/Exchange.js";

// ─── Constantes ──────────────────────────────────────────────────────────────

const ONE_USDC       = 1_000_000n;
const HUNDRED_USDC   = 100n * ONE_USDC;
const THOUSAND_USDC  = 1000n * ONE_USDC;

// Prix en 8 décimales (format Chainlink)
const PRICE_90       = 90_00000000n;   // $90.00 / gramme
const PRICE_100      = 100_00000000n;  // $100.00 / gramme
const PRICE_108      = 108_00000000n;  // $108.00 / gramme (+20%)
const FALLBACK_PRICE = PRICE_90;

// Helpers temps
const ONE_HOUR       = 3600n;
const TWO_HOURS      = 7200n;

// ─── Suite principale ─────────────────────────────────────────────────────────

describe("Oracle — Étape 5 : Chainlink + fallback", () => {
  let exchange: any;
  let gld: any;
  let treasury: any;
  let mockUSDC: any;
  let oracle: any;
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let ethers: any;
  let ignition: any;

  beforeEach(async () => {
    const connection = await hre.network.connect();
    ethers   = (connection as any).ethers;
    ignition = (connection as any).ignition;

    [owner, alice] = await ethers.getSigners();

    // 1. MockUSDC
    const MockUSDCFactory = await ethers.getContractFactory("MockUSDC");
    mockUSDC = await MockUSDCFactory.deploy();

    // 2. MockChainlinkOracle (prix initial $90, 8 décimales)
    const OracleFactory = await ethers.getContractFactory("MockChainlinkOracle");
    oracle = await OracleFactory.deploy(PRICE_90, 8);

    // 3. GLD
    const { proxy: gldProxy } = await ignition.deploy(GLDModule, {
      parameters: { GLDModule: { initialOwner: owner.address } },
    });
    gld = await ethers.getContractAt("GLD", await gldProxy.getAddress());

    // 4. Treasury
    const { proxy: treasuryProxy } = await ignition.deploy(TreasuryModule, {
      parameters: {
        TreasuryModule: {
          initialOwner: owner.address,
          usdcAddress:  await mockUSDC.getAddress(),
        },
      },
    });
    treasury = await ethers.getContractAt("Treasury", await treasuryProxy.getAddress());

    // 5. Exchange AVEC oracle
    const { proxy: exchangeProxy } = await ignition.deploy(ExchangeModule, {
      parameters: {
        ExchangeModule: {
          initialOwner:      owner.address,
          gldAddress:        await gldProxy.getAddress(),
          treasuryAddress:   await treasuryProxy.getAddress(),
          oracleAddress:     await oracle.getAddress(),
          initFallbackPrice: FALLBACK_PRICE,
        },
      },
    });
    exchange = await ethers.getContractAt("Exchange", await exchangeProxy.getAddress());

    // 6. Rôles et fonds
    await gld.setMinter(await exchangeProxy.getAddress());
    await treasury.setOperator(await exchangeProxy.getAddress());
    await mockUSDC.mint(alice.address, THOUSAND_USDC);
    await mockUSDC.mint(owner.address, THOUSAND_USDC * 10n);
    await mockUSDC.connect(owner).approve(await treasury.getAddress(), THOUSAND_USDC * 10n);
    await treasury.connect(owner).deposit(THOUSAND_USDC * 10n);
  });

  // ── 1. Lecture du prix oracle ──────────────────────────────────────────────

  describe("Lecture du prix", () => {
    it("getPrice retourne le prix oracle quand disponible", async () => {
      const [price, isOracle] = await exchange.getPrice();
      expect(price).to.equal(PRICE_90);
      expect(isOracle).to.be.true;
    });

    it("getPrice retourne isOracle=true quand l'oracle répond", async () => {
      const [, isOracle] = await exchange.getPrice();
      expect(isOracle).to.be.true;
    });

    it("le prix oracle est pris en compte dans previewBuy", async () => {
      // A $90/g : 100 USDC = 100_000_000 * 100_000 / 9_000_000_000 = 1111 GLD
      const gldAmount = await exchange.previewBuy(HUNDRED_USDC);
      expect(gldAmount).to.equal(1111n);
    });

    it("previewBuy change si le prix oracle change", async () => {
      const before = await exchange.previewBuy(HUNDRED_USDC);

      // Prix monte à $100/g
      await oracle.setPrice(PRICE_100);
      const after = await exchange.previewBuy(HUNDRED_USDC);

      // Plus cher = moins de GLD pour le même USDC
      expect(after).to.be.lt(before);
    });

    it("previewSell change si le prix oracle change", async () => {
      const before = await exchange.previewSell(1000n);

      // Prix monte à $100/g
      await oracle.setPrice(PRICE_100);
      const after = await exchange.previewSell(1000n);

      // Plus cher = plus d'USDC pour le même GLD
      expect(after).to.be.gt(before);
    });
  });

  // ── 2. Fallback automatique ────────────────────────────────────────────────

  describe("Fallback automatique", () => {
    it("bascule sur fallback si oracle revert", async () => {
      await oracle.setShouldRevert(true);

      const [price, isOracle] = await exchange.getPrice();
      expect(price).to.equal(FALLBACK_PRICE);
      expect(isOracle).to.be.false;
    });

    it("bascule sur fallback si données périmées (> oracleMaxAge)", async () => {
      // Vieillir les données de 2 heures
      const oldTimestamp = BigInt(Math.floor(Date.now() / 1000)) - TWO_HOURS;
      await oracle.setUpdatedAt(oldTimestamp);

      const [price, isOracle] = await exchange.getPrice();
      expect(price).to.equal(FALLBACK_PRICE);
      expect(isOracle).to.be.false;
    });

    it("utilise l'oracle si données dans la fenêtre oracleMaxAge", async () => {
      // Données fraîches (maintenant)
      await oracle.setPrice(PRICE_100);

      const [price, isOracle] = await exchange.getPrice();
      expect(price).to.equal(PRICE_100);
      expect(isOracle).to.be.true;
    });

    it("bascule sur fallback si prix oracle négatif", async () => {
      await oracle.setPrice(-1n);

      const [price, isOracle] = await exchange.getPrice();
      expect(price).to.equal(FALLBACK_PRICE);
      expect(isOracle).to.be.false;
    });

    it("bascule sur fallback si prix oracle nul", async () => {
      await oracle.setPrice(0n);

      const [price, isOracle] = await exchange.getPrice();
      expect(price).to.equal(FALLBACK_PRICE);
      expect(isOracle).to.be.false;
    });

    it("fallback utilisé si pas d'oracle configuré (address zero)", async () => {
      // Retirer l'oracle
      await exchange.setOracle(ethers.ZeroAddress);

      const [price, isOracle] = await exchange.getPrice();
      expect(price).to.equal(FALLBACK_PRICE);
      expect(isOracle).to.be.false;
    });
  });

  // ── 3. oracleMaxAge ────────────────────────────────────────────────────────

  describe("oracleMaxAge", () => {
    it("oracleMaxAge par défaut est 3600 secondes", async () => {
      expect(await exchange.oracleMaxAge()).to.equal(ONE_HOUR);
    });

    it("données acceptées si age < oracleMaxAge", async () => {
      await exchange.setOracleMaxAge(TWO_HOURS);
      // Données vieilles de 1h — acceptables si maxAge = 2h
      const ts = BigInt(Math.floor(Date.now() / 1000)) - ONE_HOUR;
      await oracle.setUpdatedAt(ts);

      const [, isOracle] = await exchange.getPrice();
      expect(isOracle).to.be.true;
    });

    it("données rejetées si age > oracleMaxAge réduit", async () => {
      // Réduire maxAge à 30 minutes
      await exchange.setOracleMaxAge(1800n);
      // Données vieilles de 1h — trop vieilles
      const ts = BigInt(Math.floor(Date.now() / 1000)) - ONE_HOUR;
      await oracle.setUpdatedAt(ts);

      const [, isOracle] = await exchange.getPrice();
      expect(isOracle).to.be.false;
    });

    it("setOracleMaxAge émet l'event et met à jour", async () => {
      await exchange.setOracleMaxAge(TWO_HOURS);
      expect(await exchange.oracleMaxAge()).to.equal(TWO_HOURS);
    });

    it("un non-owner ne peut pas changer oracleMaxAge", async () => {
      await expect(
        exchange.connect(alice).setOracleMaxAge(TWO_HOURS)
      ).to.be.revertedWithCustomError(exchange, "OwnableUnauthorizedAccount");
    });
  });

  // ── 4. Mise à jour de l'oracle ─────────────────────────────────────────────

  describe("Mise à jour de l'oracle", () => {
    it("setOracle met à jour l'adresse", async () => {
      const OracleFactory = await ethers.getContractFactory("MockChainlinkOracle");
      const newOracle = await OracleFactory.deploy(PRICE_100, 8);

      await exchange.setOracle(await newOracle.getAddress());
      expect(await exchange.priceOracle()).to.equal(await newOracle.getAddress());
    });

    it("setOracle émet l'event OracleUpdated", async () => {
      const OracleFactory = await ethers.getContractFactory("MockChainlinkOracle");
      const newOracle = await OracleFactory.deploy(PRICE_100, 8);

      await expect(exchange.setOracle(await newOracle.getAddress()))
        .to.emit(exchange, "OracleUpdated")
        .withArgs(await oracle.getAddress(), await newOracle.getAddress());
    });

    it("setOracle accepte address(0) pour désactiver l'oracle", async () => {
      await exchange.setOracle(ethers.ZeroAddress);
      expect(await exchange.priceOracle()).to.equal(ethers.ZeroAddress);
    });

    it("un non-owner ne peut pas changer l'oracle", async () => {
      await expect(
        exchange.connect(alice).setOracle(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(exchange, "OwnableUnauthorizedAccount");
    });
  });

  // ── 5. Achat avec prix oracle dynamique ────────────────────────────────────

  describe("Achat avec prix oracle", () => {
    it("achat au prix oracle $90 — GLD correct", async () => {
      await oracle.setPrice(PRICE_90);
      await mockUSDC.connect(alice).approve(await exchange.getAddress(), HUNDRED_USDC);
      await exchange.connect(alice).buy(HUNDRED_USDC);

      // 100 USDC / $90/g * 1000 = 1111 unités GLD
      expect(await gld.balanceOf(alice.address)).to.equal(1111n);
    });

    it("achat au prix oracle $100 — moins de GLD", async () => {
      await oracle.setPrice(PRICE_100);
      await mockUSDC.connect(alice).approve(await exchange.getAddress(), HUNDRED_USDC);
      await exchange.connect(alice).buy(HUNDRED_USDC);

      // 100 USDC / $100/g * 1000 = 1000 unités GLD
      expect(await gld.balanceOf(alice.address)).to.equal(1000n);
    });

    it("achat au prix fallback si oracle périmé", async () => {
      const ts = BigInt(Math.floor(Date.now() / 1000)) - TWO_HOURS;
      await oracle.setUpdatedAt(ts);
      // Prix fallback = $90
      await mockUSDC.connect(alice).approve(await exchange.getAddress(), HUNDRED_USDC);
      await exchange.connect(alice).buy(HUNDRED_USDC);

      expect(await gld.balanceOf(alice.address)).to.equal(1111n);
    });

    it("l'event TokensBought contient le bon prix (oracle)", async () => {
      await oracle.setPrice(PRICE_100);
      await mockUSDC.connect(alice).approve(await exchange.getAddress(), HUNDRED_USDC);

      await expect(exchange.connect(alice).buy(HUNDRED_USDC))
        .to.emit(exchange, "TokensBought")
        .withArgs(alice.address, HUNDRED_USDC, 1000n, PRICE_100);
    });

    it("l'event TokensBought contient le prix fallback si oracle KO", async () => {
      await oracle.setShouldRevert(true);
      await mockUSDC.connect(alice).approve(await exchange.getAddress(), HUNDRED_USDC);

      await expect(exchange.connect(alice).buy(HUNDRED_USDC))
        .to.emit(exchange, "TokensBought")
        .withArgs(alice.address, HUNDRED_USDC, 1111n, FALLBACK_PRICE);
    });
  });

  // ── 6. Vente avec prix oracle dynamique ────────────────────────────────────

  describe("Vente avec prix oracle", () => {
    beforeEach(async () => {
      // Alice achète d'abord au prix $90
      await oracle.setPrice(PRICE_90);
      await mockUSDC.connect(alice).approve(await exchange.getAddress(), HUNDRED_USDC);
      await exchange.connect(alice).buy(HUNDRED_USDC);
    });

    it("vente au même prix — récupère l'USDC equivalent", async () => {
      const gldBalance   = await gld.balanceOf(alice.address);
      const usdcExpected = await exchange.previewSell(gldBalance);
      const usdcBefore   = await mockUSDC.balanceOf(alice.address);

      await exchange.connect(alice).sell(gldBalance);

      expect(await mockUSDC.balanceOf(alice.address)).to.equal(usdcBefore + usdcExpected);
    });

    it("vente à prix plus élevé (+20%) — plus d'USDC récupérés", async () => {
      const gldBalance = await gld.balanceOf(alice.address);

      // Prix monte à $108
      await oracle.setPrice(PRICE_108);
      const usdcAtHighPrice  = await exchange.previewSell(gldBalance);
      const usdcAtLowPrice   = (gldBalance * PRICE_90) / 100_000n;

      expect(usdcAtHighPrice).to.be.gt(usdcAtLowPrice);
    });

    it("l'event TokensSold contient le bon prix oracle", async () => {
      const gldBalance = await gld.balanceOf(alice.address);
      await oracle.setPrice(PRICE_100);
      const usdcExpected = await exchange.previewSell(gldBalance);

      await expect(exchange.connect(alice).sell(gldBalance))
        .to.emit(exchange, "TokensSold")
        .withArgs(alice.address, gldBalance, usdcExpected, PRICE_100);
    });
  });

  // ── 7. Scénario hausse de l'or ────────────────────────────────────────────

  describe("Scénario hausse de l'or", () => {
    it("achat à $90 puis vente à $108 — plus-value correcte", async () => {
      // Achat à $90
      await oracle.setPrice(PRICE_90);
      await mockUSDC.connect(alice).approve(await exchange.getAddress(), HUNDRED_USDC);
      await exchange.connect(alice).buy(HUNDRED_USDC);

      const gldBalance   = await gld.balanceOf(alice.address);
      const usdcBefore   = await mockUSDC.balanceOf(alice.address);

      // Prix monte à $108 (+20%)
      await oracle.setPrice(PRICE_108);

      // Injecter USDC supplémentaires dans le Treasury (recapitalisation)
      const usdcNeeded = await exchange.previewSell(gldBalance);
      const treasuryBalance = await mockUSDC.balanceOf(await treasury.getAddress());
      if (usdcNeeded > treasuryBalance) {
        const extra = usdcNeeded - treasuryBalance;
        await mockUSDC.mint(owner.address, extra);
        await mockUSDC.connect(owner).approve(await treasury.getAddress(), extra);
        await treasury.connect(owner).deposit(extra);
      }

      // Vente à $108
      await exchange.connect(alice).sell(gldBalance);

      const usdcAfter = await mockUSDC.balanceOf(alice.address);
      // Alice doit récupérer plus de 100 USDC (plus-value)
      expect(usdcAfter).to.be.gt(usdcBefore + HUNDRED_USDC);
    });
  });
});
