import { expect } from "chai";
import hre from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";

// ─── Constantes ──────────────────────────────────────────────────────────────

// Codes pays ISO-3166
const FRANCE      = 250;
const ALLEMAGNE   = 276;
const PORTUGAL    = 620;
const JAPON       = 392;  // non autorisé par défaut dans les tests
const INCONNU     = 0;

// Identités KYC fictives (bytes32)
const ID_ALICE  = "0x" + "a1".repeat(32);
const ID_BOB    = "0x" + "b0".repeat(32);
const ID_CAROL  = "0x" + "ca".repeat(32);

const ONE_GLD   = 1_000n;   // 1 GLD = 1000 unités (decimals=3)
const TEN_GLD   = 10_000n;

// ─── Suite principale ─────────────────────────────────────────────────────────

describe("ERC-3643 Conformité MiCA — IdentityRegistry + CountryComplianceModule + GLD V2", () => {
  let gld:        any;
  let registry:   any;
  let module_:    any;   // CountryComplianceModule (évite conflit avec mot-clé)
  let owner:      HardhatEthersSigner;
  let alice:      HardhatEthersSigner;  // France, KYC OK
  let bob:        HardhatEthersSigner;  // Allemagne, KYC OK
  let carol:      HardhatEthersSigner;  // Japon, pays non autorisé
  let dave:       HardhatEthersSigner;  // Aucune identité KYC
  let exchange:   HardhatEthersSigner;  // Simule Exchange (agent)
  let ethers:     any;

  // ─── beforeEach : déploiement complet ────────────────────────────────────

  beforeEach(async () => {
    const connection = await hre.network.connect();
    ethers = (connection as any).ethers;

    [owner, alice, bob, carol, dave, exchange] = await ethers.getSigners();

    const ProxyFactory = await ethers.getContractFactory("InvestOrProxy");

    // ── GLD V2 ───────────────────────────────────────────────────────────────
    const gldImpl  = await (await ethers.getContractFactory("GLD")).deploy();
    const gldProxy = await ProxyFactory.deploy(
      await gldImpl.getAddress(),
      gldImpl.interface.encodeFunctionData("initialize", [owner.address])
    );
    gld = await ethers.getContractAt("GLD", await gldProxy.getAddress());
    await gld.setMinter(owner.address); // owner = minter pour les tests directs

    // ── IdentityRegistry ─────────────────────────────────────────────────────
    const regImpl  = await (await ethers.getContractFactory("IdentityRegistry")).deploy();
    const regProxy = await ProxyFactory.deploy(
      await regImpl.getAddress(),
      regImpl.interface.encodeFunctionData("initialize", [owner.address])
    );
    registry = await ethers.getContractAt("IdentityRegistry", await regProxy.getAddress());

    // ── CountryComplianceModule (strictMode = false au départ) ────────────────
    const modImpl  = await (await ethers.getContractFactory("CountryComplianceModule")).deploy();
    const modProxy = await ProxyFactory.deploy(
      await modImpl.getAddress(),
      modImpl.interface.encodeFunctionData("initialize", [
        owner.address,
        await regProxy.getAddress(),
        false,   // strictMode = false → mode permissif
      ])
    );
    module_ = await ethers.getContractAt("CountryComplianceModule", await modProxy.getAddress());

    // ── Configuration : pays autorisés ────────────────────────────────────────
    await module_.connect(owner).allowCountries([FRANCE, ALLEMAGNE, PORTUGAL]);

    // ── Configuration : Exchange comme agent ──────────────────────────────────
    await module_.connect(owner).addAgent(exchange.address);

    // ── Identités KYC ────────────────────────────────────────────────────────
    await registry.connect(owner).registerIdentity(alice.address, ID_ALICE, FRANCE);
    await registry.connect(owner).registerIdentity(bob.address,   ID_BOB,   ALLEMAGNE);
    await registry.connect(owner).registerIdentity(carol.address, ID_CAROL, JAPON);
    // dave : aucune identité enregistrée

    // ── Brancher le module sur GLD ────────────────────────────────────────────
    await gld.connect(owner).setComplianceModule(await modProxy.getAddress());
  });

  // ── 1. IdentityRegistry — initialisation ─────────────────────────────────

  describe("IdentityRegistry — Initialisation", () => {
    it("doit avoir le bon owner", async () => {
      expect(await registry.owner()).to.equal(owner.address);
    });

    it("totalRegistered = 3 après setup", async () => {
      expect(await registry.totalRegistered()).to.equal(3n);
    });

    it("alice est vérifiée avec le bon pays", async () => {
      expect(await registry.isVerified(alice.address)).to.be.true;
      expect(await registry.getCountry(alice.address)).to.equal(FRANCE);
    });

    it("dave n'est pas vérifiée", async () => {
      expect(await registry.isVerified(dave.address)).to.be.false;
      expect(await registry.getCountry(dave.address)).to.equal(0);
    });

    it("getIdentity retourne les bonnes données pour alice", async () => {
      const id = await registry.getIdentity(alice.address);
      expect(id.identityId).to.equal(ID_ALICE);
      expect(id.country).to.equal(FRANCE);
      expect(id.verified).to.be.true;
    });
  });

  // ── 2. IdentityRegistry — enregistrement ─────────────────────────────────

  describe("IdentityRegistry — Enregistrement", () => {
    it("owner peut enregistrer une nouvelle identité", async () => {
      await registry.registerIdentity(dave.address, "0x" + "dd".repeat(32), PORTUGAL);
      expect(await registry.isVerified(dave.address)).to.be.true;
      expect(await registry.getCountry(dave.address)).to.equal(PORTUGAL);
    });

    it("registerIdentity émet IdentityRegistered", async () => {
      await expect(registry.registerIdentity(dave.address, "0x" + "dd".repeat(32), PORTUGAL))
        .to.emit(registry, "IdentityRegistered")
        .withArgs(dave.address, "0x" + "dd".repeat(32), PORTUGAL, await ethers.provider.getBlock("latest").then((b: any) => b!.timestamp + 1));
    });

    it("agent autorisé peut enregistrer une identité", async () => {
      await registry.addAgent(alice.address);
      await registry.connect(alice).registerIdentity(dave.address, "0x" + "dd".repeat(32), PORTUGAL);
      expect(await registry.isVerified(dave.address)).to.be.true;
    });

    it("non-agent ne peut pas enregistrer", async () => {
      await expect(
        registry.connect(bob).registerIdentity(dave.address, "0x" + "dd".repeat(32), PORTUGAL)
      ).to.be.revertedWithCustomError(registry, "NotAuthorized");
    });

    it("registerIdentity échoue avec wallet address(0)", async () => {
      await expect(
        registry.registerIdentity(ethers.ZeroAddress, "0x" + "dd".repeat(32), PORTUGAL)
      ).to.be.revertedWithCustomError(registry, "ZeroAddress");
    });

    it("registerIdentity échoue avec pays = 0", async () => {
      await expect(
        registry.registerIdentity(dave.address, "0x" + "dd".repeat(32), 0)
      ).to.be.revertedWithCustomError(registry, "InvalidCountry");
    });

    it("registerBatch enregistre plusieurs wallets en une tx", async () => {
      const wallets = [dave.address];
      const ids     = ["0x" + "dd".repeat(32)];
      const countries = [PORTUGAL];
      await registry.registerBatch(wallets, ids, countries);
      expect(await registry.isVerified(dave.address)).to.be.true;
    });

    it("revokeIdentity désactive un wallet KYC", async () => {
      await registry.revokeIdentity(alice.address);
      expect(await registry.isVerified(alice.address)).to.be.false;
    });

    it("revokeIdentity émet IdentityRevoked", async () => {
      await expect(registry.revokeIdentity(alice.address))
        .to.emit(registry, "IdentityRevoked");
    });

    it("revokeIdentity échoue si wallet non enregistré", async () => {
      await expect(
        registry.revokeIdentity(dave.address)
      ).to.be.revertedWithCustomError(registry, "IdentityNotFound");
    });

    it("updateCountry met à jour le pays", async () => {
      await registry.updateCountry(alice.address, PORTUGAL);
      expect(await registry.getCountry(alice.address)).to.equal(PORTUGAL);
    });

    it("getRegisteredWallets paginé retourne les bons wallets", async () => {
      const wallets = await registry.getRegisteredWallets(0, 10);
      expect(wallets).to.include(alice.address);
      expect(wallets).to.include(bob.address);
    });
  });

  // ── 3. CountryComplianceModule — configuration ───────────────────────────

  describe("CountryComplianceModule — Configuration", () => {
    it("doit avoir le bon owner", async () => {
      expect(await module_.owner()).to.equal(owner.address);
    });

    it("France, Allemagne, Portugal sont autorisés", async () => {
      expect(await module_.allowedCountries(FRANCE)).to.be.true;
      expect(await module_.allowedCountries(ALLEMAGNE)).to.be.true;
      expect(await module_.allowedCountries(PORTUGAL)).to.be.true;
    });

    it("Japon n'est pas autorisé", async () => {
      expect(await module_.allowedCountries(JAPON)).to.be.false;
    });

    it("Exchange est agent", async () => {
      expect(await module_.isAgent(exchange.address)).to.be.true;
    });

    it("alice n'est pas agent", async () => {
      expect(await module_.isAgent(alice.address)).to.be.false;
    });

    it("strictMode = false au départ", async () => {
      const status = await module_.getModuleStatus();
      expect(status.strict).to.be.false;
    });

    it("getAllowedCountries retourne les 3 pays", async () => {
      const countries = await module_.getAllowedCountries();
      expect(countries.length).to.equal(3);
    });

    it("allowCountry ajoute un pays", async () => {
      await module_.allowCountry(JAPON);
      expect(await module_.allowedCountries(JAPON)).to.be.true;
    });

    it("allowCountry émet CountryAllowed", async () => {
      await expect(module_.allowCountry(JAPON))
        .to.emit(module_, "CountryAllowed")
        .withArgs(JAPON);
    });

    it("disallowCountry retire un pays", async () => {
      await module_.disallowCountry(FRANCE);
      expect(await module_.allowedCountries(FRANCE)).to.be.false;
    });

    it("disallowCountry émet CountryDisallowed", async () => {
      await expect(module_.disallowCountry(FRANCE))
        .to.emit(module_, "CountryDisallowed")
        .withArgs(FRANCE);
    });

    it("non-owner ne peut pas allowCountry", async () => {
      await expect(
        module_.connect(alice).allowCountry(JAPON)
      ).to.be.revertedWithCustomError(module_, "OwnableUnauthorizedAccount");
    });

    it("addAgent ajoute un agent", async () => {
      await module_.addAgent(alice.address);
      expect(await module_.isAgent(alice.address)).to.be.true;
    });

    it("addAgent émet AgentAdded", async () => {
      await expect(module_.addAgent(dave.address))
        .to.emit(module_, "AgentAdded")
        .withArgs(dave.address);
    });

    it("removeAgent retire un agent", async () => {
      await module_.removeAgent(exchange.address);
      expect(await module_.isAgent(exchange.address)).to.be.false;
    });

    it("setStrictMode active le mode strict", async () => {
      await module_.setStrictMode(true);
      const status = await module_.getModuleStatus();
      expect(status.strict).to.be.true;
    });
  });

  // ── 4. canTransfer — mode permissif (strictMode = false) ─────────────────

  describe("canTransfer — mode permissif", () => {
    it("tout transfert est autorisé en mode permissif", async () => {
      expect(await module_.canTransfer(alice.address, bob.address, ONE_GLD)).to.be.true;
    });

    it("dave (non KYC) peut transférer en mode permissif", async () => {
      expect(await module_.canTransfer(dave.address, alice.address, ONE_GLD)).to.be.true;
    });

    it("carol (pays non autorisé) peut transférer en mode permissif", async () => {
      expect(await module_.canTransfer(carol.address, alice.address, ONE_GLD)).to.be.true;
    });

    it("Exchange (agent) toujours autorisé", async () => {
      expect(await module_.canTransfer(exchange.address, alice.address, ONE_GLD)).to.be.true;
      expect(await module_.canTransfer(alice.address, exchange.address, ONE_GLD)).to.be.true;
    });
  });

  // ── 5. canTransfer — mode strict ─────────────────────────────────────────

  describe("canTransfer — mode strict", () => {
    beforeEach(async () => {
      await module_.connect(owner).setStrictMode(true);
    });

    it("alice→bob autorisé (tous deux KYC + pays OK)", async () => {
      expect(await module_.canTransfer(alice.address, bob.address, ONE_GLD)).to.be.true;
    });

    it("dave→alice bloqué (dave non KYC)", async () => {
      expect(await module_.canTransfer(dave.address, alice.address, ONE_GLD)).to.be.false;
    });

    it("alice→dave bloqué (dave non KYC)", async () => {
      expect(await module_.canTransfer(alice.address, dave.address, ONE_GLD)).to.be.false;
    });

    it("carol→alice bloqué (carol : pays Japon non autorisé)", async () => {
      expect(await module_.canTransfer(carol.address, alice.address, ONE_GLD)).to.be.false;
    });

    it("alice→carol bloqué (carol : pays Japon non autorisé)", async () => {
      expect(await module_.canTransfer(alice.address, carol.address, ONE_GLD)).to.be.false;
    });

    it("Exchange (agent) toujours autorisé même en strict", async () => {
      expect(await module_.canTransfer(exchange.address, dave.address, ONE_GLD)).to.be.true;
      expect(await module_.canTransfer(dave.address, exchange.address, ONE_GLD)).to.be.true;
    });

    it("mint (from=0) : vérifie seulement to — alice OK", async () => {
      expect(await module_.canTransfer(ethers.ZeroAddress, alice.address, ONE_GLD)).to.be.true;
    });

    it("mint (from=0) : vérifie seulement to — dave KO", async () => {
      expect(await module_.canTransfer(ethers.ZeroAddress, dave.address, ONE_GLD)).to.be.false;
    });

    it("burn (to=0) : vérifie seulement from — alice OK", async () => {
      expect(await module_.canTransfer(alice.address, ethers.ZeroAddress, ONE_GLD)).to.be.true;
    });

    it("burn (to=0) : vérifie seulement from — dave KO", async () => {
      expect(await module_.canTransfer(dave.address, ethers.ZeroAddress, ONE_GLD)).to.be.false;
    });

    it("carol autorisée si Japon ajouté à la whitelist", async () => {
      await module_.allowCountry(JAPON);
      expect(await module_.canTransfer(carol.address, alice.address, ONE_GLD)).to.be.true;
    });

    it("alice bloquée si France retiré de la whitelist", async () => {
      await module_.disallowCountry(FRANCE);
      expect(await module_.canTransfer(alice.address, bob.address, ONE_GLD)).to.be.false;
    });

    it("alice autorisée si KYC révoqué → bloquée", async () => {
      await registry.revokeIdentity(alice.address);
      expect(await module_.canTransfer(alice.address, bob.address, ONE_GLD)).to.be.false;
    });
  });

  // ── 6. GLD V2 — module désactivé (mode V1) ───────────────────────────────

  describe("GLD V2 — module désactivé (comportement V1)", () => {
    beforeEach(async () => {
      // Désactiver le module → mode V1
      await gld.connect(owner).setComplianceModule(ethers.ZeroAddress);
    });

    it("complianceModule = address(0)", async () => {
      expect(await gld.complianceModule()).to.equal(ethers.ZeroAddress);
    });

    it("transfert libre sans module", async () => {
      await gld.mint(alice.address, TEN_GLD);
      await gld.connect(alice).transfer(dave.address, ONE_GLD);
      expect(await gld.balanceOf(dave.address)).to.equal(ONE_GLD);
    });

    it("checkCompliance retourne true si module absent", async () => {
      expect(
        await gld.checkCompliance(alice.address, dave.address, ONE_GLD)
      ).to.be.true;
    });
  });

  // ── 7. GLD V2 — module actif, mode permissif ─────────────────────────────

  describe("GLD V2 — module actif, mode permissif", () => {
    it("mint vers alice autorisé", async () => {
      await gld.mint(alice.address, TEN_GLD);
      expect(await gld.balanceOf(alice.address)).to.equal(TEN_GLD);
    });

    it("mint vers dave autorisé (mode permissif)", async () => {
      await gld.mint(dave.address, TEN_GLD);
      expect(await gld.balanceOf(dave.address)).to.equal(TEN_GLD);
    });

    it("transfert alice→dave autorisé (mode permissif)", async () => {
      await gld.mint(alice.address, TEN_GLD);
      await gld.connect(alice).transfer(dave.address, ONE_GLD);
      expect(await gld.balanceOf(dave.address)).to.equal(ONE_GLD);
    });

    it("setComplianceModule émet ComplianceModuleUpdated", async () => {
      await expect(gld.connect(owner).setComplianceModule(ethers.ZeroAddress))
        .to.emit(gld, "ComplianceModuleUpdated");
    });

    it("non-owner ne peut pas setComplianceModule", async () => {
      await expect(
        gld.connect(alice).setComplianceModule(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(gld, "OwnableUnauthorizedAccount");
    });
  });

  // ── 8. GLD V2 — module actif, mode strict ────────────────────────────────

  describe("GLD V2 — module actif, mode strict", () => {
    beforeEach(async () => {
      await module_.connect(owner).setStrictMode(true);
      // Mint initial pour les tests de transfert
      // Owner = minter, Exchange = agent → mint toujours autorisé
      await gld.mint(alice.address, TEN_GLD);
      await gld.mint(bob.address,   TEN_GLD);
    });

    it("transfert alice→bob autorisé (tous deux conformes)", async () => {
      await gld.connect(alice).transfer(bob.address, ONE_GLD);
      expect(await gld.balanceOf(bob.address)).to.equal(TEN_GLD + ONE_GLD);
    });

    it("transfert alice→dave revert TransferNotCompliant", async () => {
      await expect(
        gld.connect(alice).transfer(dave.address, ONE_GLD)
      ).to.be.revertedWithCustomError(gld, "TransferNotCompliant");
    });

    it("transfert alice→carol revert (Japon non autorisé)", async () => {
      await gld.mint(carol.address, TEN_GLD); // mint passe (owner=agent implicite via minter)
      await expect(
        gld.connect(alice).transfer(carol.address, ONE_GLD)
      ).to.be.revertedWithCustomError(gld, "TransferNotCompliant");
    });

    it("TransferBlockedByCompliance est émis lors d'un blocage", async () => {
      await expect(gld.connect(alice).transfer(dave.address, ONE_GLD))
        .to.emit(gld, "TransferBlockedByCompliance")
        .withArgs(alice.address, dave.address, ONE_GLD);
    });

    it("burn par owner (minter) toujours autorisé", async () => {
      await gld.burn(alice.address, ONE_GLD);
      expect(await gld.balanceOf(alice.address)).to.equal(TEN_GLD - ONE_GLD);
    });

    it("alice autorisée après KYC révoqué → bloquée", async () => {
      await registry.revokeIdentity(alice.address);
      await expect(
        gld.connect(alice).transfer(bob.address, ONE_GLD)
      ).to.be.revertedWithCustomError(gld, "TransferNotCompliant");
    });

    it("alice autorisée après ajout Japon → carol débloquée", async () => {
      await module_.allowCountry(JAPON);
      await gld.mint(carol.address, TEN_GLD);
      await gld.connect(alice).transfer(carol.address, ONE_GLD);
      expect(await gld.balanceOf(carol.address)).to.equal(TEN_GLD + ONE_GLD);
    });

    it("checkCompliance retourne false pour transfert non conforme", async () => {
      expect(
        await gld.checkCompliance(alice.address, dave.address, ONE_GLD)
      ).to.be.false;
    });

    it("checkCompliance retourne true pour transfert conforme", async () => {
      expect(
        await gld.checkCompliance(alice.address, bob.address, ONE_GLD)
      ).to.be.true;
    });
  });

  // ── 9. GLD V2 — Exchange comme agent (mint/burn exemptés) ─────────────────

  describe("GLD V2 — Exchange agent (mint/burn exemptés en mode strict)", () => {
    beforeEach(async () => {
      await module_.connect(owner).setStrictMode(true);
      // Exchange comme minter
      await gld.connect(owner).setMinter(exchange.address);
    });

    it("Exchange peut mint vers dave (non KYC) — agent exempté", async () => {
      await gld.connect(exchange).mint(dave.address, TEN_GLD);
      expect(await gld.balanceOf(dave.address)).to.equal(TEN_GLD);
    });

    it("Exchange peut mint vers carol (pays non autorisé) — agent exempté", async () => {
      await gld.connect(exchange).mint(carol.address, TEN_GLD);
      expect(await gld.balanceOf(carol.address)).to.equal(TEN_GLD);
    });

    it("Exchange peut burn depuis dave — agent exempté", async () => {
      await gld.connect(exchange).mint(dave.address, TEN_GLD);
      await gld.connect(exchange).burn(dave.address, ONE_GLD);
      expect(await gld.balanceOf(dave.address)).to.equal(TEN_GLD - ONE_GLD);
    });

    it("non-Exchange ne peut pas mint (UnauthorizedMinter)", async () => {
      await expect(
        gld.connect(alice).mint(alice.address, ONE_GLD)
      ).to.be.revertedWithCustomError(gld, "UnauthorizedMinter");
    });
  });

  // ── 10. GLD V2 — Blacklist reste active avec le module ───────────────────

  describe("GLD V2 — Blacklist coexiste avec le module de conformité", () => {
    beforeEach(async () => {
      await gld.mint(alice.address, TEN_GLD);
      await gld.mint(bob.address,   TEN_GLD);
    });

    it("blacklist bloque avant la vérification de conformité", async () => {
      await gld.blacklist(alice.address);
      await expect(
        gld.connect(alice).transfer(bob.address, ONE_GLD)
      ).to.be.revertedWithCustomError(gld, "AccountBlacklisted");
    });

    it("unblacklist restaure les transferts", async () => {
      await gld.blacklist(alice.address);
      await gld.unblacklist(alice.address);
      await gld.connect(alice).transfer(bob.address, ONE_GLD);
      expect(await gld.balanceOf(bob.address)).to.equal(TEN_GLD + ONE_GLD);
    });
  });

  // ── 11. UUPS — IdentityRegistry + CountryComplianceModule ────────────────

  describe("Upgradeability UUPS", () => {
    it("owner peut upgrader IdentityRegistry", async () => {
      const newImpl = await (await ethers.getContractFactory("IdentityRegistry")).deploy();
      await expect(registry.upgradeToAndCall(await newImpl.getAddress(), "0x"))
        .to.not.be.reverted;
    });

    it("non-owner ne peut pas upgrader IdentityRegistry", async () => {
      const newImpl = await (await ethers.getContractFactory("IdentityRegistry")).deploy();
      await expect(registry.connect(alice).upgradeToAndCall(await newImpl.getAddress(), "0x"))
        .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount");
    });

    it("owner peut upgrader CountryComplianceModule", async () => {
      const newImpl = await (await ethers.getContractFactory("CountryComplianceModule")).deploy();
      await expect(module_.upgradeToAndCall(await newImpl.getAddress(), "0x"))
        .to.not.be.reverted;
    });

    it("owner peut upgrader GLD V2", async () => {
      const newImpl = await (await ethers.getContractFactory("GLD")).deploy();
      await expect(gld.upgradeToAndCall(await newImpl.getAddress(), "0x"))
        .to.not.be.reverted;
    });
  });
});
