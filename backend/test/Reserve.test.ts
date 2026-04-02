import { expect } from "chai";
import hre from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";
// Déploiement direct sans Ignition (évite le cache entre tests)

// ─── Constantes ──────────────────────────────────────────────────────────────

const ONE_USDC       = 1_000_000n;
const HUNDRED_USDC   = 100n * ONE_USDC;
const THOUSAND_USDC  = 1000n * ONE_USDC;

const PRICE_90       = 90_00000000n;
const PRICE_108      = 108_00000000n;

const RATIO_100      = 10_000n;  // 100%
const RATIO_110      = 11_000n;  // 110%

// ─── Suite principale ─────────────────────────────────────────────────────────

describe("Reserve — Étapes 8 & 14 : Réserve + Proof of Reserve", () => {
  let reserve: any;
  let exchange: any;
  let gld: any;
  let treasury: any;
  let mockUSDC: any;
  let oracle: any;
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let ethers: any;

  beforeEach(async () => {
    const connection = await hre.network.connect();
    ethers = (connection as any).ethers;

    [owner, alice, bob] = await ethers.getSigners();

    [owner, alice, bob] = await ethers.getSigners();

    // ── Déploiement direct sans Ignition pour éviter le cache entre tests ──

    // MockUSDC
    const MockUSDCFactory = await ethers.getContractFactory("MockUSDC");
    mockUSDC = await MockUSDCFactory.deploy();

    // MockChainlinkOracle
    const OracleFactory = await ethers.getContractFactory("MockChainlinkOracle");
    oracle = await OracleFactory.deploy(PRICE_90, 8);

    // GLD impl + proxy
    const GLDFactory = await ethers.getContractFactory("GLD");
    const gldImpl = await GLDFactory.deploy();
    const ProxyFactory = await ethers.getContractFactory("InvestOrProxy");
    const gldInitData = gldImpl.interface.encodeFunctionData("initialize", [owner.address]);
    const gldProxy = await ProxyFactory.deploy(await gldImpl.getAddress(), gldInitData);
    gld = await ethers.getContractAt("GLD", await gldProxy.getAddress());

    // Treasury impl + proxy
    const TreasuryFactory = await ethers.getContractFactory("Treasury");
    const treasuryImpl = await TreasuryFactory.deploy();
    const treasuryInitData = treasuryImpl.interface.encodeFunctionData("initialize", [
      owner.address, await mockUSDC.getAddress()
    ]);
    const treasuryProxy = await ProxyFactory.deploy(await treasuryImpl.getAddress(), treasuryInitData);
    treasury = await ethers.getContractAt("Treasury", await treasuryProxy.getAddress());

    // Exchange impl + proxy
    const ExchangeFactory = await ethers.getContractFactory("Exchange");
    const exchangeImpl = await ExchangeFactory.deploy();
    const exchangeInitData = exchangeImpl.interface.encodeFunctionData("initialize", [
      owner.address,
      await gldProxy.getAddress(),
      await treasuryProxy.getAddress(),
      await oracle.getAddress(),
      PRICE_90,
    ]);
    const exchangeProxy = await ProxyFactory.deploy(await exchangeImpl.getAddress(), exchangeInitData);
    exchange = await ethers.getContractAt("Exchange", await exchangeProxy.getAddress());

    // Reserve impl + proxy
    const ReserveFactory = await ethers.getContractFactory("Reserve");
    const reserveImpl = await ReserveFactory.deploy();
    const reserveInitData = reserveImpl.interface.encodeFunctionData("initialize", [
      owner.address,
      await gldProxy.getAddress(),
      await treasuryProxy.getAddress(),
      await exchangeProxy.getAddress(),
      await oracle.getAddress(),
      RATIO_100,
    ]);
    const reserveProxy = await ProxyFactory.deploy(await reserveImpl.getAddress(), reserveInitData);
    reserve = await ethers.getContractAt("Reserve", await reserveProxy.getAddress());

    // Rôles
    await gld.setMinter(await exchangeProxy.getAddress());
    await treasury.setOperator(await exchangeProxy.getAddress());
    await exchange.transferOwnership(await reserveProxy.getAddress());

    // Fonds alice
    await mockUSDC.mint(alice.address, THOUSAND_USDC);
  });

  // ── Helper : alice achète des GLD ─────────────────────────────────────────

  async function aliceBuys(usdcAmount: bigint) {
    await mockUSDC.connect(alice).approve(await exchange.getAddress(), usdcAmount);
    await exchange.connect(alice).buy(usdcAmount);
  }

  // ── 1. Initialisation ──────────────────────────────────────────────────────

  describe("Initialisation", () => {
    it("doit avoir le bon owner", async () => {
      expect(await reserve.owner()).to.equal(owner.address);
    });

    it("minRatioBps initial = 10000 (100%)", async () => {
      expect(await reserve.minRatioBps()).to.equal(RATIO_100);
    });

    it("oracleMaxAge initial = 3600", async () => {
      expect(await reserve.oracleMaxAge()).to.equal(3600n);
    });

    it("lastCheckHealthy initial = true", async () => {
      expect(await reserve.lastCheckHealthy()).to.be.true;
    });

    it("BASIS_POINTS = 10000", async () => {
      expect(await reserve.BASIS_POINTS()).to.equal(10_000n);
    });
  });

  // ── 2. checkReserve ────────────────────────────────────────────────────────

  describe("checkReserve", () => {
    it("retourne ratio maximal si GLD supply = 0", async () => {
      const [,,, ratio] = await reserve.checkReserve();
      expect(ratio).to.equal(ethers.MaxUint256);
    });

    it("retourne ratio 100% si USDC = valeur GLD exacte", async () => {
      await aliceBuys(HUNDRED_USDC);
      const [usdcReserve,, goldValue, ratio] = await reserve.checkReserve();
      // USDC déposé = 100 USDC exactement
      // ratio = usdcReserve * 10000 / goldValue
      expect(ratio).to.be.gte(9990n); // ~100% avec arrondi
    });

    it("ratio diminue si le prix de l'or monte", async () => {
      await aliceBuys(HUNDRED_USDC);
      const [,,, ratioBefore] = await reserve.checkReserve();

      await oracle.setPrice(PRICE_108); // +20%
      const [,,, ratioAfter] = await reserve.checkReserve();

      expect(ratioAfter).to.be.lt(ratioBefore);
    });

    it("ratio augmente si on injecte des USDC", async () => {
      await aliceBuys(HUNDRED_USDC);
      await oracle.setPrice(PRICE_108);
      const [,,, ratioBefore] = await reserve.checkReserve();

      // Injecter 20 USDC supplémentaires directement dans le Treasury
      await mockUSDC.mint(owner.address, 20n * ONE_USDC);
      await mockUSDC.connect(owner).approve(await treasury.getAddress(), 20n * ONE_USDC);
      await treasury.connect(owner).deposit(20n * ONE_USDC);

      const [,,, ratioAfter] = await reserve.checkReserve();
      expect(ratioAfter).to.be.gt(ratioBefore);
    });
  });

  // ── 3. isHealthy ──────────────────────────────────────────────────────────

  describe("isHealthy", () => {
    it("healthy = true si supply GLD = 0", async () => {
      expect(await reserve.isHealthy()).to.be.true;
    });

    it("healthy = true si ratio >= minRatio", async () => {
      await aliceBuys(HUNDRED_USDC);
      expect(await reserve.isHealthy()).to.be.true;
    });

    it("healthy = false si ratio min > ratio actuel", async () => {
      await aliceBuys(HUNDRED_USDC);
      // Prix monte à $108 → ratio ~83% < minRatio 100% → déficit
      await oracle.setPrice(PRICE_108);
      expect(await reserve.isHealthy()).to.be.false;
    });

    it("healthy = false si prix monte > 0% avec minRatio 100%", async () => {
      await aliceBuys(HUNDRED_USDC);
      await oracle.setPrice(PRICE_108); // +20% → ratio ~83%
      expect(await reserve.isHealthy()).to.be.false;
    });
  });

  // ── 4. getReserveStatus ───────────────────────────────────────────────────

  describe("getReserveStatus", () => {
    it("retourne l'état complet de la réserve", async () => {
      await aliceBuys(HUNDRED_USDC);
      const status = await reserve.getReserveStatus();
      expect(status.usdcReserve).to.be.gt(0n);
      expect(status.gldSupply).to.be.gt(0n);
      expect(status.goldValueUsdc).to.be.gt(0n);
      expect(status.minRatio).to.equal(RATIO_100);
      expect(status.price).to.equal(PRICE_90);
    });

    it("deficitUsdc = 0 si sain", async () => {
      await aliceBuys(HUNDRED_USDC);
      const status = await reserve.getReserveStatus();
      expect(status.deficitUsdc).to.equal(0n);
    });

    it("deficitUsdc > 0 si ratio insuffisant", async () => {
      await aliceBuys(HUNDRED_USDC);
      await oracle.setPrice(PRICE_108);
      const status = await reserve.getReserveStatus();
      expect(status.deficitUsdc).to.be.gt(0n);
    });
  });

  // ── 5. proofOfReserve ─────────────────────────────────────────────────────

  describe("proofOfReserve", () => {
    it("n'importe qui peut appeler proofOfReserve", async () => {
      await expect(
        reserve.connect(alice).proofOfReserve()
      ).to.not.revert(ethers);
    });

    it("emit ReserveChecked avec les bons params", async () => {
      await aliceBuys(HUNDRED_USDC);
      await expect(reserve.proofOfReserve())
        .to.emit(reserve, "ReserveChecked");
    });

    it("met à jour lastCheckAt", async () => {
      await reserve.proofOfReserve();
      expect(await reserve.lastCheckAt()).to.be.gt(0n);
    });

    it("met à jour lastCheckHealthy à true si sain", async () => {
      await aliceBuys(HUNDRED_USDC);
      await reserve.proofOfReserve();
      expect(await reserve.lastCheckHealthy()).to.be.true;
    });

    it("pause Exchange si ratio insuffisant", async () => {
      await aliceBuys(HUNDRED_USDC);
      await oracle.setPrice(PRICE_108); // ratio ~83% < 100%

      expect(await exchange.paused()).to.be.false;
      await reserve.proofOfReserve();
      expect(await exchange.paused()).to.be.true;
    });

    it("emit ExchangePausedByReserve si pause", async () => {
      await aliceBuys(HUNDRED_USDC);
      await oracle.setPrice(PRICE_108);
      await expect(reserve.proofOfReserve())
        .to.emit(reserve, "ExchangePausedByReserve");
    });

    it("emit ReserveDeficit si ratio insuffisant", async () => {
      await aliceBuys(HUNDRED_USDC);
      await oracle.setPrice(PRICE_108);
      await expect(reserve.proofOfReserve())
        .to.emit(reserve, "ReserveDeficit");
    });

    it("met à jour lastCheckHealthy à false si déficit", async () => {
      await aliceBuys(HUNDRED_USDC);
      await oracle.setPrice(PRICE_108);
      await reserve.proofOfReserve();
      expect(await reserve.lastCheckHealthy()).to.be.false;
    });

    it("ne pause pas Exchange si déjà pausé", async () => {
      await aliceBuys(HUNDRED_USDC);
      await oracle.setPrice(PRICE_108);
      await reserve.proofOfReserve(); // 1er appel — pause Exchange
      // 2ème appel — ne doit pas revert
      await expect(reserve.proofOfReserve()).to.not.revert(ethers);
    });

    it("réactive Exchange si ratio restauré", async () => {
      await aliceBuys(HUNDRED_USDC);
      await oracle.setPrice(PRICE_108);
      await reserve.proofOfReserve(); // Exchange pausé

      // Restaurer le prix
      await oracle.setPrice(PRICE_90);
      await reserve.proofOfReserve(); // Devrait réactiver Exchange

      expect(await exchange.paused()).to.be.false;
    });

    it("emit ExchangeUnpausedByReserve si ratio restauré", async () => {
      await aliceBuys(HUNDRED_USDC);
      await oracle.setPrice(PRICE_108);
      await reserve.proofOfReserve();

      await oracle.setPrice(PRICE_90);
      await expect(reserve.proofOfReserve())
        .to.emit(reserve, "ExchangeUnpausedByReserve");
    });
  });

  // ── 6. recapitalize ───────────────────────────────────────────────────────

  describe("recapitalize", () => {
    beforeEach(async () => {
      await aliceBuys(HUNDRED_USDC);
      await oracle.setPrice(PRICE_108); // crée un déficit
      await reserve.proofOfReserve();   // Exchange pausé
    });

    it("injecte des USDC dans le Treasury", async () => {
      const before = await treasury.totalDeposited();
      await mockUSDC.mint(bob.address, 20n * ONE_USDC);
      await mockUSDC.connect(bob).approve(await reserve.getAddress(), 20n * ONE_USDC);
      await reserve.connect(bob).recapitalize(20n * ONE_USDC);
      expect(await treasury.totalDeposited()).to.equal(before + 20n * ONE_USDC);
    });

    it("emit Recapitalized", async () => {
      await mockUSDC.mint(bob.address, 20n * ONE_USDC);
      await mockUSDC.connect(bob).approve(await reserve.getAddress(), 20n * ONE_USDC);
      await expect(reserve.connect(bob).recapitalize(20n * ONE_USDC))
        .to.emit(reserve, "Recapitalized");
    });

    it("réactive Exchange si ratio restauré après recapitalize", async () => {
      expect(await exchange.paused()).to.be.true;
      // Injecter suffisamment
      const deficit = (await reserve.getReserveStatus()).deficitUsdc;
      await mockUSDC.mint(bob.address, deficit + ONE_USDC);
      await mockUSDC.connect(bob).approve(await reserve.getAddress(), deficit + ONE_USDC);
      await reserve.connect(bob).recapitalize(deficit + ONE_USDC);
      expect(await exchange.paused()).to.be.false;
    });

    it("n'importe qui peut recapitaliser", async () => {
      await mockUSDC.mint(alice.address, 5n * ONE_USDC);
      await mockUSDC.connect(alice).approve(await reserve.getAddress(), 5n * ONE_USDC);
      await expect(
        reserve.connect(alice).recapitalize(5n * ONE_USDC)
      ).to.not.revert(ethers);
    });

    it("échoue avec montant nul", async () => {
      await expect(
        reserve.connect(bob).recapitalize(0n)
      ).to.be.revertedWithCustomError(reserve, "ZeroAmount");
    });

    it("échoue sans approbation USDC", async () => {
      await expect(
        reserve.connect(bob).recapitalize(20n * ONE_USDC)
      ).to.revert(ethers);
    });
  });

  // ── 7. setMinRatio ────────────────────────────────────────────────────────

  describe("setMinRatio", () => {
    it("owner peut changer le ratio minimum", async () => {
      await reserve.connect(owner).setMinRatio(RATIO_110);
      expect(await reserve.minRatioBps()).to.equal(RATIO_110);
    });

    it("emit MinRatioUpdated", async () => {
      await expect(reserve.connect(owner).setMinRatio(RATIO_110))
        .to.emit(reserve, "MinRatioUpdated")
        .withArgs(RATIO_100, RATIO_110);
    });

    it("un non-owner ne peut pas changer le ratio", async () => {
      await expect(
        reserve.connect(alice).setMinRatio(RATIO_110)
      ).to.be.revertedWithCustomError(reserve, "OwnableUnauthorizedAccount");
    });

    it("échoue avec ratio nul", async () => {
      await expect(
        reserve.connect(owner).setMinRatio(0n)
      ).to.be.revertedWithCustomError(reserve, "InvalidRatio");
    });

    it("échoue avec ratio > 20000 (200%)", async () => {
      await expect(
        reserve.connect(owner).setMinRatio(20_001n)
      ).to.be.revertedWithCustomError(reserve, "InvalidRatio");
    });

    it("accepte le ratio maximum 20000 (200%)", async () => {
      await expect(
        reserve.connect(owner).setMinRatio(20_000n)
      ).to.not.revert(ethers);
    });
  });

  // ── 8. Prix et oracle ────────────────────────────────────────────────────

  describe("Prix et oracle", () => {
    it("getPrice retourne le prix oracle", async () => {
      expect(await reserve.getPrice()).to.equal(PRICE_90);
    });

    it("getPrice retourne le fallback Exchange si oracle KO", async () => {
      await oracle.setShouldRevert(true);
      expect(await reserve.getPrice()).to.equal(PRICE_90); // fallback Exchange
    });

    it("setOracle émet l'event OracleUpdated", async () => {
      const OracleFactory = await ethers.getContractFactory("MockChainlinkOracle");
      const newOracle = await OracleFactory.deploy(PRICE_108, 8);
      await expect(reserve.connect(owner).setOracle(await newOracle.getAddress()))
        .to.emit(reserve, "OracleUpdated");
    });

    it("setOracleMaxAge met à jour la durée", async () => {
      await reserve.connect(owner).setOracleMaxAge(7200n);
      expect(await reserve.oracleMaxAge()).to.equal(7200n);
    });
  });

  // ── 9. UUPS ───────────────────────────────────────────────────────────────

  describe("Upgradeability (UUPS)", () => {
    it("le owner peut upgrader", async () => {
      const Factory = await ethers.getContractFactory("Reserve");
      const newImpl = await Factory.deploy();
      await expect(
        reserve.connect(owner).upgradeToAndCall(await newImpl.getAddress(), "0x")
      ).to.not.revert(ethers);
    });

    it("un non-owner ne peut pas upgrader", async () => {
      const Factory = await ethers.getContractFactory("Reserve");
      const newImpl = await Factory.deploy();
      await expect(
        reserve.connect(alice).upgradeToAndCall(await newImpl.getAddress(), "0x")
      ).to.be.revertedWithCustomError(reserve, "OwnableUnauthorizedAccount");
    });
  });
});
