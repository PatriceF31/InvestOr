import { expect } from "chai";
import hre from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";
import TreasuryModule from "../ignition/modules/Treasury.js";
import GLDModule from "../ignition/modules/GLD.js";
import ExchangeModule from "../ignition/modules/Exchange.js";

// ─── Constantes ──────────────────────────────────────────────────────────────

const ONE_USDC         = 1_000_000n;          // 1 USDC (6 dec)
const HUNDRED_USDC     = 100n * ONE_USDC;
const THOUSAND_USDC    = 1000n * ONE_USDC;

// Prix fallback : $90 par gramme (8 décimales Chainlink)
const FALLBACK_PRICE   = 90_00000000n;         // $90.00000000

// 100 USDC / $90 * 10^5 = ~111 unités GLD (0.111 grammes)
// previewBuy(100_000_000) = 100_000_000 * 100_000 / 9_000_000_000 = 1111
const EXPECTED_GLD_FOR_100_USDC = 1111n;

// ─── Suite principale ─────────────────────────────────────────────────────────

describe("Exchange — Étape 4 : achat et vente GLD/USDC", () => {
  let exchange: any;
  let gld: any;
  let treasury: any;
  let mockUSDC: any;
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let ethers: any;
  let ignition: any;

  beforeEach(async () => {
    const connection = await hre.network.connect();
    ethers   = (connection as any).ethers;
    ignition = (connection as any).ignition;

    [owner, alice, bob] = await ethers.getSigners();

    // 1. MockUSDC
    const MockUSDCFactory = await ethers.getContractFactory("MockUSDC");
    mockUSDC = await MockUSDCFactory.deploy();

    // 2. GLD
    const { proxy: gldProxy } = await ignition.deploy(GLDModule, {
      parameters: { GLDModule: { initialOwner: owner.address } },
    });
    gld = await ethers.getContractAt("GLD", await gldProxy.getAddress());

    // 3. Treasury
    const { proxy: treasuryProxy } = await ignition.deploy(TreasuryModule, {
      parameters: {
        TreasuryModule: {
          initialOwner: owner.address,
          usdcAddress:  await mockUSDC.getAddress(),
        },
      },
    });
    treasury = await ethers.getContractAt("Treasury", await treasuryProxy.getAddress());

    // 4. Exchange
    const { proxy: exchangeProxy } = await ignition.deploy(ExchangeModule, {
      parameters: {
        ExchangeModule: {
          initialOwner:      owner.address,
          gldAddress:        await gldProxy.getAddress(),
          treasuryAddress:   await treasuryProxy.getAddress(),
          oracleAddress:     ethers.ZeroAddress,
          initFallbackPrice: FALLBACK_PRICE,
        },
      },
    });
    exchange = await ethers.getContractAt("Exchange", await exchangeProxy.getAddress());

    // 5. Approuver Exchange comme minter sur GLD
    await gld.connect(owner).setMinter(await exchangeProxy.getAddress());

    // 6. Approuver Exchange comme opérateur sur Treasury
    //    (Exchange doit pouvoir appeler treasury.withdraw)
    //    Treasury n'a pas de rôle — Exchange appelle withdraw en son nom
    //    → le Treasury doit avoir des fonds = on pré-alimente via dépôt owner

    // 7. Mint USDC pour les utilisateurs
    await mockUSDC.mint(alice.address, THOUSAND_USDC);
    await mockUSDC.mint(bob.address,   THOUSAND_USDC);

    // 8. Pré-alimenter le Treasury pour les ventes (owner dépose du USDC)
    await mockUSDC.mint(owner.address, THOUSAND_USDC * 10n);
    await mockUSDC.connect(owner).approve(await treasury.getAddress(), THOUSAND_USDC * 10n);
    await treasury.connect(owner).deposit(THOUSAND_USDC * 10n);
  });

  // ── 1. Initialisation ──────────────────────────────────────────────────────

  describe("Initialisation", () => {
    it("doit avoir les bonnes adresses", async () => {
      expect(await exchange.gld()).to.equal(await gld.getAddress());
      expect(await exchange.treasury()).to.equal(await treasury.getAddress());
      expect(await exchange.usdc()).to.equal(await mockUSDC.getAddress());
    });

    it("doit avoir le bon prix fallback", async () => {
      expect(await exchange.fallbackPrice()).to.equal(FALLBACK_PRICE);
    });

    it("doit avoir le bon owner", async () => {
      expect(await exchange.owner()).to.equal(owner.address);
    });

    it("oracleMaxAge doit être 3600 par défaut", async () => {
      expect(await exchange.oracleMaxAge()).to.equal(3600n);
    });
  });

  // ── 2. Prix ───────────────────────────────────────────────────────────────

  describe("Prix", () => {
    it("getPrice retourne le fallback si pas d'oracle", async () => {
      const [price, isOracle] = await exchange.getPrice();
      expect(price).to.equal(FALLBACK_PRICE);
      expect(isOracle).to.be.false;
    });

    it("setFallbackPrice met à jour le prix", async () => {
      const newPrice = 95_00000000n;
      await exchange.setFallbackPrice(newPrice);
      const [price,] = await exchange.getPrice();
      expect(price).to.equal(newPrice);
    });

    it("setFallbackPrice émet l'event FallbackPriceUpdated", async () => {
      await expect(exchange.setFallbackPrice(95_00000000n))
        .to.emit(exchange, "FallbackPriceUpdated")
        .withArgs(FALLBACK_PRICE, 95_00000000n);
    });

    it("setFallbackPrice échoue avec prix nul", async () => {
      await expect(
        exchange.setFallbackPrice(0n)
      ).to.be.revertedWithCustomError(exchange, "ZeroAmount");
    });

    it("un non-owner ne peut pas changer le prix", async () => {
      await expect(
        exchange.connect(alice).setFallbackPrice(95_00000000n)
      ).to.be.revertedWithCustomError(exchange, "OwnableUnauthorizedAccount");
    });
  });

  // ── 3. Preview ────────────────────────────────────────────────────────────

  describe("Preview", () => {
    it("previewBuy calcule correctement le GLD pour 100 USDC", async () => {
      expect(await exchange.previewBuy(HUNDRED_USDC)).to.equal(EXPECTED_GLD_FOR_100_USDC);
    });

    it("previewSell calcule correctement l'USDC pour le GLD reçu", async () => {
      const gldAmount  = await exchange.previewBuy(HUNDRED_USDC);
      const usdcAmount = await exchange.previewSell(gldAmount);
      // Légère perte due à la division entière — usdcAmount <= HUNDRED_USDC
      expect(usdcAmount).to.be.lte(HUNDRED_USDC);
      expect(usdcAmount).to.be.gt(HUNDRED_USDC - ONE_USDC);
    });

    it("previewBuy échoue avec montant nul", async () => {
      await expect(
        exchange.previewBuy(0n)
      ).to.be.revertedWithCustomError(exchange, "ZeroAmount");
    });

    it("previewSell échoue avec montant nul", async () => {
      await expect(
        exchange.previewSell(0n)
      ).to.be.revertedWithCustomError(exchange, "ZeroAmount");
    });
  });

  // ── 4. Achat ──────────────────────────────────────────────────────────────

  describe("Buy", () => {
    it("alice peut acheter des GLD avec des USDC", async () => {
      await mockUSDC.connect(alice).approve(await exchange.getAddress(), HUNDRED_USDC);
      await exchange.connect(alice).buy(HUNDRED_USDC);

      expect(await gld.balanceOf(alice.address)).to.equal(EXPECTED_GLD_FOR_100_USDC);
    });

    it("le Treasury reçoit les USDC après achat", async () => {
      const treasuryBefore = await treasury.totalDeposited();
      await mockUSDC.connect(alice).approve(await exchange.getAddress(), HUNDRED_USDC);
      await exchange.connect(alice).buy(HUNDRED_USDC);
      expect(await treasury.totalDeposited()).to.equal(treasuryBefore + HUNDRED_USDC);
    });

    it("emit l'event TokensBought", async () => {
      await mockUSDC.connect(alice).approve(await exchange.getAddress(), HUNDRED_USDC);
      await expect(exchange.connect(alice).buy(HUNDRED_USDC))
        .to.emit(exchange, "TokensBought")
        .withArgs(alice.address, HUNDRED_USDC, EXPECTED_GLD_FOR_100_USDC, FALLBACK_PRICE);
    });

    it("échoue avec montant nul", async () => {
      await expect(
        exchange.connect(alice).buy(0n)
      ).to.be.revertedWithCustomError(exchange, "ZeroAmount");
    });

    it("échoue sans approbation USDC", async () => {
      await expect(
        exchange.connect(alice).buy(HUNDRED_USDC)
      ).to.revert(ethers);
    });

    it("échoue en pause", async () => {
      await exchange.pause();
      await mockUSDC.connect(alice).approve(await exchange.getAddress(), HUNDRED_USDC);
      await expect(
        exchange.connect(alice).buy(HUNDRED_USDC)
      ).to.be.revertedWithCustomError(exchange, "EnforcedPause");
    });
  });

  // ── 5. Vente ──────────────────────────────────────────────────────────────

  describe("Sell", () => {
    beforeEach(async () => {
      // Alice achète d'abord des GLD
      await mockUSDC.connect(alice).approve(await exchange.getAddress(), HUNDRED_USDC);
      await exchange.connect(alice).buy(HUNDRED_USDC);
    });

    it("alice peut vendre ses GLD et récupérer des USDC", async () => {
      const gldBalance   = await gld.balanceOf(alice.address);
      const usdcExpected = await exchange.previewSell(gldBalance);
      const usdcBefore   = await mockUSDC.balanceOf(alice.address);

      await exchange.connect(alice).sell(gldBalance);

      expect(await gld.balanceOf(alice.address)).to.equal(0n);
      expect(await mockUSDC.balanceOf(alice.address)).to.equal(usdcBefore + usdcExpected);
    });

    it("le GLD est brûlé après la vente", async () => {
      const gldBalance = await gld.balanceOf(alice.address);
      const supplyBefore = await gld.totalSupply();
      await exchange.connect(alice).sell(gldBalance);
      expect(await gld.totalSupply()).to.equal(supplyBefore - gldBalance);
    });

    it("emit l'event TokensSold", async () => {
      const gldBalance   = await gld.balanceOf(alice.address);
      const usdcExpected = await exchange.previewSell(gldBalance);
      await expect(exchange.connect(alice).sell(gldBalance))
        .to.emit(exchange, "TokensSold")
        .withArgs(alice.address, gldBalance, usdcExpected, FALLBACK_PRICE);
    });

    it("échoue avec montant nul", async () => {
      await expect(
        exchange.connect(alice).sell(0n)
      ).to.be.revertedWithCustomError(exchange, "ZeroAmount");
    });

    it("échoue si solde GLD insuffisant", async () => {
      const gldBalance = await gld.balanceOf(alice.address);
      await expect(
        exchange.connect(alice).sell(gldBalance + 1n)
      ).to.revert(ethers);
    });

    it("échoue en pause", async () => {
      await exchange.pause();
      await expect(
        exchange.connect(alice).sell(1n)
      ).to.be.revertedWithCustomError(exchange, "EnforcedPause");
    });
  });

  // ── 6. Minter GLD ────────────────────────────────────────────────────────

  describe("Rôle minter GLD", () => {
    it("Exchange est bien approuvé comme minter", async () => {
      expect(await gld.minter()).to.equal(await exchange.getAddress());
    });

    it("un compte non-minter ne peut pas mint directement", async () => {
      await expect(
        gld.connect(alice).mint(alice.address, 1000n)
      ).to.be.revertedWithCustomError(gld, "UnauthorizedMinter");
    });

    it("owner peut changer le minter", async () => {
      await gld.setMinter(bob.address);
      expect(await gld.minter()).to.equal(bob.address);
    });
  });

  // ── 7. Admin ─────────────────────────────────────────────────────────────

  describe("Admin", () => {
    it("le owner peut mettre en pause", async () => {
      await exchange.pause();
      expect(await exchange.paused()).to.be.true;
    });

    it("un non-owner ne peut pas mettre en pause", async () => {
      await expect(
        exchange.connect(alice).pause()
      ).to.be.revertedWithCustomError(exchange, "OwnableUnauthorizedAccount");
    });

    it("setOracle met à jour l'oracle", async () => {
      await exchange.setOracle(alice.address);
      expect(await exchange.priceOracle()).to.equal(alice.address);
    });

    it("setOracleMaxAge met à jour la durée", async () => {
      await exchange.setOracleMaxAge(7200n);
      expect(await exchange.oracleMaxAge()).to.equal(7200n);
    });

    it("setFeeCollector met à jour le collecteur", async () => {
      await exchange.setFeeCollector(bob.address);
      expect(await exchange.feeCollector()).to.equal(bob.address);
    });

    it("setFeeCollector échoue vers address(0)", async () => {
      await expect(
        exchange.setFeeCollector(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(exchange, "ZeroAddress");
    });
  });

  // ── 8. UUPS ───────────────────────────────────────────────────────────────

  describe("Upgradeability (UUPS)", () => {
    it("le owner peut upgrader l'implémentation", async () => {
      const ExchangeFactory = await ethers.getContractFactory("Exchange");
      const newImpl = await ExchangeFactory.deploy();
      await expect(
        exchange.upgradeToAndCall(await newImpl.getAddress(), "0x")
      ).to.not.revert(ethers);
    });

    it("un non-owner ne peut pas upgrader", async () => {
      const ExchangeFactory = await ethers.getContractFactory("Exchange");
      const newImpl = await ExchangeFactory.deploy();
      await expect(
        exchange.connect(alice).upgradeToAndCall(await newImpl.getAddress(), "0x")
      ).to.be.revertedWithCustomError(exchange, "OwnableUnauthorizedAccount");
    });
  });
});
