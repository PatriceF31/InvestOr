import { expect } from "chai";
import hre from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";
import EventLoggerModule from "../ignition/modules/EventLogger.js";

// ─── ActionType enum (miroir du contrat) ─────────────────────────────────────
const ActionType = {
  DEPOSIT:    0n,
  WITHDRAWAL: 1n,
  BUY:        2n,
  SELL:       3n,
  MINT:       4n,
  BURN:       5n,
  BLACKLIST:  6n,
  EMERGENCY:  7n,
};

describe("EventLogger — Étape 6 : log centralisé", () => {
  let logger: any;
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let source: HardhatEthersSigner; // simule un contrat autorisé
  let ethers: any;
  let ignition: any;

  beforeEach(async () => {
    const connection = await hre.network.connect();
    ethers   = (connection as any).ethers;
    ignition = (connection as any).ignition;

    [owner, alice, bob, source] = await ethers.getSigners();

    const { proxy } = await ignition.deploy(EventLoggerModule, {
      parameters: { EventLoggerModule: { initialOwner: owner.address } },
    });
    logger = await ethers.getContractAt("EventLogger", await proxy.getAddress());

    // Autoriser "source" à écrire dans le log
    await logger.authorizeSource(source.address);
  });

  // ── 1. Initialisation ──────────────────────────────────────────────────────

  describe("Initialisation", () => {
    it("doit avoir le bon owner", async () => {
      expect(await logger.owner()).to.equal(owner.address);
    });

    it("totalEntries initial = 0", async () => {
      expect(await logger.totalEntries()).to.equal(0n);
    });

    it("source autorisée après authorizeSource", async () => {
      expect(await logger.authorizedSources(source.address)).to.be.true;
    });

    it("source non autorisée par défaut", async () => {
      expect(await logger.authorizedSources(alice.address)).to.be.false;
    });
  });

  // ── 2. Autorisation des sources ────────────────────────────────────────────

  describe("Gestion des sources", () => {
    it("owner peut autoriser une source", async () => {
      await logger.authorizeSource(alice.address);
      expect(await logger.authorizedSources(alice.address)).to.be.true;
    });

    it("owner peut révoquer une source", async () => {
      await logger.revokeSource(source.address);
      expect(await logger.authorizedSources(source.address)).to.be.false;
    });

    it("emit SourceAuthorized", async () => {
      await expect(logger.authorizeSource(alice.address))
        .to.emit(logger, "SourceAuthorized")
        .withArgs(alice.address);
    });

    it("emit SourceRevoked", async () => {
      await expect(logger.revokeSource(source.address))
        .to.emit(logger, "SourceRevoked")
        .withArgs(source.address);
    });

    it("un non-owner ne peut pas autoriser", async () => {
      await expect(
        logger.connect(alice).authorizeSource(bob.address)
      ).to.be.revertedWithCustomError(logger, "OwnableUnauthorizedAccount");
    });

    it("authorizeSource échoue avec address(0)", async () => {
      await expect(
        logger.authorizeSource(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(logger, "ZeroAddress");
    });
  });

  // ── 3. Écriture dans le log ────────────────────────────────────────────────

  describe("Écriture dans le log", () => {
    it("source autorisée peut écrire une entrée", async () => {
      await logger.connect(source).log(alice.address, ActionType.BUY, 100_000_000n, 90_00000000n);
      expect(await logger.totalEntries()).to.equal(1n);
    });

    it("source non autorisée ne peut pas écrire", async () => {
      await expect(
        logger.connect(alice).log(alice.address, ActionType.BUY, 100_000_000n, 0n)
      ).to.be.revertedWithCustomError(logger, "UnauthorizedSource");
    });

    it("source révoquée ne peut plus écrire", async () => {
      await logger.revokeSource(source.address);
      await expect(
        logger.connect(source).log(alice.address, ActionType.BUY, 100_000_000n, 0n)
      ).to.be.revertedWithCustomError(logger, "UnauthorizedSource");
    });

    it("emit ActionLogged avec les bons paramètres", async () => {
      await expect(
        logger.connect(source).log(alice.address, ActionType.BUY, 100_000_000n, 90_00000000n)
      )
        .to.emit(logger, "ActionLogged")
        .withArgs(0n, alice.address, ActionType.BUY, 100_000_000n, 90_00000000n, source.address, await ethers.provider.getBlock("latest").then((b: any) => BigInt(b.timestamp + 1)));
    });
  });

  // ── 4. Lecture du log ─────────────────────────────────────────────────────

  describe("Lecture du log", () => {
    beforeEach(async () => {
      // Alice : buy + sell
      await logger.connect(source).log(alice.address, ActionType.BUY,  100_000_000n, 90_00000000n);
      await logger.connect(source).log(alice.address, ActionType.SELL, 1111n,        90_00000000n);
      // Bob : deposit
      await logger.connect(source).log(bob.address,   ActionType.DEPOSIT, 50_000_000n, 0n);
    });

    it("getEntry retourne la bonne entrée", async () => {
      const entry = await logger.getEntry(0n);
      expect(entry.user).to.equal(alice.address);
      expect(entry.action).to.equal(ActionType.BUY);
      expect(entry.amount).to.equal(100_000_000n);
      expect(entry.price).to.equal(90_00000000n);
      expect(entry.source).to.equal(source.address);
    });

    it("totalEntries est correct", async () => {
      expect(await logger.totalEntries()).to.equal(3n);
    });

    it("getUserEntryIds retourne les bons ids pour alice", async () => {
      const ids = await logger.getUserEntryIds(alice.address);
      expect(ids.length).to.equal(2);
      expect(ids[0]).to.equal(0n);
      expect(ids[1]).to.equal(1n);
    });

    it("getUserEntryCount retourne le bon compte", async () => {
      expect(await logger.getUserEntryCount(alice.address)).to.equal(2n);
      expect(await logger.getUserEntryCount(bob.address)).to.equal(1n);
    });

    it("getRecentEntries retourne les N dernières entrées", async () => {
      const entries = await logger.getRecentEntries(2n);
      expect(entries.length).to.equal(2);
      expect(entries[0].action).to.equal(ActionType.SELL);
      expect(entries[1].action).to.equal(ActionType.DEPOSIT);
    });

    it("getRecentEntries avec count > total retourne tout", async () => {
      const entries = await logger.getRecentEntries(100n);
      expect(entries.length).to.equal(3);
    });

    it("getUserEntries paginées — offset 0 limit 1", async () => {
      const entries = await logger.getUserEntries(alice.address, 0n, 1n);
      expect(entries.length).to.equal(1);
      expect(entries[0].action).to.equal(ActionType.BUY);
    });

    it("getUserEntries paginées — offset 1 limit 10", async () => {
      const entries = await logger.getUserEntries(alice.address, 1n, 10n);
      expect(entries.length).to.equal(1);
      expect(entries[0].action).to.equal(ActionType.SELL);
    });

    it("getUserEntries avec offset >= total retourne tableau vide", async () => {
      const entries = await logger.getUserEntries(alice.address, 10n, 5n);
      expect(entries.length).to.equal(0);
    });

    it("getUserEntries pour adresse sans historique retourne tableau vide", async () => {
      const entries = await logger.getUserEntries(owner.address, 0n, 10n);
      expect(entries.length).to.equal(0);
    });
  });

  // ── 5. Tous les ActionTypes ────────────────────────────────────────────────

  describe("Tous les ActionTypes", () => {
    const cases = [
      { name: "DEPOSIT",    type: ActionType.DEPOSIT },
      { name: "WITHDRAWAL", type: ActionType.WITHDRAWAL },
      { name: "BUY",        type: ActionType.BUY },
      { name: "SELL",       type: ActionType.SELL },
      { name: "MINT",       type: ActionType.MINT },
      { name: "BURN",       type: ActionType.BURN },
      { name: "BLACKLIST",  type: ActionType.BLACKLIST },
      { name: "EMERGENCY",  type: ActionType.EMERGENCY },
    ];

    for (const c of cases) {
      it(`peut logger l'action ${c.name}`, async () => {
        await logger.connect(source).log(alice.address, c.type, 1000n, 0n);
        const entry = await logger.getEntry(0n);
        expect(entry.action).to.equal(c.type);
      });
    }
  });

  // ── 6. UUPS ───────────────────────────────────────────────────────────────

  describe("Upgradeability (UUPS)", () => {
    it("le owner peut upgrader", async () => {
      const Factory = await ethers.getContractFactory("EventLogger");
      const newImpl = await Factory.deploy();
      await expect(
        logger.upgradeToAndCall(await newImpl.getAddress(), "0x")
      ).to.not.revert(ethers);
    });

    it("un non-owner ne peut pas upgrader", async () => {
      const Factory = await ethers.getContractFactory("EventLogger");
      const newImpl = await Factory.deploy();
      await expect(
        logger.connect(alice).upgradeToAndCall(await newImpl.getAddress(), "0x")
      ).to.be.revertedWithCustomError(logger, "OwnableUnauthorizedAccount");
    });
  });
});
