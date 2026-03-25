import { expect } from "chai";
import hre from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";

import GLDModule from "../ignition/modules/GLD.js";

// ─── Constantes ──────────────────────────────────────────────────────────────

const DECIMALS = 3n;
const ONE_GRAM = 10n ** DECIMALS;
const ONE_MILLIGRAM = 1n;
const HUNDRED_GRAMS = 100n * ONE_GRAM;

// ─── Suite principale ─────────────────────────────────────────────────────────

describe("GLD — Étape 1 : ERC-20 upgradeable", () => {
  let gld: any;
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let charlie: HardhatEthersSigner;
  let ethers: any;
  let ignition: any;

  beforeEach(async () => {
    // Dans Hardhat 3, ethers et ignition sont sur la connexion retournée par connect()
    const connection = await hre.network.connect();
    ethers = (connection as any).ethers;
    ignition = (connection as any).ignition;

    [owner, alice, bob, charlie] = await ethers.getSigners();

    const { proxy } = await ignition.deploy(GLDModule, {
      parameters: {
        GLDModule: { initialOwner: owner.address },
      },
    });

    gld = await ethers.getContractAt("GLD", await proxy.getAddress());
  });

  // ── 1. Initialisation ──────────────────────────────────────────────────────

  describe("Initialisation", () => {
    it("doit avoir le bon nom et symbole", async () => {
      expect(await gld.name()).to.equal("Gold Token");
      expect(await gld.symbol()).to.equal("GLD");
    });

    it("doit retourner decimals = 3", async () => {
      expect(await gld.decimals()).to.equal(3);
    });

    it("doit avoir une supply initiale de 0", async () => {
      expect(await gld.totalSupply()).to.equal(0n);
    });

    it("doit définir le bon owner", async () => {
      expect(await gld.owner()).to.equal(owner.address);
    });

    it("ne doit pas pouvoir être initialisé une seconde fois", async () => {
      await expect(
        gld.initialize(alice.address)
      ).to.be.revertedWithCustomError(gld, "InvalidInitialization");
    });
  });

  // ── 2. Mint ───────────────────────────────────────────────────────────────

  describe("Mint", () => {
    it("le owner peut minter des tokens", async () => {
      await gld.mint(alice.address, HUNDRED_GRAMS);
      expect(await gld.balanceOf(alice.address)).to.equal(HUNDRED_GRAMS);
      expect(await gld.totalSupply()).to.equal(HUNDRED_GRAMS);
    });

    it("peut minter l'unité minimale (1 mg)", async () => {
      await gld.mint(alice.address, ONE_MILLIGRAM);
      expect(await gld.balanceOf(alice.address)).to.equal(1n);
    });

    it("un non-owner ne peut pas minter", async () => {
      await expect(
        gld.connect(alice).mint(bob.address, ONE_GRAM)
      ).to.be.revertedWithCustomError(gld, "OwnableUnauthorizedAccount");
    });

    it("ne peut pas minter vers address(0)", async () => {
      await expect(
        gld.mint(ethers.ZeroAddress, ONE_GRAM)
      ).to.be.revertedWithCustomError(gld, "ZeroAddress");
    });

    it("ne peut pas minter un montant nul", async () => {
      await expect(
        gld.mint(alice.address, 0n)
      ).to.be.revertedWithCustomError(gld, "ZeroAmount");
    });

    it("ne peut pas minter vers une adresse blacklistée", async () => {
      await gld.blacklist(alice.address);
      await expect(
        gld.mint(alice.address, ONE_GRAM)
      ).to.be.revertedWithCustomError(gld, "AccountBlacklisted");
    });
  });

  // ── 3. Burn ───────────────────────────────────────────────────────────────

  describe("Burn", () => {
    beforeEach(async () => {
      await gld.mint(alice.address, HUNDRED_GRAMS);
    });

    it("le owner peut brûler des tokens", async () => {
      await gld.burn(alice.address, ONE_GRAM);
      expect(await gld.balanceOf(alice.address)).to.equal(HUNDRED_GRAMS - ONE_GRAM);
      expect(await gld.totalSupply()).to.equal(HUNDRED_GRAMS - ONE_GRAM);
    });

    it("un non-owner ne peut pas brûler", async () => {
      await expect(
        gld.connect(alice).burn(alice.address, ONE_GRAM)
      ).to.be.revertedWithCustomError(gld, "OwnableUnauthorizedAccount");
    });

    it("ne peut pas brûler plus que le solde", async () => {
      await expect(
        gld.burn(alice.address, HUNDRED_GRAMS + 1n)
      ).to.be.revertedWithCustomError(gld, "ERC20InsufficientBalance");
    });

    it("ne peut pas brûler un montant nul", async () => {
      await expect(
        gld.burn(alice.address, 0n)
      ).to.be.revertedWithCustomError(gld, "ZeroAmount");
    });
  });

  // ── 4. Pause ──────────────────────────────────────────────────────────────

  describe("Pause", () => {
    beforeEach(async () => {
      await gld.mint(alice.address, HUNDRED_GRAMS);
    });

    it("le owner peut mettre en pause", async () => {
      await gld.pause();
      expect(await gld.paused()).to.be.true;
    });

    it("les transferts sont bloqués en pause", async () => {
      await gld.pause();
      await expect(
        gld.connect(alice).transfer(bob.address, ONE_GRAM)
      ).to.be.revertedWithCustomError(gld, "EnforcedPause");
    });

    it("le mint est bloqué en pause", async () => {
      await gld.pause();
      await expect(
        gld.mint(bob.address, ONE_GRAM)
      ).to.be.revertedWithCustomError(gld, "EnforcedPause");
    });

    it("le owner peut reprendre après pause", async () => {
      await gld.pause();
      await gld.unpause();
      expect(await gld.paused()).to.be.false;
      await expect(
        gld.connect(alice).transfer(bob.address, ONE_GRAM)
      ).to.not.revert(ethers);
    });

    it("un non-owner ne peut pas mettre en pause", async () => {
      await expect(
        gld.connect(alice).pause()
      ).to.be.revertedWithCustomError(gld, "OwnableUnauthorizedAccount");
    });
  });

  // ── 5. Blacklist ──────────────────────────────────────────────────────────

  describe("Blacklist", () => {
    beforeEach(async () => {
      await gld.mint(alice.address, HUNDRED_GRAMS);
      await gld.mint(bob.address, HUNDRED_GRAMS);
    });

    it("le owner peut blacklister une adresse", async () => {
      await gld.blacklist(alice.address);
      expect(await gld.isBlacklisted(alice.address)).to.be.true;
    });

    it("une adresse blacklistée ne peut pas envoyer", async () => {
      await gld.blacklist(alice.address);
      await expect(
        gld.connect(alice).transfer(bob.address, ONE_GRAM)
      ).to.be.revertedWithCustomError(gld, "AccountBlacklisted");
    });

    it("une adresse blacklistée ne peut pas recevoir", async () => {
      await gld.blacklist(bob.address);
      await expect(
        gld.connect(alice).transfer(bob.address, ONE_GRAM)
      ).to.be.revertedWithCustomError(gld, "AccountBlacklisted");
    });

    it("le owner peut retirer de la blacklist", async () => {
      await gld.blacklist(alice.address);
      await gld.unblacklist(alice.address);
      expect(await gld.isBlacklisted(alice.address)).to.be.false;
      await expect(
        gld.connect(alice).transfer(bob.address, ONE_GRAM)
      ).to.not.revert(ethers);
    });

    it("emit l'event Blacklisted lors du blacklistage", async () => {
      await expect(gld.blacklist(alice.address))
        .to.emit(gld, "Blacklisted")
        .withArgs(alice.address);
    });

    it("emit l'event Unblacklisted lors du retrait", async () => {
      await gld.blacklist(alice.address);
      await expect(gld.unblacklist(alice.address))
        .to.emit(gld, "Unblacklisted")
        .withArgs(alice.address);
    });

    it("un non-owner ne peut pas blacklister", async () => {
      await expect(
        gld.connect(alice).blacklist(bob.address)
      ).to.be.revertedWithCustomError(gld, "OwnableUnauthorizedAccount");
    });
  });

  // ── 6. Transferts normaux ─────────────────────────────────────────────────

  describe("Transferts", () => {
    beforeEach(async () => {
      await gld.mint(alice.address, HUNDRED_GRAMS);
    });

    it("un transfer normal fonctionne", async () => {
      await gld.connect(alice).transfer(bob.address, ONE_GRAM);
      expect(await gld.balanceOf(alice.address)).to.equal(HUNDRED_GRAMS - ONE_GRAM);
      expect(await gld.balanceOf(bob.address)).to.equal(ONE_GRAM);
    });

    it("transferFrom avec allowance fonctionne", async () => {
      await gld.connect(alice).approve(bob.address, ONE_GRAM);
      await gld.connect(bob).transferFrom(alice.address, charlie.address, ONE_GRAM);
      expect(await gld.balanceOf(charlie.address)).to.equal(ONE_GRAM);
    });
  });

  // ── 7. UUPS Upgradeability ────────────────────────────────────────────────

  describe("Upgradeability (UUPS)", () => {
    it("le owner peut upgrader l'implémentation", async () => {
      const GLDFactory = await ethers.getContractFactory("GLD");
      const newImpl = await GLDFactory.deploy();
      await expect(
        gld.upgradeToAndCall(await newImpl.getAddress(), "0x")
      ).to.not.revert(ethers);
    });

    it("un non-owner ne peut pas upgrader", async () => {
      const GLDFactory = await ethers.getContractFactory("GLD");
      const newImpl = await GLDFactory.deploy();
      await expect(
        gld.connect(alice).upgradeToAndCall(await newImpl.getAddress(), "0x")
      ).to.be.revertedWithCustomError(gld, "OwnableUnauthorizedAccount");
    });
  });
});