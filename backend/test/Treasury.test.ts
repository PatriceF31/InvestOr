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

// ─── Suite principale ─────────────────────────────────────────────────────────

describe("Treasury V2 — Multi-token USDC + EURC", () => {
  let treasury:  any;
  let mockUSDC:  any;
  let mockEURC:  any;
  let owner:     HardhatEthersSigner;
  let alice:     HardhatEthersSigner;
  let bob:       HardhatEthersSigner;
  let operator:  HardhatEthersSigner;
  let ethers:    any;

  beforeEach(async () => {
    const connection = await hre.network.connect();
    ethers = (connection as any).ethers;
    [owner, alice, bob, operator] = await ethers.getSigners();

    const ProxyFactory = await ethers.getContractFactory("InvestOrProxy");

    // Mock tokens
    mockUSDC = await (await ethers.getContractFactory("MockUSDC")).deploy();
    mockEURC = await (await ethers.getContractFactory("MockUSDC")).deploy(); // même contrat, nom différent

    // Treasury V2
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

    // Configurer opérateur
    await treasury.connect(owner).setOperator(operator.address);

    // Fonds pour les tests
    await mockUSDC.mint(operator.address, THOUSAND_USDC * 10n);
    await mockEURC.mint(operator.address, THOUSAND_EURC * 10n);
    await mockUSDC.connect(operator).approve(await treasury.getAddress(), THOUSAND_USDC * 10n);
    await mockEURC.connect(operator).approve(await treasury.getAddress(), THOUSAND_EURC * 10n);
  });

  // ── 1. Initialisation ──────────────────────────────────────────────────────

  describe("Initialisation", () => {
    it("doit avoir le bon owner", async () => {
      expect(await treasury.owner()).to.equal(owner.address);
    });

    it("USDC est supporté après initialize", async () => {
      expect(await treasury.isSupportedToken(await mockUSDC.getAddress())).to.be.true;
    });

    it("EURC est supporté après initialize", async () => {
      expect(await treasury.isSupportedToken(await mockEURC.getAddress())).to.be.true;
    });

    it("totalDeposited initial = 0", async () => {
      expect(await treasury.totalDeposited()).to.equal(0n);
    });

    it("totalDepositedAllTokens initial = 0", async () => {
      expect(await treasury.totalDepositedAllTokens()).to.equal(0n);
    });

    it("ne peut pas être initialisé une seconde fois", async () => {
      await expect(
        treasury.initialize(owner.address, await mockUSDC.getAddress(), ethers.ZeroAddress)
      ).to.revert(ethers);
    });
  });

  // ── 2. Dépôt USDC ─────────────────────────────────────────────────────────

  describe("Deposit — USDC", () => {
    it("opérateur peut déposer des USDC", async () => {
      await treasury.connect(operator).deposit(HUNDRED_USDC, await mockUSDC.getAddress());
      expect(await treasury.totalDepositedByToken(await mockUSDC.getAddress())).to.equal(HUNDRED_USDC);
    });

    it("totalDeposited agrège USDC", async () => {
      await treasury.connect(operator).deposit(HUNDRED_USDC, await mockUSDC.getAddress());
      expect(await treasury.totalDeposited()).to.equal(HUNDRED_USDC);
    });

    it("emit Deposited avec le bon token", async () => {
      await expect(treasury.connect(operator).deposit(HUNDRED_USDC, await mockUSDC.getAddress()))
        .to.emit(treasury, "Deposited")
        .withArgs(await mockUSDC.getAddress(), operator.address, HUNDRED_USDC);
    });

    it("échoue avec montant nul", async () => {
      await expect(
        treasury.connect(operator).deposit(0n, await mockUSDC.getAddress())
      ).to.be.revertedWithCustomError(treasury, "ZeroAmount");
    });

    it("non-opérateur ne peut pas déposer", async () => {
      await mockUSDC.mint(alice.address, HUNDRED_USDC);
      await mockUSDC.connect(alice).approve(await treasury.getAddress(), HUNDRED_USDC);
      await expect(
        treasury.connect(alice).deposit(HUNDRED_USDC, await mockUSDC.getAddress())
      ).to.be.revertedWithCustomError(treasury, "UnauthorizedOperator");
    });

    it("token non supporté revert UnsupportedToken", async () => {
      const rando = await (await ethers.getContractFactory("MockUSDC")).deploy();
      await mockUSDC.connect(operator).approve(await treasury.getAddress(), HUNDRED_USDC);
      await expect(
        treasury.connect(operator).deposit(HUNDRED_USDC, await rando.getAddress())
      ).to.be.revertedWithCustomError(treasury, "UnsupportedToken");
    });
  });

  // ── 3. Dépôt EURC ─────────────────────────────────────────────────────────

  describe("Deposit — EURC", () => {
    it("opérateur peut déposer des EURC", async () => {
      await treasury.connect(operator).deposit(HUNDRED_EURC, await mockEURC.getAddress());
      expect(await treasury.totalDepositedByToken(await mockEURC.getAddress())).to.equal(HUNDRED_EURC);
    });

    it("totalDeposited agrège USDC + EURC", async () => {
      await treasury.connect(operator).deposit(HUNDRED_USDC, await mockUSDC.getAddress());
      await treasury.connect(operator).deposit(HUNDRED_EURC, await mockEURC.getAddress());
      expect(await treasury.totalDeposited()).to.equal(HUNDRED_USDC + HUNDRED_EURC);
    });

    it("totalDepositedAllTokens = USDC + EURC", async () => {
      await treasury.connect(operator).deposit(HUNDRED_USDC, await mockUSDC.getAddress());
      await treasury.connect(operator).deposit(HUNDRED_EURC, await mockEURC.getAddress());
      expect(await treasury.totalDepositedAllTokens()).to.equal(HUNDRED_USDC + HUNDRED_EURC);
    });

    it("totalDepositedByToken USDC et EURC sont indépendants", async () => {
      await treasury.connect(operator).deposit(HUNDRED_USDC, await mockUSDC.getAddress());
      await treasury.connect(operator).deposit(HUNDRED_EURC * 2n, await mockEURC.getAddress());
      expect(await treasury.totalDepositedByToken(await mockUSDC.getAddress())).to.equal(HUNDRED_USDC);
      expect(await treasury.totalDepositedByToken(await mockEURC.getAddress())).to.equal(HUNDRED_EURC * 2n);
    });
  });

  // ── 4. operatorWithdraw ────────────────────────────────────────────────────

  describe("operatorWithdraw — USDC et EURC", () => {
    beforeEach(async () => {
      await treasury.connect(operator).deposit(THOUSAND_USDC, await mockUSDC.getAddress());
      await treasury.connect(operator).deposit(THOUSAND_EURC, await mockEURC.getAddress());
    });

    it("opérateur peut retirer USDC vers alice", async () => {
      const before = await mockUSDC.balanceOf(alice.address);
      await treasury.connect(operator).operatorWithdraw(alice.address, HUNDRED_USDC, await mockUSDC.getAddress());
      expect(await mockUSDC.balanceOf(alice.address)).to.equal(before + HUNDRED_USDC);
    });

    it("opérateur peut retirer EURC vers alice", async () => {
      const before = await mockEURC.balanceOf(alice.address);
      await treasury.connect(operator).operatorWithdraw(alice.address, HUNDRED_EURC, await mockEURC.getAddress());
      expect(await mockEURC.balanceOf(alice.address)).to.equal(before + HUNDRED_EURC);
    });

    it("totalDepositedByToken décroît après retrait USDC", async () => {
      await treasury.connect(operator).operatorWithdraw(alice.address, HUNDRED_USDC, await mockUSDC.getAddress());
      expect(await treasury.totalDepositedByToken(await mockUSDC.getAddress())).to.equal(THOUSAND_USDC - HUNDRED_USDC);
    });

    it("retrait EURC n'affecte pas le solde USDC", async () => {
      await treasury.connect(operator).operatorWithdraw(alice.address, HUNDRED_EURC, await mockEURC.getAddress());
      expect(await treasury.totalDepositedByToken(await mockUSDC.getAddress())).to.equal(THOUSAND_USDC);
    });

    it("emit OperatorWithdrawn avec le bon token", async () => {
      await expect(
        treasury.connect(operator).operatorWithdraw(alice.address, HUNDRED_USDC, await mockUSDC.getAddress())
      ).to.emit(treasury, "OperatorWithdrawn")
        .withArgs(await mockUSDC.getAddress(), alice.address, HUNDRED_USDC);
    });

    it("échoue si solde insuffisant USDC", async () => {
      await expect(
        treasury.connect(operator).operatorWithdraw(alice.address, THOUSAND_USDC * 2n, await mockUSDC.getAddress())
      ).to.be.revertedWithCustomError(treasury, "InsufficientBalance");
    });

    it("non-opérateur ne peut pas retirer", async () => {
      await expect(
        treasury.connect(alice).operatorWithdraw(alice.address, HUNDRED_USDC, await mockUSDC.getAddress())
      ).to.be.revertedWithCustomError(treasury, "UnauthorizedOperator");
    });
  });

  // ── 5. injectCapital ───────────────────────────────────────────────────────

  describe("injectCapital", () => {
    beforeEach(async () => {
      await mockUSDC.mint(owner.address, THOUSAND_USDC);
      await mockUSDC.connect(owner).approve(await treasury.getAddress(), THOUSAND_USDC);
      await mockEURC.mint(owner.address, THOUSAND_EURC);
      await mockEURC.connect(owner).approve(await treasury.getAddress(), THOUSAND_EURC);
    });

    it("owner peut injecter USDC", async () => {
      await treasury.connect(owner).injectCapital(HUNDRED_USDC, await mockUSDC.getAddress());
      expect(await treasury.totalDepositedByToken(await mockUSDC.getAddress())).to.equal(HUNDRED_USDC);
    });

    it("owner peut injecter EURC", async () => {
      await treasury.connect(owner).injectCapital(HUNDRED_EURC, await mockEURC.getAddress());
      expect(await treasury.totalDepositedByToken(await mockEURC.getAddress())).to.equal(HUNDRED_EURC);
    });

    it("non-autorisé ne peut pas injecter", async () => {
      await mockUSDC.mint(alice.address, HUNDRED_USDC);
      await mockUSDC.connect(alice).approve(await treasury.getAddress(), HUNDRED_USDC);
      await expect(
        treasury.connect(alice).injectCapital(HUNDRED_USDC, await mockUSDC.getAddress())
      ).to.be.revertedWithCustomError(treasury, "UnauthorizedOperator");
    });
  });

  // ── 6. Gestion des tokens supportés ───────────────────────────────────────

  describe("Gestion tokens supportés", () => {
    it("addSupportedToken ajoute un token", async () => {
      const newToken = await (await ethers.getContractFactory("MockUSDC")).deploy();
      await treasury.connect(owner).addSupportedToken(await newToken.getAddress());
      expect(await treasury.isSupportedToken(await newToken.getAddress())).to.be.true;
    });

    it("addSupportedToken émet TokenAdded", async () => {
      const newToken = await (await ethers.getContractFactory("MockUSDC")).deploy();
      await expect(treasury.connect(owner).addSupportedToken(await newToken.getAddress()))
        .to.emit(treasury, "TokenAdded")
        .withArgs(await newToken.getAddress());
    });

    it("removeSupportedToken retire un token", async () => {
      await treasury.connect(owner).removeSupportedToken(await mockEURC.getAddress());
      expect(await treasury.isSupportedToken(await mockEURC.getAddress())).to.be.false;
    });

    it("non-owner ne peut pas addSupportedToken", async () => {
      const newToken = await (await ethers.getContractFactory("MockUSDC")).deploy();
      await expect(
        treasury.connect(alice).addSupportedToken(await newToken.getAddress())
      ).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
    });

    it("setEurc configure l'adresse EURC et l'ajoute aux tokens supportés", async () => {
      const newEurc = await (await ethers.getContractFactory("MockUSDC")).deploy();
      await treasury.connect(owner).setEurc(await newEurc.getAddress());
      expect(await treasury.isSupportedToken(await newEurc.getAddress())).to.be.true;
    });
  });

  // ── 7. Pause ──────────────────────────────────────────────────────────────

  describe("Pause", () => {
    it("dépôt bloqué en pause", async () => {
      await treasury.connect(owner).pause();
      await expect(
        treasury.connect(operator).deposit(HUNDRED_USDC, await mockUSDC.getAddress())
      ).to.be.revertedWithCustomError(treasury, "EnforcedPause");
    });

    it("retrait bloqué en pause", async () => {
      await treasury.connect(operator).deposit(HUNDRED_USDC, await mockUSDC.getAddress());
      await treasury.connect(owner).pause();
      await expect(
        treasury.connect(operator).operatorWithdraw(alice.address, HUNDRED_USDC, await mockUSDC.getAddress())
      ).to.be.revertedWithCustomError(treasury, "EnforcedPause");
    });
  });

  // ── 8. emergencyWithdraw ──────────────────────────────────────────────────

  describe("emergencyWithdraw", () => {
    it("owner peut faire un emergency withdraw USDC", async () => {
      await treasury.connect(operator).deposit(HUNDRED_USDC, await mockUSDC.getAddress());
      const before = await mockUSDC.balanceOf(owner.address);
      await treasury.connect(owner).emergencyWithdraw(owner.address, await mockUSDC.getAddress());
      expect(await mockUSDC.balanceOf(owner.address)).to.equal(before + HUNDRED_USDC);
    });

    it("owner peut faire un emergency withdraw EURC", async () => {
      await treasury.connect(operator).deposit(HUNDRED_EURC, await mockEURC.getAddress());
      const before = await mockEURC.balanceOf(owner.address);
      await treasury.connect(owner).emergencyWithdraw(owner.address, await mockEURC.getAddress());
      expect(await mockEURC.balanceOf(owner.address)).to.equal(before + HUNDRED_EURC);
    });

    it("non-owner ne peut pas faire emergency withdraw", async () => {
      await expect(
        treasury.connect(alice).emergencyWithdraw(alice.address, await mockUSDC.getAddress())
      ).to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
    });
  });

  // ── 9. UUPS ───────────────────────────────────────────────────────────────

  describe("Upgradeability (UUPS)", () => {
    it("owner peut upgrader", async () => {
      const newImpl = await (await ethers.getContractFactory("contracts/Treasury.sol:Treasury")).deploy();
      await expect(treasury.upgradeToAndCall(await newImpl.getAddress(), "0x"))
        .to.not.revert(ethers);
    });

    it("non-owner ne peut pas upgrader", async () => {
      const newImpl = await (await ethers.getContractFactory("contracts/Treasury.sol:Treasury")).deploy();
      await expect(treasury.connect(alice).upgradeToAndCall(await newImpl.getAddress(), "0x"))
        .to.be.revertedWithCustomError(treasury, "OwnableUnauthorizedAccount");
    });
  });
});
