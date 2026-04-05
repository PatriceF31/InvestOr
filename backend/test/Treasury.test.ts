import { expect } from "chai";
import hre from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";
import TreasuryModule from "../ignition/modules/Treasury.js";

// ─── Constantes ──────────────────────────────────────────────────────────────

const ONE_USDC        = 1_000_000n;        // 1 USDC  = 1 000 000 unités (6 décimales)
const HUNDRED_USDC    = 100n * ONE_USDC;   // 100 USDC
const THOUSAND_USDC   = 1000n * ONE_USDC;  // 1 000 USDC

// ─── Suite principale ─────────────────────────────────────────────────────────

describe("Treasury — Étape 3 : dépôt et retrait USDC", () => {
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

    // 1. Déployer MockUSDC
    const MockUSDCFactory = await ethers.getContractFactory("MockUSDC");
    mockUSDC = await MockUSDCFactory.deploy();

    // 2. Déployer Treasury via Ignition
    const { proxy } = await ignition.deploy(TreasuryModule, {
      parameters: {
        TreasuryModule: {
          initialOwner: owner.address,
          usdcAddress:  await mockUSDC.getAddress(),
        },
      },
    });
    treasury = await ethers.getContractAt("Treasury", await proxy.getAddress());

    // 3. Mint USDC pour owner, alice et bob
    await mockUSDC.mint(owner.address, THOUSAND_USDC);
    await mockUSDC.mint(alice.address, THOUSAND_USDC);
    await mockUSDC.mint(bob.address,   THOUSAND_USDC);
  });

  // ── 1. Initialisation ──────────────────────────────────────────────────────

  describe("Initialisation", () => {
    it("doit avoir la bonne adresse USDC", async () => {
      expect(await treasury.usdc()).to.equal(await mockUSDC.getAddress());
    });

    it("doit avoir le bon owner", async () => {
      expect(await treasury.owner()).to.equal(owner.address);
    });

    it("totalDeposited initial = 0", async () => {
      expect(await treasury.totalDeposited()).to.equal(0n);
    });

    it("ne doit pas pouvoir être initialisé une seconde fois", async () => {
      await expect(
        treasury.initialize(alice.address, await mockUSDC.getAddress())
      ).to.be.revertedWithCustomError(treasury, "InvalidInitialization");
    });
  });

  // ── 2. Dépôt ──────────────────────────────────────────────────────────────

  describe("Deposit", () => {
    it("le owner peut déposer des USDC (admin/collatéral)", async () => {
      await mockUSDC.connect(owner).approve(await treasury.getAddress(), HUNDRED_USDC);
      await treasury.connect(owner).deposit(HUNDRED_USDC);

      expect(await treasury.totalDeposited()).to.equal(HUNDRED_USDC);
    });

    it("le solde USDC du treasury augmente après dépôt", async () => {
      await mockUSDC.connect(owner).approve(await treasury.getAddress(), HUNDRED_USDC);
      await treasury.connect(owner).deposit(HUNDRED_USDC);

      expect(
        await mockUSDC.balanceOf(await treasury.getAddress())
      ).to.equal(HUNDRED_USDC);
    });

    it("un non-opérateur ne peut pas déposer", async () => {
      await mockUSDC.connect(alice).approve(await treasury.getAddress(), HUNDRED_USDC);
      await expect(
        treasury.connect(alice).deposit(HUNDRED_USDC)
      ).to.be.revertedWithCustomError(treasury, "UnauthorizedOperator");
    });

    it("un non-opérateur ne peut pas déposer (bob)", async () => {
      await mockUSDC.connect(bob).approve(await treasury.getAddress(), HUNDRED_USDC);
      await expect(
        treasury.connect(bob).deposit(HUNDRED_USDC)
      ).to.be.revertedWithCustomError(treasury, "UnauthorizedOperator");
    });

    it("dépôts cumulatifs par le owner", async () => {
      await mockUSDC.connect(owner).approve(await treasury.getAddress(), HUNDRED_USDC * 2n);
      await treasury.connect(owner).deposit(HUNDRED_USDC);
      await treasury.connect(owner).deposit(HUNDRED_USDC);

      expect(await treasury.totalDeposited()).to.equal(HUNDRED_USDC * 2n);
    });

    it("emit l'event Deposited", async () => {
      await mockUSDC.connect(owner).approve(await treasury.getAddress(), HUNDRED_USDC);
      await expect(treasury.connect(owner).deposit(HUNDRED_USDC))
        .to.emit(treasury, "Deposited")
        .withArgs(owner.address, HUNDRED_USDC);
    });

    it("ne peut pas déposer un montant nul", async () => {
      await expect(
        treasury.connect(owner).deposit(0n)
      ).to.be.revertedWithCustomError(treasury, "ZeroAmount");
    });

    it("échoue sans approbation USDC préalable", async () => {
      await expect(
        treasury.connect(alice).deposit(HUNDRED_USDC)
      ).to.revert(ethers);
    });

    it("échoue si allowance insuffisante", async () => {
      await mockUSDC.connect(alice).approve(await treasury.getAddress(), ONE_USDC);
      await expect(
        treasury.connect(alice).deposit(HUNDRED_USDC)
      ).to.revert(ethers);
    });
  });

  // ── 3. Retrait ────────────────────────────────────────────────────────────

describe("Withdraw", () => {
    beforeEach(async () => {
      await mockUSDC.connect(owner).approve(await treasury.getAddress(), HUNDRED_USDC);
      await treasury.connect(owner).deposit(HUNDRED_USDC);
    });

    it("le owner peut retirer des USDC", async () => {
      await treasury.connect(owner).withdraw(HUNDRED_USDC);
      expect(await treasury.totalDeposited()).to.equal(0n);
    });

    it("retrait partiel fonctionne", async () => {
      await treasury.connect(owner).withdraw(ONE_USDC);
      expect(await treasury.totalDeposited()).to.equal(HUNDRED_USDC - ONE_USDC);
    });

    it("emit l'event Withdrawn", async () => {
      await expect(treasury.connect(owner).withdraw(HUNDRED_USDC))
        .to.emit(treasury, "Withdrawn")
        .withArgs(owner.address, HUNDRED_USDC);
    });

    it("ne peut pas retirer un montant nul", async () => {
      await expect(
        treasury.connect(owner).withdraw(0n)
      ).to.be.revertedWithCustomError(treasury, "ZeroAmount");
    });

    it("ne peut pas retirer plus que le solde du treasury", async () => {
      await expect(
        treasury.connect(owner).withdraw(HUNDRED_USDC + ONE_USDC)
      ).to.be.revertedWithCustomError(treasury, "InsufficientBalance");
    });

    it("un non-opérateur ne peut pas retirer", async () => {
      await expect(
        treasury.connect(alice).withdraw(HUNDRED_USDC)
      ).to.be.revertedWithCustomError(treasury, "UnauthorizedOperator");
    });
  });

  // ── 4. Pause ──────────────────────────────────────────────────────────────

  describe("Pause", () => {
    it("le owner peut mettre en pause", async () => {
      await treasury.pause();
      expect(await treasury.paused()).to.be.true;
    });

    it("le dépôt est bloqué en pause", async () => {
      await treasury.pause();
      await mockUSDC.connect(alice).approve(await treasury.getAddress(), HUNDRED_USDC);
      await expect(
        treasury.connect(alice).deposit(HUNDRED_USDC)
      ).to.be.revertedWithCustomError(treasury, "EnforcedPause");
    });

    it("le retrait est bloqué en pause", async () => {
      await mockUSDC.connect(owner).approve(await treasury.getAddress(), HUNDRED_USDC);
      await treasury.connect(owner).deposit(HUNDRED_USDC);
      await treasury.pause();
      await expect(
        treasury.connect(alice).withdraw(HUNDRED_USDC)
      ).to.be.revertedWithCustomError(treasury, "EnforcedPause");
    });

    it("un non-owner ne peut pas mettre en pause", async () => {
      await expect(
        treasury.connect(alice).pause()
      ).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
    });

    it("le owner peut reprendre après pause", async () => {
      await treasury.pause();
      await treasury.unpause();
      expect(await treasury.paused()).to.be.false;
    });
  });

  // ── 5. Emergency Withdraw ─────────────────────────────────────────────────

  describe("EmergencyWithdraw", () => {
    beforeEach(async () => {
      await mockUSDC.connect(owner).approve(await treasury.getAddress(), HUNDRED_USDC);
      await treasury.connect(owner).deposit(HUNDRED_USDC);
    });

    it("le owner peut faire un emergency withdraw", async () => {
      const ownerBefore = await mockUSDC.balanceOf(owner.address);
      await treasury.emergencyWithdraw(owner.address);
      expect(await mockUSDC.balanceOf(owner.address)).to.equal(ownerBefore + HUNDRED_USDC);
    });

    it("emit l'event EmergencyWithdrawn", async () => {
      await expect(treasury.emergencyWithdraw(owner.address))
        .to.emit(treasury, "EmergencyWithdrawn")
        .withArgs(owner.address, HUNDRED_USDC);
    });

    it("un non-owner ne peut pas faire emergency withdraw", async () => {
      await expect(
        treasury.connect(alice).emergencyWithdraw(alice.address)
      ).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
    });

    it("échoue si le treasury est vide", async () => {
      await treasury.emergencyWithdraw(owner.address);
      await expect(
        treasury.emergencyWithdraw(owner.address)
      ).to.be.revertedWithCustomError(treasury, "ZeroAmount");
    });

    it("échoue vers address(0)", async () => {
      await expect(
        treasury.emergencyWithdraw(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(treasury, "ZeroAddress");
    });
  });

  // ── 6. SetUsdcAddress ─────────────────────────────────────────────────────

  describe("SetUsdcAddress", () => {
    it("le owner peut mettre à jour l'adresse USDC", async () => {
      const MockUSDCFactory = await ethers.getContractFactory("MockUSDC");
      const newUsdc = await MockUSDCFactory.deploy();
      await treasury.setUsdcAddress(await newUsdc.getAddress());
      expect(await treasury.usdc()).to.equal(await newUsdc.getAddress());
    });

    it("emit l'event UsdcAddressUpdated", async () => {
      const MockUSDCFactory = await ethers.getContractFactory("MockUSDC");
      const newUsdc = await MockUSDCFactory.deploy();
      await expect(treasury.setUsdcAddress(await newUsdc.getAddress()))
        .to.emit(treasury, "UsdcAddressUpdated")
        .withArgs(await mockUSDC.getAddress(), await newUsdc.getAddress());
    });

    it("un non-owner ne peut pas changer l'adresse USDC", async () => {
      await expect(
        treasury.connect(alice).setUsdcAddress(alice.address)
      ).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
    });

    it("échoue vers address(0)", async () => {
      await expect(
        treasury.setUsdcAddress(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(treasury, "ZeroAddress");
    });
  });


  // ── 6b. OperatorWithdraw ──────────────────────────────────────────────────

  describe("OperatorWithdraw", () => {
    beforeEach(async () => {
      await mockUSDC.connect(owner).approve(await treasury.getAddress(), HUNDRED_USDC);
      await treasury.connect(owner).deposit(HUNDRED_USDC);
      await treasury.setOperator(bob.address);
    });

    it("l'opérateur peut retirer depuis le pool global", async () => {
      const before = await mockUSDC.balanceOf(alice.address);
      await treasury.connect(bob).operatorWithdraw(alice.address, HUNDRED_USDC);
      expect(await mockUSDC.balanceOf(alice.address)).to.equal(before + HUNDRED_USDC);
    });

    it("emit l'event OperatorWithdrawn", async () => {
      await expect(treasury.connect(bob).operatorWithdraw(alice.address, HUNDRED_USDC))
        .to.emit(treasury, "OperatorWithdrawn")
        .withArgs(alice.address, HUNDRED_USDC);
    });

    it("le owner peut aussi appeler operatorWithdraw", async () => {
      await expect(
        treasury.connect(owner).operatorWithdraw(alice.address, HUNDRED_USDC)
      ).to.not.revert(ethers);
    });

    it("un non-opérateur ne peut pas appeler operatorWithdraw", async () => {
      await expect(
        treasury.connect(alice).operatorWithdraw(alice.address, ONE_USDC)
      ).to.be.revertedWithCustomError(treasury, "UnauthorizedOperator");
    });

    it("échoue si solde Treasury insuffisant", async () => {
      await expect(
        treasury.connect(bob).operatorWithdraw(alice.address, HUNDRED_USDC + 1n)
      ).to.be.revertedWithCustomError(treasury, "InsufficientBalance");
    });

    it("échoue vers address(0)", async () => {
      await expect(
        treasury.connect(bob).operatorWithdraw(ethers.ZeroAddress, ONE_USDC)
      ).to.be.revertedWithCustomError(treasury, "ZeroAddress");
    });

    it("setOperator émet l'event OperatorUpdated", async () => {
      await expect(treasury.setOperator(alice.address))
        .to.emit(treasury, "OperatorUpdated")
        .withArgs(bob.address, alice.address);
    });

    it("un non-owner ne peut pas changer l'opérateur", async () => {
      await expect(
        treasury.connect(alice).setOperator(alice.address)
      ).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
    });
  });

  // ── 7. UUPS Upgradeability ────────────────────────────────────────────────

  describe("Upgradeability (UUPS)", () => {
    it("le owner peut upgrader l'implémentation", async () => {
      const TreasuryFactory = await ethers.getContractFactory("Treasury");
      const newImpl = await TreasuryFactory.deploy();
      await expect(
        treasury.upgradeToAndCall(await newImpl.getAddress(), "0x")
      ).to.not.revert(ethers);
    });

    it("un non-owner ne peut pas upgrader", async () => {
      const TreasuryFactory = await ethers.getContractFactory("Treasury");
      const newImpl = await TreasuryFactory.deploy();
      await expect(
        treasury.connect(alice).upgradeToAndCall(await newImpl.getAddress(), "0x")
      ).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
    });
  });
});
