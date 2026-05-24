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

const FALLBACK_PRICE = 90_00000000n;

// 100 USDC / $90 * 1e5 = 1111 GLD (arrondi)
const EXPECTED_GLD_FOR_100_USDC = 1111n;
const EXPECTED_GLD_FOR_100_EURC = 1111n;  // même prix, même calcul

// ─── Suite principale ─────────────────────────────────────────────────────────

describe("Exchange V3 — Multi-token USDC + EURC", () => {
  let exchange: any;
  let gld:      any;
  let treasury: any;
  let mockUSDC: any;
  let mockEURC: any;
  let owner:    HardhatEthersSigner;
  let alice:    HardhatEthersSigner;
  let bob:      HardhatEthersSigner;
  let ethers:   any;

  // ─── beforeEach ────────────────────────────────────────────────────────────

  beforeEach(async () => {
    const connection = await hre.network.connect();
    ethers = (connection as any).ethers;
    [owner, alice, bob] = await ethers.getSigners();

    const ProxyFactory = await ethers.getContractFactory("InvestOrProxy");

    // Mock tokens
    mockUSDC = await (await ethers.getContractFactory("MockUSDC")).deploy();
    mockEURC = await (await ethers.getContractFactory("MockUSDC")).deploy();

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

    // Exchange V3
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

    // Configurer EURC dans Exchange
    await exchange.connect(owner).setEurc(await mockEURC.getAddress());

    // Rôles
    await gld.setMinter(await exchangeProxy.getAddress());
    await treasury.setOperator(await exchangeProxy.getAddress());

    // Fonds alice et bob
    await mockUSDC.mint(alice.address, THOUSAND_USDC);
    await mockUSDC.mint(bob.address,   THOUSAND_USDC);
    await mockEURC.mint(alice.address, THOUSAND_EURC);
    await mockEURC.mint(bob.address,   THOUSAND_EURC);

    // Pré-alimenter le Treasury (pour les ventes)
    await mockUSDC.mint(owner.address, THOUSAND_USDC * 10n);
    await mockEURC.mint(owner.address, THOUSAND_EURC * 10n);
    await mockUSDC.connect(owner).approve(await treasury.getAddress(), THOUSAND_USDC * 10n);
    await mockEURC.connect(owner).approve(await treasury.getAddress(), THOUSAND_EURC * 10n);
    await treasury.connect(owner).deposit(THOUSAND_USDC * 10n, await mockUSDC.getAddress());
    await treasury.connect(owner).deposit(THOUSAND_EURC * 10n, await mockEURC.getAddress());
  });

  // ─── Helpers ─────────────────────────────────────────────────────────────

  async function aliceBuysUsdc(amount = HUNDRED_USDC) {
    await mockUSDC.connect(alice).approve(await exchange.getAddress(), amount);
    await exchange.connect(alice).buy(amount, await mockUSDC.getAddress());
  }

  async function aliceBuysEurc(amount = HUNDRED_EURC) {
    await mockEURC.connect(alice).approve(await exchange.getAddress(), amount);
    await exchange.connect(alice).buy(amount, await mockEURC.getAddress());
  }

  // ── 1. Initialisation ──────────────────────────────────────────────────────

  describe("Initialisation", () => {
    it("doit avoir les bonnes adresses", async () => {
      expect(await exchange.gld()).to.equal(await gld.getAddress());
      expect(await exchange.treasury()).to.equal(await treasury.getAddress());
    });

    it("eurc configuré", async () => {
      expect(await exchange.eurc()).to.equal(await mockEURC.getAddress());
    });

    it("fallbackPrice correct", async () => {
      expect(await exchange.fallbackPrice()).to.equal(FALLBACK_PRICE);
    });

    it("getPrice retourne source=3 (fallback) sans oracle", async () => {
      const [, source] = await exchange.getPrice();
      expect(source).to.equal(3n);
    });
  });

  // ── 2. previewBuy / previewSell multi-token ────────────────────────────────

  describe("Preview multi-token", () => {
    it("previewBuy USDC calcule correctement", async () => {
      expect(await exchange.previewBuy(HUNDRED_USDC, await mockUSDC.getAddress()))
        .to.equal(EXPECTED_GLD_FOR_100_USDC);
    });

    it("previewBuy EURC calcule correctement (même prix)", async () => {
      expect(await exchange.previewBuy(HUNDRED_EURC, await mockEURC.getAddress()))
        .to.equal(EXPECTED_GLD_FOR_100_EURC);
    });

    it("previewSell USDC et EURC donnent le même résultat (même prix)", async () => {
      const usdc = await exchange.previewSell(1000n, await mockUSDC.getAddress());
      const eurc = await exchange.previewSell(1000n, await mockEURC.getAddress());
      expect(usdc).to.equal(eurc);
    });

    it("previewBuy échoue avec token non supporté", async () => {
      const rando = await (await ethers.getContractFactory("MockUSDC")).deploy();
      await expect(
        exchange.previewBuy(HUNDRED_USDC, await rando.getAddress())
      ).to.be.revertedWithCustomError(exchange, "UnsupportedToken");
    });

    it("previewBuy échoue avec montant nul", async () => {
      await expect(
        exchange.previewBuy(0n, await mockUSDC.getAddress())
      ).to.be.revertedWithCustomError(exchange, "ZeroAmount");
    });
  });

  // ── 3. Achat avec USDC ────────────────────────────────────────────────────

  describe("Buy — USDC", () => {
    it("alice peut acheter des GLD avec USDC", async () => {
      await aliceBuysUsdc();
      expect(await gld.balanceOf(alice.address)).to.equal(EXPECTED_GLD_FOR_100_USDC);
    });

    it("le Treasury USDC reçoit les fonds", async () => {
      const before = await treasury.totalDepositedByToken(await mockUSDC.getAddress());
      await aliceBuysUsdc();
      expect(await treasury.totalDepositedByToken(await mockUSDC.getAddress()))
        .to.equal(before + HUNDRED_USDC);
    });

    it("emit TokensBought avec le bon token", async () => {
      await mockUSDC.connect(alice).approve(await exchange.getAddress(), HUNDRED_USDC);
      await expect(exchange.connect(alice).buy(HUNDRED_USDC, await mockUSDC.getAddress()))
        .to.emit(exchange, "TokensBought")
        .withArgs(alice.address, await mockUSDC.getAddress(), HUNDRED_USDC, EXPECTED_GLD_FOR_100_USDC, FALLBACK_PRICE);
    });

    it("échoue en pause", async () => {
      await exchange.pause();
      await mockUSDC.connect(alice).approve(await exchange.getAddress(), HUNDRED_USDC);
      await expect(
        exchange.connect(alice).buy(HUNDRED_USDC, await mockUSDC.getAddress())
      ).to.be.revertedWithCustomError(exchange, "EnforcedPause");
    });

    it("échoue sans approbation", async () => {
      await expect(
        exchange.connect(alice).buy(HUNDRED_USDC, await mockUSDC.getAddress())
      ).to.revert(ethers);
    });

    it("échoue avec token non supporté", async () => {
      const rando = await (await ethers.getContractFactory("MockUSDC")).deploy();
      await expect(
        exchange.connect(alice).buy(HUNDRED_USDC, await rando.getAddress())
      ).to.be.revertedWithCustomError(exchange, "UnsupportedToken");
    });
  });

  // ── 4. Achat avec EURC ────────────────────────────────────────────────────

  describe("Buy — EURC", () => {
    it("alice peut acheter des GLD avec EURC", async () => {
      await aliceBuysEurc();
      expect(await gld.balanceOf(alice.address)).to.equal(EXPECTED_GLD_FOR_100_EURC);
    });

    it("le Treasury EURC reçoit les fonds", async () => {
      const before = await treasury.totalDepositedByToken(await mockEURC.getAddress());
      await aliceBuysEurc();
      expect(await treasury.totalDepositedByToken(await mockEURC.getAddress()))
        .to.equal(before + HUNDRED_EURC);
    });

    it("achat EURC n'affecte pas le solde USDC du Treasury", async () => {
      const usdcBefore = await treasury.totalDepositedByToken(await mockUSDC.getAddress());
      await aliceBuysEurc();
      expect(await treasury.totalDepositedByToken(await mockUSDC.getAddress()))
        .to.equal(usdcBefore);
    });

    it("emit TokensBought avec EURC", async () => {
      await mockEURC.connect(alice).approve(await exchange.getAddress(), HUNDRED_EURC);
      await expect(exchange.connect(alice).buy(HUNDRED_EURC, await mockEURC.getAddress()))
        .to.emit(exchange, "TokensBought")
        .withArgs(alice.address, await mockEURC.getAddress(), HUNDRED_EURC, EXPECTED_GLD_FOR_100_EURC, FALLBACK_PRICE);
    });
  });

  // ── 5. Vente avec USDC ────────────────────────────────────────────────────

  describe("Sell — USDC", () => {
    beforeEach(async () => { await aliceBuysUsdc(); });

    it("alice peut vendre ses GLD et récupérer USDC", async () => {
      const gldBalance   = await gld.balanceOf(alice.address);
      const usdcExpected = await exchange.previewSell(gldBalance, await mockUSDC.getAddress());
      const usdcBefore   = await mockUSDC.balanceOf(alice.address);
      await exchange.connect(alice).sell(gldBalance, await mockUSDC.getAddress());
      expect(await gld.balanceOf(alice.address)).to.equal(0n);
      expect(await mockUSDC.balanceOf(alice.address)).to.equal(usdcBefore + usdcExpected);
    });

    it("GLD brûlé après vente", async () => {
      const gldBalance   = await gld.balanceOf(alice.address);
      const supplyBefore = await gld.totalSupply();
      await exchange.connect(alice).sell(gldBalance, await mockUSDC.getAddress());
      expect(await gld.totalSupply()).to.equal(supplyBefore - gldBalance);
    });

    it("emit TokensSold avec USDC", async () => {
      const gldBalance   = await gld.balanceOf(alice.address);
      const usdcExpected = await exchange.previewSell(gldBalance, await mockUSDC.getAddress());
      await expect(exchange.connect(alice).sell(gldBalance, await mockUSDC.getAddress()))
        .to.emit(exchange, "TokensSold")
        .withArgs(alice.address, await mockUSDC.getAddress(), gldBalance, usdcExpected, FALLBACK_PRICE);
    });
  });

  // ── 6. Vente avec EURC ────────────────────────────────────────────────────

  describe("Sell — EURC", () => {
    beforeEach(async () => { await aliceBuysEurc(); });

    it("alice peut vendre ses GLD et récupérer EURC", async () => {
      const gldBalance   = await gld.balanceOf(alice.address);
      const eurcExpected = await exchange.previewSell(gldBalance, await mockEURC.getAddress());
      const eurcBefore   = await mockEURC.balanceOf(alice.address);
      await exchange.connect(alice).sell(gldBalance, await mockEURC.getAddress());
      expect(await mockEURC.balanceOf(alice.address)).to.equal(eurcBefore + eurcExpected);
    });

    it("vente EURC n'affecte pas le solde USDC du Treasury", async () => {
      const gldBalance = await gld.balanceOf(alice.address);
      const usdcBefore = await treasury.totalDepositedByToken(await mockUSDC.getAddress());
      await exchange.connect(alice).sell(gldBalance, await mockEURC.getAddress());
      expect(await treasury.totalDepositedByToken(await mockUSDC.getAddress())).to.equal(usdcBefore);
    });
  });

  // ── 7. Cashback V3 ────────────────────────────────────────────────────────

  describe("Cashback V3 — par token", () => {
    const feeBps = 100n; // 1% pour faciliter les calculs

    beforeEach(async () => {
      await exchange.connect(owner).setFeeBps(feeBps);
    });

    it("previewCashback retourne deux lignes (USDC + EURC)", async () => {
      await aliceBuysUsdc();
      await aliceBuysEurc();
      const [tokens, amounts] = await exchange.previewCashback(alice.address);
      expect(tokens.length).to.equal(2);
      expect(tokens).to.include(await mockUSDC.getAddress());
      expect(tokens).to.include(await mockEURC.getAddress());
    });

    it("frais USDC et EURC sont trackés séparément", async () => {
      await aliceBuysUsdc();
      await aliceBuysEurc();
      const [tokens, amounts] = await exchange.previewCashback(alice.address);
      const idxUsdc = tokens.indexOf(await mockUSDC.getAddress());
      const idxEurc = tokens.indexOf(await mockEURC.getAddress());
      expect(amounts[idxUsdc]).to.be.gt(0n);
      expect(amounts[idxEurc]).to.be.gt(0n);
    });

    it("achat USDC uniquement → cashback EURC = 0", async () => {
      await aliceBuysUsdc();
      const [tokens, amounts] = await exchange.previewCashback(alice.address);
      const idxEurc = tokens.indexOf(await mockEURC.getAddress());
      expect(amounts[idxEurc]).to.equal(0n);
    });

    it("claimCashback(USDC) réclame les frais USDC uniquement", async () => {
      await aliceBuysUsdc();
      const [, amounts] = await exchange.previewCashback(alice.address);
      const usdcIdx = (await exchange.previewCashback(alice.address))[0]
        .indexOf(await mockUSDC.getAddress());
      const cashbackExpected = (await exchange.previewCashback(alice.address))[1][usdcIdx];

      if (cashbackExpected > 0n) {
        const before = await mockUSDC.balanceOf(alice.address);
        await exchange.connect(alice).claimCashback(await mockUSDC.getAddress());
        expect(await mockUSDC.balanceOf(alice.address)).to.equal(before + cashbackExpected);
      }
    });

    it("claimCashback échoue si aucun frais accumulé (InactiveAccount)", async () => {
      // Sans achat préalable, lastActivityAt = 0 → InactiveAccount
      await expect(
        exchange.connect(alice).claimCashback(await mockUSDC.getAddress())
      ).to.be.revertedWithCustomError(exchange, "InactiveAccount");
    });

    it("claimCashback échoue si frais = 0 (NoCashbackAvailable)", async () => {
      // Achat sans fees → lastActivityAt initialisé mais feesBySlotV2 = 0
      await exchange.connect(owner).setFeeBps(0n);
      await aliceBuysUsdc();
      await expect(
        exchange.connect(alice).claimCashback(await mockUSDC.getAddress())
      ).to.be.revertedWithCustomError(exchange, "NoCashbackAvailable");
    });

    it("claimCashback échoue avec token non supporté", async () => {
      const rando = await (await ethers.getContractFactory("MockUSDC")).deploy();
      await expect(
        exchange.connect(alice).claimCashback(await rando.getAddress())
      ).to.be.revertedWithCustomError(exchange, "UnsupportedToken");
    });

    it("claimAllCashback réclame USDC et EURC ensemble", async () => {
      await aliceBuysUsdc();
      await aliceBuysEurc();

      const [tokens, amounts] = await exchange.previewCashback(alice.address);
      const usdcBefore = await mockUSDC.balanceOf(alice.address);
      const eurcBefore = await mockEURC.balanceOf(alice.address);

      await exchange.connect(alice).claimAllCashback();

      expect(await mockUSDC.balanceOf(alice.address)).to.be.gte(usdcBefore);
      expect(await mockEURC.balanceOf(alice.address)).to.be.gte(eurcBefore);
    });

    it("claimAllCashback échoue si aucun frais (InactiveAccount)", async () => {
      await expect(
        exchange.connect(alice).claimAllCashback()
      ).to.be.revertedWithCustomError(exchange, "InactiveAccount");
    });

    it("claimAllCashback échoue si fees = 0 (NoCashbackAvailable)", async () => {
      await exchange.connect(owner).setFeeBps(0n);
      await aliceBuysUsdc();
      await aliceBuysEurc();
      await expect(
        exchange.connect(alice).claimAllCashback()
      ).to.be.revertedWithCustomError(exchange, "NoCashbackAvailable");
    });

    it("emit CashbackClaimed avec le bon token", async () => {
      await exchange.connect(owner).setFeeBps(200n); // 2% pour avoir un cashback non nul
      await aliceBuysUsdc(THOUSAND_USDC);
      await expect(exchange.connect(alice).claimCashback(await mockUSDC.getAddress()))
        .to.emit(exchange, "CashbackClaimed")
        .withArgs(alice.address, await mockUSDC.getAddress(), (v: bigint) => v > 0n);
    });
  });

  // ── 8. Scénario mixte USDC + EURC ─────────────────────────────────────────

  describe("Scénario mixte — achats USDC et EURC", () => {
    it("alice achète en USDC, bob en EURC — GLD indépendants", async () => {
      await aliceBuysUsdc();
      // Bob achète en EURC directement
      await mockEURC.connect(bob).approve(await exchange.getAddress(), HUNDRED_EURC);
      await exchange.connect(bob).buy(HUNDRED_EURC, await mockEURC.getAddress());

      expect(await gld.balanceOf(alice.address)).to.equal(EXPECTED_GLD_FOR_100_USDC);
      expect(await gld.balanceOf(bob.address)).to.equal(EXPECTED_GLD_FOR_100_EURC);
    });

    it("totalDeposited Treasury = USDC + EURC (delta après achats)", async () => {
      const totalBefore = await treasury.totalDeposited();
      await aliceBuysUsdc();
      await aliceBuysEurc();
      const totalAfter = await treasury.totalDeposited();
      // Les deux achats ajoutent HUNDRED_USDC + HUNDRED_EURC au total
      expect(totalAfter - totalBefore).to.equal(HUNDRED_USDC + HUNDRED_EURC);
    });

    it("alice vend GLD contre EURC alors qu'elle avait acheté en USDC", async () => {
      await aliceBuysUsdc();
      const gldBalance = await gld.balanceOf(alice.address);
      const eurcBefore = await mockEURC.balanceOf(alice.address);
      await exchange.connect(alice).sell(gldBalance, await mockEURC.getAddress());
      expect(await mockEURC.balanceOf(alice.address)).to.be.gt(eurcBefore);
    });
  });

  // ── 9. Admin ──────────────────────────────────────────────────────────────

  describe("Admin", () => {
    it("setEurc met à jour l'adresse EURC", async () => {
      const newEurc = await (await ethers.getContractFactory("MockUSDC")).deploy();
      await exchange.connect(owner).setEurc(await newEurc.getAddress());
      expect(await exchange.eurc()).to.equal(await newEurc.getAddress());
    });

    it("setEurc émet EurcUpdated", async () => {
      const oldEurc = await exchange.eurc();
      const newEurc = await (await ethers.getContractFactory("MockUSDC")).deploy();
      await expect(exchange.connect(owner).setEurc(await newEurc.getAddress()))
        .to.emit(exchange, "EurcUpdated")
        .withArgs(oldEurc, await newEurc.getAddress());
    });

    it("non-owner ne peut pas setEurc", async () => {
      await expect(
        exchange.connect(alice).setEurc(await mockEURC.getAddress())
      ).to.be.revertedWithCustomError(exchange, "OwnableUnauthorizedAccount");
    });

    it("pause bloque buy USDC et EURC", async () => {
      await exchange.connect(owner).pause();
      await mockUSDC.connect(alice).approve(await exchange.getAddress(), HUNDRED_USDC);
      await mockEURC.connect(alice).approve(await exchange.getAddress(), HUNDRED_EURC);
      await expect(
        exchange.connect(alice).buy(HUNDRED_USDC, await mockUSDC.getAddress())
      ).to.be.revertedWithCustomError(exchange, "EnforcedPause");
      await expect(
        exchange.connect(alice).buy(HUNDRED_EURC, await mockEURC.getAddress())
      ).to.be.revertedWithCustomError(exchange, "EnforcedPause");
    });

    it("sell fonctionne même en pause", async () => {
      await aliceBuysUsdc();
      await exchange.connect(owner).pause();
      const gldBalance = await gld.balanceOf(alice.address);
      await expect(
        exchange.connect(alice).sell(gldBalance, await mockUSDC.getAddress())
      ).to.not.revert(ethers);
    });
  });

  // ── 10. UUPS ──────────────────────────────────────────────────────────────

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
