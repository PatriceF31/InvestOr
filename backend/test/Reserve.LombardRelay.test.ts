// test/Reserve.LombardRelay.test.ts
//
// Tests des 7 fonctions relais Reserve -> LombardVault, ajoutées pour la
// cohérence architecturale (LombardVault owned par Reserve, comme Exchange et
// MorphoYieldStrategy). Ne re-teste PAS la logique métier de LombardVault
// (LTV, intérêts, liquidation) — déjà couverte par LombardVault.test.ts.
// Se concentre sur ce qui est nouveau ici : contrôle d'accès, garde-fous
// d'adresse nulle, et propagation réelle de l'appel jusqu'à LombardVault.
//
// gld/treasury/exchange sont initialisés avec des adresses factices (simples
// signers) — Reserve.initialize() ne fait que les stocker, aucun appel n'est
// jamais émis dessus dans les tests ci-dessous.

import { expect } from "chai";
import { network } from "hardhat";

describe("Reserve — relais LombardVault", function () {
  async function deployFixture() {
    const { ethers } = await network.create();
    const [owner, stranger, gldStub, treasuryStub, exchangeStub, newOperator, claimTo] =
      await ethers.getSigners();

    // ── Reserve (dépendances factices — seules leurs adresses comptent ici) ──
    const reserveImpl = await ethers.deployContract("Reserve");
    const reserveInitData = reserveImpl.interface.encodeFunctionData("initialize", [
      owner.address, gldStub.address, treasuryStub.address, exchangeStub.address,
      ethers.ZeroAddress, // oracle optionnel
      10_000, // minRatioBps = 100%
    ]);
    const reserveProxy = await ethers.deployContract("InvestOrProxy", [
      await reserveImpl.getAddress(), reserveInitData,
    ]);
    const reserve = await ethers.getContractAt("Reserve", await reserveProxy.getAddress());

    // ── LombardVault réel (dépendances factices également suffisantes ici) ──
    const vaultImpl = await ethers.deployContract("LombardVault");
    const vaultInitData = vaultImpl.interface.encodeFunctionData("initialize", [
      owner.address, gldStub.address, treasuryStub.address, exchangeStub.address, owner.address,
    ]);
    const vaultProxy = await ethers.deployContract("InvestOrProxy", [
      await vaultImpl.getAddress(), vaultInitData,
    ]);
    const vault = await ethers.getContractAt("LombardVault", await vaultProxy.getAddress());

    // Condition nécessaire pour que les relais fonctionnent : Reserve doit être
    // owner de LombardVault (sinon ILombardVault(...).setX() reverte lui-même).
    await vault.connect(owner).transferOwnership(await reserve.getAddress());

    return { ethers, owner, stranger, newOperator, claimTo, reserve, vault };
  }

  it("setLombardVault câble l'adresse et émet l'event", async function () {
    const { ethers, owner, reserve, vault } = await deployFixture();
    // lombardVault vaut address(0) au départ dans ce fixture -> c'est la valeur
    // attendue pour "oldVault" dans l'event.
    await expect(reserve.connect(owner).setLombardVault(await vault.getAddress()))
      .to.emit(reserve, "LombardVaultUpdated")
      .withArgs(ethers.ZeroAddress, await vault.getAddress());
    expect(await reserve.lombardVault()).to.equal(await vault.getAddress());
  });

  it("refuse setLombardVault avec l'adresse zéro", async function () {
    const { ethers, owner, reserve } = await deployFixture();
    await expect(
      reserve.connect(owner).setLombardVault(ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(reserve, "ZeroAddress");
  });

  it("refuse tous les relais Lombard à un non-owner", async function () {
    const { owner, stranger, newOperator, claimTo, reserve, vault } = await deployFixture();
    await reserve.connect(owner).setLombardVault(await vault.getAddress());

    await expect(reserve.connect(stranger).setLombardOperator(newOperator.address))
      .to.be.revertedWithCustomError(reserve, "OwnableUnauthorizedAccount");
    await expect(reserve.connect(stranger).setLombardLtvParams(7000, 8000))
      .to.be.revertedWithCustomError(reserve, "OwnableUnauthorizedAccount");
    await expect(reserve.connect(stranger).setLombardRateParams(700, 400, 300))
      .to.be.revertedWithCustomError(reserve, "OwnableUnauthorizedAccount");
    await expect(reserve.connect(stranger).setLombardLiquidationDiscount(500))
      .to.be.revertedWithCustomError(reserve, "OwnableUnauthorizedAccount");
    await expect(reserve.connect(stranger).pauseLombard())
      .to.be.revertedWithCustomError(reserve, "OwnableUnauthorizedAccount");
    await expect(reserve.connect(stranger).unpauseLombard())
      .to.be.revertedWithCustomError(reserve, "OwnableUnauthorizedAccount");
    await expect(reserve.connect(stranger).claimLombardProtocolShare(claimTo.address))
      .to.be.revertedWithCustomError(reserve, "OwnableUnauthorizedAccount");
  });

  it("refuse les relais tant que setLombardVault n'a pas été appelé", async function () {
    const { owner, newOperator, reserve } = await deployFixture();
    // Note : lombardVault n'a PAS été câblé dans ce test précis
    await expect(
      reserve.connect(owner).setLombardOperator(newOperator.address)
    ).to.be.revertedWithCustomError(reserve, "ZeroAddress");
  });

  it("setLombardOperator propage réellement jusqu'à LombardVault.operator()", async function () {
    const { owner, newOperator, reserve, vault } = await deployFixture();
    await reserve.connect(owner).setLombardVault(await vault.getAddress());

    await expect(reserve.connect(owner).setLombardOperator(newOperator.address))
      .to.emit(reserve, "LombardOperatorUpdated")
      .withArgs(newOperator.address);

    expect(await vault.operator()).to.equal(newOperator.address);
  });

  it("setLombardLtvParams propage jusqu'à LombardVault", async function () {
    const { owner, reserve, vault } = await deployFixture();
    await reserve.connect(owner).setLombardVault(await vault.getAddress());

    await expect(reserve.connect(owner).setLombardLtvParams(6500, 7500))
      .to.emit(reserve, "LombardLtvParamsUpdated")
      .withArgs(6500, 7500);

    expect(await vault.ltvMaxBps()).to.equal(6500n);
    expect(await vault.liquidationThresholdBps()).to.equal(7500n);
  });

  it("setLombardRateParams propage jusqu'à LombardVault", async function () {
    const { owner, reserve, vault } = await deployFixture();
    await reserve.connect(owner).setLombardVault(await vault.getAddress());

    await expect(reserve.connect(owner).setLombardRateParams(1000, 600, 400))
      .to.emit(reserve, "LombardRateParamsUpdated")
      .withArgs(1000, 600, 400);

    expect(await vault.borrowRateBps()).to.equal(1000n);
    expect(await vault.supplierShareBps()).to.equal(600n);
    expect(await vault.protocolShareBps()).to.equal(400n);
  });

  it("setLombardLiquidationDiscount propage jusqu'à LombardVault", async function () {
    const { owner, reserve, vault } = await deployFixture();
    await reserve.connect(owner).setLombardVault(await vault.getAddress());

    await expect(reserve.connect(owner).setLombardLiquidationDiscount(800))
      .to.emit(reserve, "LombardLiquidationDiscountUpdated")
      .withArgs(800);

    expect(await vault.liquidationDiscountBps()).to.equal(800n);
  });

  it("pauseLombard / unpauseLombard propagent réellement l'état pausable", async function () {
    const { owner, reserve, vault } = await deployFixture();
    await reserve.connect(owner).setLombardVault(await vault.getAddress());

    await expect(reserve.connect(owner).pauseLombard()).to.emit(reserve, "LombardPausedByReserve");
    expect(await vault.paused()).to.equal(true);

    await expect(reserve.connect(owner).unpauseLombard()).to.emit(reserve, "LombardUnpausedByReserve");
    expect(await vault.paused()).to.equal(false);
  });

  it("claimLombardProtocolShare refuse l'adresse zéro et propage sinon", async function () {
    const { ethers, owner, claimTo, reserve, vault } = await deployFixture();
    await reserve.connect(owner).setLombardVault(await vault.getAddress());

    await expect(
      reserve.connect(owner).claimLombardProtocolShare(ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(reserve, "ZeroAddress");

    // Aucun intérêt accumulé dans ce test (aucun emprunt/remboursement réel) —
    // on vérifie seulement que l'appel traverse jusqu'à LombardVault sans revert
    // et émet l'event Reserve, pas le montant transféré (0 attendu ici).
    await expect(reserve.connect(owner).claimLombardProtocolShare(claimTo.address))
      .to.emit(reserve, "LombardProtocolShareClaimed")
      .withArgs(claimTo.address);
  });
});
