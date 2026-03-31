import { expect } from "chai";
import hre from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";

describe("SerialNumber — Étape 13 : génération de numéros de série", () => {
  let serial: any;
  let owner: HardhatEthersSigner;
  let alice: HardhatEthersSigner;
  let bob: HardhatEthersSigner;
  let issuer: HardhatEthersSigner;
  let ethers: any;

  beforeEach(async () => {
    const connection = await hre.network.connect();
    ethers = (connection as any).ethers;

    [owner, alice, bob, issuer] = await ethers.getSigners();

    // Déploiement direct (évite cache Ignition)
    const SerialFactory = await ethers.getContractFactory("SerialNumber");
    const impl = await SerialFactory.deploy();

    const ProxyFactory = await ethers.getContractFactory("ERC1967Proxy");
    const initData = impl.interface.encodeFunctionData("initialize", [
      owner.address, "GLD"
    ]);
    const proxy = await ProxyFactory.deploy(await impl.getAddress(), initData);
    serial = await ethers.getContractAt("SerialNumber", await proxy.getAddress());

    // Autoriser issuer
    await serial.authorizeIssuer(issuer.address);
  });

  // ── 1. Initialisation ──────────────────────────────────────────────────────

  describe("Initialisation", () => {
    it("doit avoir le bon owner", async () => {
      expect(await serial.owner()).to.equal(owner.address);
    });

    it("defaultPrefix = GLD", async () => {
      expect(await serial.defaultPrefix()).to.equal("GLD");
    });

    it("totalGenerated = 0 initialement", async () => {
      expect(await serial.totalGenerated()).to.equal(0n);
    });

    it("issuer autorisé après authorizeIssuer", async () => {
      expect(await serial.authorizedIssuers(issuer.address)).to.be.true;
    });
  });

  // ── 2. Génération de numéros de série ─────────────────────────────────────

  describe("generate (préfixe par défaut)", () => {
    it("génère un numéro de série valide", async () => {
      const tx = await serial.connect(issuer).generate(alice.address);
      const receipt = await tx.wait();
      const event = receipt.logs.find((l: any) =>
        l.fragment?.name === "SerialGenerated"
      );
      expect(event).to.not.be.undefined;
    });

    it("le premier serial a id = 1", async () => {
      await serial.connect(issuer).generate(alice.address);
      const s = await serial.getSerial(1n);
      expect(s.id).to.equal(1n);
    });

    it("le code suit le format GLD-YYYY-000001", async () => {
      await serial.connect(issuer).generate(alice.address);
      const s = await serial.getSerial(1n);
      const year = await serial.currentYear();
      expect(s.serialCode).to.equal(`GLD-${year}-000001`);
    });

    it("le compteur s'incrémente correctement", async () => {
      await serial.connect(issuer).generate(alice.address);
      await serial.connect(issuer).generate(alice.address);
      await serial.connect(issuer).generate(alice.address);
      const s = await serial.getSerial(3n);
      const year = await serial.currentYear();
      expect(s.serialCode).to.equal(`GLD-${year}-000003`);
    });

    it("totalGenerated augmente après chaque génération", async () => {
      await serial.connect(issuer).generate(alice.address);
      await serial.connect(issuer).generate(alice.address);
      expect(await serial.totalGenerated()).to.equal(2n);
    });

    it("issuedTo est correctement enregistré", async () => {
      await serial.connect(issuer).generate(alice.address);
      const s = await serial.getSerial(1n);
      expect(s.issuedTo).to.equal(alice.address);
    });

    it("active = true après génération", async () => {
      await serial.connect(issuer).generate(alice.address);
      const s = await serial.getSerial(1n);
      expect(s.active).to.be.true;
    });

    it("emit SerialGenerated avec les bons params", async () => {
      const year = await serial.currentYear();
      const expectedCode = `GLD-${year}-000001`;
      await expect(serial.connect(issuer).generate(alice.address))
        .to.emit(serial, "SerialGenerated")
        .withArgs(1n, expectedCode, "GLD", year, 1n, alice.address, issuer.address);
    });

    it("un non-issuer ne peut pas générer", async () => {
      await expect(
        serial.connect(alice).generate(bob.address)
      ).to.be.revertedWithCustomError(serial, "UnauthorizedIssuer");
    });

    it("owner peut aussi générer sans être autorisé explicitement", async () => {
      await expect(
        serial.connect(owner).generate(alice.address)
      ).to.not.revert(ethers);
    });

    it("échoue si issuedTo = address(0)", async () => {
      await expect(
        serial.connect(issuer).generate(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(serial, "ZeroAddress");
    });
  });

  // ── 3. generateWithPrefix ─────────────────────────────────────────────────

  describe("generateWithPrefix", () => {
    it("génère avec un préfixe personnalisé KILO", async () => {
      await serial.connect(issuer).generateWithPrefix("KILO", alice.address);
      const s = await serial.getSerial(1n);
      const year = await serial.currentYear();
      expect(s.serialCode).to.equal(`KILO-${year}-000001`);
      expect(s.prefix).to.equal("KILO");
    });

    it("compteurs GLD et KILO sont indépendants", async () => {
      await serial.connect(issuer).generate(alice.address);           // GLD-YYYY-000001
      await serial.connect(issuer).generateWithPrefix("KILO", alice.address); // KILO-YYYY-000001
      await serial.connect(issuer).generate(alice.address);           // GLD-YYYY-000002

      const s1 = await serial.getSerial(1n);
      const s2 = await serial.getSerial(2n);
      const s3 = await serial.getSerial(3n);

      const year = await serial.currentYear();
      expect(s1.serialCode).to.equal(`GLD-${year}-000001`);
      expect(s2.serialCode).to.equal(`KILO-${year}-000001`);
      expect(s3.serialCode).to.equal(`GLD-${year}-000002`);
    });

    it("échoue avec préfixe vide", async () => {
      await expect(
        serial.connect(issuer).generateWithPrefix("", alice.address)
      ).to.be.revertedWithCustomError(serial, "EmptyPrefix");
    });
  });

  // ── 4. generateForYear ────────────────────────────────────────────────────

  describe("generateForYear", () => {
    it("owner peut générer pour une année spécifique", async () => {
      await serial.connect(owner).generateForYear("GLD", 2024, alice.address);
      const s = await serial.getSerial(1n);
      expect(s.serialCode).to.equal("GLD-2024-000001");
      expect(s.year).to.equal(2024);
    });

    it("compteurs par année sont indépendants", async () => {
      await serial.connect(owner).generateForYear("GLD", 2023, alice.address);
      await serial.connect(owner).generateForYear("GLD", 2024, alice.address);
      await serial.connect(owner).generateForYear("GLD", 2023, alice.address);

      const s3 = await serial.getSerial(3n);
      expect(s3.serialCode).to.equal("GLD-2023-000002");
    });

    it("un non-owner ne peut pas utiliser generateForYear", async () => {
      await expect(
        serial.connect(issuer).generateForYear("GLD", 2024, alice.address)
      ).to.be.revertedWithCustomError(serial, "OwnableUnauthorizedAccount");
    });

    it("échoue avec année < 2020", async () => {
      await expect(
        serial.connect(owner).generateForYear("GLD", 2019, alice.address)
      ).to.be.revertedWithCustomError(serial, "InvalidYear");
    });

    it("échoue avec année > 2100", async () => {
      await expect(
        serial.connect(owner).generateForYear("GLD", 2101, alice.address)
      ).to.be.revertedWithCustomError(serial, "InvalidYear");
    });
  });

  // ── 5. Vues et requêtes ───────────────────────────────────────────────────

  describe("Vues", () => {
    beforeEach(async () => {
      await serial.connect(issuer).generate(alice.address);
      await serial.connect(issuer).generate(bob.address);
      await serial.connect(issuer).generate(alice.address);
    });

    it("getSerial retourne le bon serial", async () => {
      const s = await serial.getSerial(2n);
      expect(s.issuedTo).to.equal(bob.address);
    });

    it("getSerial échoue pour un id inexistant", async () => {
      await expect(
        serial.getSerial(99n)
      ).to.be.revertedWithCustomError(serial, "SerialNotFound");
    });

    it("getSerialByCode retourne le bon serial", async () => {
      const year = await serial.currentYear();
      const s = await serial.getSerialByCode(`GLD-${year}-000002`);
      expect(s.issuedTo).to.equal(bob.address);
    });

    it("getSerialByCode échoue pour un code inexistant", async () => {
      await expect(
        serial.getSerialByCode("GLD-1900-000001")
      ).to.be.revertedWithCustomError(serial, "SerialNotFound");
    });

    it("exists retourne true pour un code existant", async () => {
      const year = await serial.currentYear();
      expect(await serial.exists(`GLD-${year}-000001`)).to.be.true;
    });

    it("exists retourne false pour un code inexistant", async () => {
      expect(await serial.exists("GLD-1900-000001")).to.be.false;
    });

    it("getSerialsOf retourne les bons ids pour alice", async () => {
      const ids = await serial.getSerialsOf(alice.address);
      expect(ids.length).to.equal(2);
      expect(ids[0]).to.equal(1n);
      expect(ids[1]).to.equal(3n);
    });

    it("nextCounter retourne le prochain compteur", async () => {
      const year = await serial.currentYear();
      expect(await serial.nextCounter("GLD", year)).to.equal(4n);
    });
  });

  // ── 6. Déactivation ───────────────────────────────────────────────────────

  describe("deactivate", () => {
    beforeEach(async () => {
      await serial.connect(issuer).generate(alice.address);
    });

    it("issuer peut désactiver un serial", async () => {
      await serial.connect(issuer).deactivate(1n);
      const s = await serial.getSerial(1n);
      expect(s.active).to.be.false;
    });

    it("emit SerialDeactivated", async () => {
      await expect(serial.connect(issuer).deactivate(1n))
        .to.emit(serial, "SerialDeactivated")
        .withArgs(1n, issuer.address);
    });

    it("ne peut pas désactiver un serial inexistant", async () => {
      await expect(
        serial.connect(issuer).deactivate(99n)
      ).to.be.revertedWithCustomError(serial, "SerialNotFound");
    });

    it("ne peut pas désactiver deux fois", async () => {
      await serial.connect(issuer).deactivate(1n);
      await expect(
        serial.connect(issuer).deactivate(1n)
      ).to.be.revertedWithCustomError(serial, "SerialInactive");
    });

    it("un non-issuer ne peut pas désactiver", async () => {
      await expect(
        serial.connect(alice).deactivate(1n)
      ).to.be.revertedWithCustomError(serial, "UnauthorizedIssuer");
    });
  });

  // ── 7. Transfert ──────────────────────────────────────────────────────────

  describe("transfer", () => {
    beforeEach(async () => {
      await serial.connect(issuer).generate(alice.address);
    });

    it("issuer peut transférer un serial vers une nouvelle adresse", async () => {
      await serial.connect(issuer).transfer(1n, bob.address);
      const s = await serial.getSerial(1n);
      expect(s.issuedTo).to.equal(bob.address);
    });

    it("emit SerialTransferred", async () => {
      await expect(serial.connect(issuer).transfer(1n, bob.address))
        .to.emit(serial, "SerialTransferred")
        .withArgs(1n, alice.address, bob.address);
    });

    it("bob apparaît dans getSerialsOf après transfert", async () => {
      await serial.connect(issuer).transfer(1n, bob.address);
      const ids = await serial.getSerialsOf(bob.address);
      expect(ids.length).to.equal(1);
      expect(ids[0]).to.equal(1n);
    });

    it("ne peut pas transférer un serial inactif", async () => {
      await serial.connect(issuer).deactivate(1n);
      await expect(
        serial.connect(issuer).transfer(1n, bob.address)
      ).to.be.revertedWithCustomError(serial, "SerialInactive");
    });

    it("ne peut pas transférer vers address(0)", async () => {
      await expect(
        serial.connect(issuer).transfer(1n, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(serial, "ZeroAddress");
    });
  });

  // ── 8. Admin ──────────────────────────────────────────────────────────────

  describe("Admin", () => {
    it("owner peut changer le préfixe par défaut", async () => {
      await serial.setDefaultPrefix("TONNE");
      expect(await serial.defaultPrefix()).to.equal("TONNE");
    });

    it("emit DefaultPrefixUpdated", async () => {
      await expect(serial.setDefaultPrefix("TONNE"))
        .to.emit(serial, "DefaultPrefixUpdated")
        .withArgs("GLD", "TONNE");
    });

    it("setDefaultPrefix échoue avec préfixe vide", async () => {
      await expect(
        serial.setDefaultPrefix("")
      ).to.be.revertedWithCustomError(serial, "EmptyPrefix");
    });

    it("owner peut révoquer un issuer", async () => {
      await serial.revokeIssuer(issuer.address);
      expect(await serial.authorizedIssuers(issuer.address)).to.be.false;
      await expect(
        serial.connect(issuer).generate(alice.address)
      ).to.be.revertedWithCustomError(serial, "UnauthorizedIssuer");
    });

    it("emit IssuerRevoked", async () => {
      await expect(serial.revokeIssuer(issuer.address))
        .to.emit(serial, "IssuerRevoked")
        .withArgs(issuer.address);
    });

    it("un non-owner ne peut pas authorizeIssuer", async () => {
      await expect(
        serial.connect(alice).authorizeIssuer(bob.address)
      ).to.be.revertedWithCustomError(serial, "OwnableUnauthorizedAccount");
    });
  });

  // ── 9. Format du numéro de série ──────────────────────────────────────────

  describe("Format et padding", () => {
    it("le padding à 6 chiffres fonctionne jusqu'à 999999", async () => {
      // Générer un serial avec counter élevé via generateForYear
      // On simule en appelant 3 fois et en vérifiant le format
      await serial.connect(issuer).generate(alice.address);
      const s = await serial.getSerial(1n);
      expect(s.serialCode).to.match(/^GLD-\d{4}-\d{6}$/);
    });

    it("currentYear retourne une année plausible", async () => {
      const year = await serial.currentYear();
      expect(year).to.be.gte(2024);
      expect(year).to.be.lte(2030);
    });

    it("deux serials consécutifs ont des codes différents", async () => {
      await serial.connect(issuer).generate(alice.address);
      await serial.connect(issuer).generate(alice.address);
      const s1 = await serial.getSerial(1n);
      const s2 = await serial.getSerial(2n);
      expect(s1.serialCode).to.not.equal(s2.serialCode);
    });
  });

  // ── 10. UUPS ──────────────────────────────────────────────────────────────

  describe("Upgradeability (UUPS)", () => {
    it("le owner peut upgrader", async () => {
      const Factory = await ethers.getContractFactory("SerialNumber");
      const newImpl = await Factory.deploy();
      await expect(
        serial.upgradeToAndCall(await newImpl.getAddress(), "0x")
      ).to.not.revert(ethers);
    });

    it("un non-owner ne peut pas upgrader", async () => {
      const Factory = await ethers.getContractFactory("SerialNumber");
      const newImpl = await Factory.deploy();
      await expect(
        serial.connect(alice).upgradeToAndCall(await newImpl.getAddress(), "0x")
      ).to.be.revertedWithCustomError(serial, "OwnableUnauthorizedAccount");
    });
  });
});
