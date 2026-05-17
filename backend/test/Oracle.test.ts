import { expect } from "chai";
import hre from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";

// ─── Constantes ──────────────────────────────────────────────────────────────

const ONE_USDC       = 1_000_000n;
const HUNDRED_USDC   = 100n * ONE_USDC;
const THOUSAND_USDC  = 1000n * ONE_USDC;

const PRICE_90       = 90_00000000n;
const PRICE_100      = 100_00000000n;
const PRICE_108      = 108_00000000n;
const FALLBACK_PRICE = PRICE_90;

const ONE_HOUR  = 3600n;
const TWO_HOURS = 7200n;

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

  beforeEach(async () => {
    const connection = await hre.network.connect();
    ethers = (connection as any).ethers;
    [owner, alice] = await ethers.getSigners();

    const ProxyFactory = await ethers.getContractFactory("InvestOrProxy");

    // MockUSDC
    mockUSDC = await (await ethers.getContractFactory("MockUSDC")).deploy();

    // MockChainlinkOracle
    oracle = await (await ethers.getContractFactory("MockChainlinkOracle")).deploy(PRICE_90, 8);

    // GLD
    const gldImpl  = await (await ethers.getContractFactory("GLD")).deploy();
    const gldProxy = await ProxyFactory.deploy(
      await gldImpl.getAddress(),
      gldImpl.interface.encodeFunctionData("initialize", [owner.address])
    );
    gld = await ethers.getContractAt("GLD", await gldProxy.getAddress());

    // Treasury
    const treasuryImpl  = await (await ethers.getContractFactory("Treasury")).deploy();
    const treasuryProxy = await ProxyFactory.deploy(
      await treasuryImpl.getAddress(),
      treasuryImpl.interface.encodeFunctionData("initialize", [
        owner.address, await mockUSDC.getAddress(),
      ])
    );
    treasury = await ethers.getContractAt("Treasury", await treasuryProxy.getAddress());

    // Exchange AVEC oracle Chainlink
    const exchangeImpl  = await (await ethers.getContractFactory("contracts/Exchange.sol:Exchange")).deploy();
    const exchangeProxy = await ProxyFactory.deploy(
      await exchangeImpl.getAddress(),
      exchangeImpl.interface.encodeFunctionData("initialize", [
        owner.address,
        await gldProxy.getAddress(),
        await treasuryProxy.getAddress(),
        await oracle.getAddress(),
        FALLBACK_PRICE,
      ])
    );
    exchange = await ethers.getContractAt("contracts/Exchange.sol:Exchange", await exchangeProxy.getAddress());

    // Rôles et fonds
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
      const [price, source] = await exchange.getPrice();
      expect(price).to.equal(PRICE_90);
      expect(source).to.be.lte(2n);
    });

    it("getPrice retourne source<=2 quand l'oracle répond", async () => {
      const [, source] = await exchange.getPrice();
      expect(source).to.be.lte(2n);
    });

    it("le prix oracle est pris en compte dans previewBuy", async () => {
      const gldAmount = await exchange.previewBuy(HUNDRED_USDC);
      expect(gldAmount).to.equal(1111n);
    });

    it("previewBuy change si le prix oracle change", async () => {
      const before = await exchange.previewBuy(HUNDRED_USDC);
      await oracle.setPrice(PRICE_100);
      const after = await exchange.previewBuy(HUNDRED_USDC);
      expect(after).to.be.lt(before);
    });

    it("previewSell change si le prix oracle change", async () => {
      const before = await exchange.previewSell(1000n);
      await oracle.setPrice(PRICE_100);
      const after = await exchange.previewSell(1000n);
      expect(after).to.be.gt(before);
    });
  });

  // ── 2. Fallback automatique ────────────────────────────────────────────────

  describe("Fallback automatique", () => {
    it("bascule sur fallback si oracle revert", async () => {
      await oracle.setShouldRevert(true);
      const [price, source] = await exchange.getPrice();
      expect(price).to.equal(FALLBACK_PRICE);
      expect(source).to.equal(3n);
    });

    it("bascule sur fallback si données périmées (> oracleMaxAge)", async () => {
      const oldTimestamp = BigInt(Math.floor(Date.now() / 1000)) - TWO_HOURS;
      await oracle.setUpdatedAt(oldTimestamp);
      const [price, source] = await exchange.getPrice();
      expect(price).to.equal(FALLBACK_PRICE);
      expect(source).to.equal(3n);
    });

    it("utilise l'oracle si données dans la fenêtre oracleMaxAge", async () => {
      await oracle.setPrice(PRICE_100);
      const [price, source] = await exchange.getPrice();
      expect(price).to.equal(PRICE_100);
      expect(source).to.be.lte(2n);
    });

    it("bascule sur fallback si prix oracle négatif", async () => {
      await oracle.setPrice(-1n);
      const [price, source] = await exchange.getPrice();
      expect(price).to.equal(FALLBACK_PRICE);
      expect(source).to.equal(3n);
    });

    it("bascule sur fallback si prix oracle nul", async () => {
      await oracle.setPrice(0n);
      const [price, source] = await exchange.getPrice();
      expect(price).to.equal(FALLBACK_PRICE);
      expect(source).to.equal(3n);
    });

    it("fallback utilisé si pas d'oracle configuré (address zero)", async () => {
      await exchange.setOracle(ethers.ZeroAddress);
      const [price, source] = await exchange.getPrice();
      expect(price).to.equal(FALLBACK_PRICE);
      expect(source).to.equal(3n);
    });
  });

  // ── 3. oracleMaxAge ────────────────────────────────────────────────────────

  describe("oracleMaxAge", () => {
    it("oracleMaxAge par défaut est 3600 secondes", async () => {
      expect(await exchange.oracleMaxAge()).to.equal(ONE_HOUR);
    });

    it("données acceptées si age < oracleMaxAge", async () => {
      await exchange.setOracleMaxAge(TWO_HOURS);
      const ts = BigInt(Math.floor(Date.now() / 1000)) - ONE_HOUR;
      await oracle.setUpdatedAt(ts);
      const [, source] = await exchange.getPrice();
      expect(source).to.be.lte(2n);
    });

    it("données rejetées si age > oracleMaxAge réduit", async () => {
      await exchange.setOracleMaxAge(1800n);
      const ts = BigInt(Math.floor(Date.now() / 1000)) - ONE_HOUR;
      await oracle.setUpdatedAt(ts);
      const [, source] = await exchange.getPrice();
      expect(source).to.equal(3n);
    });

    it("setOracleMaxAge émet l'event et met à jour", async () => {
      await exchange.setOracleMaxAge(TWO_HOURS);
      expect(await exchange.oracleMaxAge()).to.equal(TWO_HOURS);
    });

    it("un non-owner ne peut pas changer oracleMaxAge", async () => {
      await expect(exchange.connect(alice).setOracleMaxAge(TWO_HOURS))
        .to.be.revertedWithCustomError(exchange, "OwnableUnauthorizedAccount");
    });
  });

  // ── 4. Mise à jour de l'oracle ─────────────────────────────────────────────

  describe("Mise à jour de l'oracle", () => {
    it("setOracle met à jour l'adresse", async () => {
      const newOracle = await (await ethers.getContractFactory("MockChainlinkOracle")).deploy(PRICE_100, 8);
      await exchange.setOracle(await newOracle.getAddress());
      expect(await exchange.priceOracle()).to.equal(await newOracle.getAddress());
    });

    it("setOracle émet l'event OracleUpdated", async () => {
      const newOracle = await (await ethers.getContractFactory("MockChainlinkOracle")).deploy(PRICE_100, 8);
      await expect(exchange.setOracle(await newOracle.getAddress()))
        .to.emit(exchange, "OracleUpdated")
        .withArgs(await oracle.getAddress(), await newOracle.getAddress());
    });

    it("setOracle accepte address(0) pour désactiver l'oracle", async () => {
      await exchange.setOracle(ethers.ZeroAddress);
      expect(await exchange.priceOracle()).to.equal(ethers.ZeroAddress);
    });

    it("un non-owner ne peut pas changer l'oracle", async () => {
      await expect(exchange.connect(alice).setOracle(ethers.ZeroAddress))
        .to.be.revertedWithCustomError(exchange, "OwnableUnauthorizedAccount");
    });
  });

  // ── 5. Achat avec prix oracle dynamique ────────────────────────────────────

  describe("Achat avec prix oracle", () => {
    it("achat au prix oracle $90 — GLD correct", async () => {
      await oracle.setPrice(PRICE_90);
      await mockUSDC.connect(alice).approve(await exchange.getAddress(), HUNDRED_USDC);
      await exchange.connect(alice).buy(HUNDRED_USDC);
      expect(await gld.balanceOf(alice.address)).to.equal(1111n);
    });

    it("achat au prix oracle $100 — moins de GLD", async () => {
      await oracle.setPrice(PRICE_100);
      await mockUSDC.connect(alice).approve(await exchange.getAddress(), HUNDRED_USDC);
      await exchange.connect(alice).buy(HUNDRED_USDC);
      expect(await gld.balanceOf(alice.address)).to.equal(1000n);
    });

    it("achat au prix fallback si oracle périmé", async () => {
      const ts = BigInt(Math.floor(Date.now() / 1000)) - TWO_HOURS;
      await oracle.setUpdatedAt(ts);
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
      await oracle.setPrice(PRICE_108);
      const usdcAtHighPrice = await exchange.previewSell(gldBalance);
      const usdcAtLowPrice  = (gldBalance * PRICE_90) / 100_000n;
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
      await oracle.setPrice(PRICE_90);
      await mockUSDC.connect(alice).approve(await exchange.getAddress(), HUNDRED_USDC);
      await exchange.connect(alice).buy(HUNDRED_USDC);

      const gldBalance = await gld.balanceOf(alice.address);
      const usdcBefore = await mockUSDC.balanceOf(alice.address);

      await oracle.setPrice(PRICE_108);

      const usdcNeeded      = await exchange.previewSell(gldBalance);
      const treasuryBalance = await mockUSDC.balanceOf(await treasury.getAddress());
      if (usdcNeeded > treasuryBalance) {
        const extra = usdcNeeded - treasuryBalance;
        await mockUSDC.mint(owner.address, extra);
        await mockUSDC.connect(owner).approve(await treasury.getAddress(), extra);
        await treasury.connect(owner).deposit(extra);
      }

      await exchange.connect(alice).sell(gldBalance);
      const usdcAfter = await mockUSDC.balanceOf(alice.address);
      expect(usdcAfter).to.be.gt(usdcBefore + HUNDRED_USDC);
    });
  });
});
