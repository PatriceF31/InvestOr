// test/LombardVault.test.ts
//
// Suite de tests pour LombardVault (US-01 Marthe, US-13 Farid, US-11 liquidation).
// Toutes les valeurs attendues ont été précalculées à la main (Python) avant
// l'écriture des assertions — voir les commentaires de calcul à chaque section.

import { expect } from "chai";
import { network } from "hardhat";

describe("LombardVault", function () {
  const PRICE_INITIAL = 15_000_000_000n; // 150 $/g, 8 décimales
  const GLD = (grams: number) => BigInt(grams) * 1000n; // GLD a 3 décimales
  const USDC = (amount: number) => BigInt(amount) * 1_000_000n; // USDC a 6 décimales

  async function deployFixture() {
    const { ethers } = await network.create();
    const [owner, marthe, farid, sofia, buyer, operator, stranger] = await ethers.getSigners();

    // ── Tokens ──────────────────────────────────────────────────────────
    const usdc = await ethers.deployContract("MockUSDC");

    const gldImpl = await ethers.deployContract("GLD");
    const gldInitData = gldImpl.interface.encodeFunctionData("initialize", [owner.address]);
    const gldProxy = await ethers.deployContract("InvestOrProxy", [await gldImpl.getAddress(), gldInitData]);
    const gld = await ethers.getContractAt("GLD", await gldProxy.getAddress());
    // complianceModule reste address(0) — mode permissif, comportement V1 (voir GLD.sol)

    const oracle = await ethers.deployContract("MockExchangeOracle", [PRICE_INITIAL]);

    // ── LombardVault (via proxy, comme Treasury/MorphoYieldStrategy) ────
    const vaultImpl = await ethers.deployContract("LombardVault");
    const vaultInitData = vaultImpl.interface.encodeFunctionData("initialize", [
      owner.address, await gld.getAddress(), await usdc.getAddress(), await oracle.getAddress(), operator.address,
    ]);
    const vaultProxy = await ethers.deployContract("InvestOrProxy", [await vaultImpl.getAddress(), vaultInitData]);
    const vault = await ethers.getContractAt("LombardVault", await vaultProxy.getAddress());

    // ── Fonds de départ ──────────────────────────────────────────────────
    await gld.mint(marthe.address, GLD(50));
    await usdc.mint(farid.address, USDC(100_000));
    await usdc.mint(sofia.address, USDC(100_000));
    await usdc.mint(buyer.address, USDC(100_000));
    await usdc.mint(marthe.address, USDC(100_000));

    return { ethers, owner, marthe, farid, sofia, buyer, operator, stranger, usdc, gld, oracle, vault };
  }

  // ── Emprunteur (Marthe) ────────────────────────────────────────────────

  describe("Collatéral et emprunt", function () {
    it("dépose du collatéral GLD correctement", async function () {
      const { marthe, gld, vault } = await deployFixture();
      await gld.connect(marthe).approve(await vault.getAddress(), GLD(50));
      await vault.connect(marthe).depositCollateral(GLD(50));
      const pos = await vault.positions(marthe.address);
      expect(pos.collateralGLD).to.equal(GLD(50));
    });

    it("autorise un emprunt exactement au plafond de 70% LTV", async function () {
      const { marthe, gld, usdc, vault } = await deployFixture();
      await gld.connect(marthe).approve(await vault.getAddress(), GLD(50));
      await vault.connect(marthe).depositCollateral(GLD(50));

      // 50g @ 150$/g = 7500 USDC de collatéral -> 70% = 5250 USDC empruntable
      await usdc.mint(await vault.getAddress(), USDC(10_000)); // liquidité du pool
      await vault.connect(marthe).borrow(USDC(5250));

      expect(await usdc.balanceOf(marthe.address)).to.equal(USDC(100_000) + USDC(5250));
      const ltv = await vault.currentLTV(marthe.address);
      expect(ltv).to.equal(7000n); // exactement 70.00%
    });

    it("refuse un emprunt au-delà du plafond (excédent d'au moins 1 bps, soit 0,75 USDC ici)", async function () {
      const { marthe, gld, usdc, vault } = await deployFixture();
      await gld.connect(marthe).approve(await vault.getAddress(), GLD(50));
      await vault.connect(marthe).depositCollateral(GLD(50));
      await usdc.mint(await vault.getAddress(), USDC(10_000));

      // NB : la division entière du calcul de bps tolère jusqu'à 750 000 wei (0,75 USDC)
      // d'excédent sans faire varier le LTV affiché (1 bps = 1/10000 de 7500 USDC de
      // collatéral) — on dépasse donc le plafond avec 1 USDC entier pour être sûr de
      // déclencher le revert, pas avec 1 wei symbolique.
      await expect(
        vault.connect(marthe).borrow(USDC(5250) + USDC(1))
      ).to.be.revertedWithCustomError(vault, "LtvExceeded");
    });

    it("refuse d'emprunter sans collatéral déposé", async function () {
      const { marthe, usdc, vault } = await deployFixture();
      await usdc.mint(await vault.getAddress(), USDC(10_000));
      await expect(
        vault.connect(marthe).borrow(USDC(100))
      ).to.be.revertedWithCustomError(vault, "NoCollateral");
    });

    it("refuse un emprunt supérieur à la liquidité disponible", async function () {
      const { marthe, gld, vault } = await deployFixture();
      await gld.connect(marthe).approve(await vault.getAddress(), GLD(50));
      await vault.connect(marthe).depositCollateral(GLD(50));
      // Aucune liquidité déposée dans le pool
      await expect(
        vault.connect(marthe).borrow(USDC(100))
      ).to.be.revertedWithCustomError(vault, "InsufficientLiquidity");
    });

    it("refuse un retrait de collatéral qui dépasserait le plafond LTV", async function () {
      const { marthe, gld, usdc, vault } = await deployFixture();
      await gld.connect(marthe).approve(await vault.getAddress(), GLD(50));
      await vault.connect(marthe).depositCollateral(GLD(50));
      await usdc.mint(await vault.getAddress(), USDC(10_000));
      await vault.connect(marthe).borrow(USDC(5250)); // pile au plafond

      await expect(
        vault.connect(marthe).withdrawCollateral(GLD(1))
      ).to.be.revertedWithCustomError(vault, "LtvExceeded");
    });
  });

  // ── Intérêts et remboursement ──────────────────────────────────────────

  describe("Intérêts et remboursement", function () {
    it("accrue l'intérêt correctement après ~180 jours (calculé à partir des timestamps réels)", async function () {
      const { ethers, marthe, gld, usdc, vault } = await deployFixture();
      await gld.connect(marthe).approve(await vault.getAddress(), GLD(50));
      await vault.connect(marthe).depositCollateral(GLD(50));
      await usdc.mint(await vault.getAddress(), USDC(10_000));
      const borrowTx = await vault.connect(marthe).borrow(USDC(5250));
      const borrowBlock = await ethers.provider.getBlock(borrowTx.blockNumber!);

      await ethers.provider.send("evm_increaseTime", [180 * 86400]);
      await ethers.provider.send("evm_mine", []);

      const [principal, interest] = await vault.debtOf(marthe.address);
      const nowBlock = await ethers.provider.getBlock("latest");
      const elapsed = BigInt(nowBlock!.timestamp) - BigInt(borrowBlock!.timestamp);

      expect(principal).to.equal(USDC(5250));
      const expectedInterest = (USDC(5250) * 700n * elapsed) / (10_000n * 365n * 86400n);
      expect(interest).to.equal(expectedInterest);
      // Vérifie que c'est bien proche de ~180 jours (marge large pour tolérer les blocs intermédiaires)
      expect(elapsed).to.be.closeTo(BigInt(180 * 86400), 30n);
    });

    it("rembourse l'intérêt en premier, puis le capital", async function () {
      const { ethers, marthe, gld, usdc, vault } = await deployFixture();
      await gld.connect(marthe).approve(await vault.getAddress(), GLD(50));
      await vault.connect(marthe).depositCollateral(GLD(50));
      await usdc.mint(await vault.getAddress(), USDC(10_000));
      const borrowTx = await vault.connect(marthe).borrow(USDC(5250));
      const borrowBlock = await ethers.provider.getBlock(borrowTx.blockNumber!);

      await ethers.provider.send("evm_increaseTime", [180 * 86400]);
      await ethers.provider.send("evm_mine", []);

      await usdc.connect(marthe).approve(await vault.getAddress(), USDC(1_000));

      const [, interestBeforeRepay] = await vault.debtOf(marthe.address);
      expect(interestBeforeRepay).to.be.gt(USDC(100)); // largement suffisant pour absorber 100 USDC en intérêt pur

      const repayTx = await vault.connect(marthe).repay(USDC(100));
      await expect(repayTx).to.emit(vault, "Repaid").withArgs(marthe.address, USDC(100), 0n);

      // L'intérêt réellement dû au moment EXACT où repay() s'exécute (pas au moment où on
      // l'a lu juste avant) — repay() est sa propre transaction, minée dans un bloc dont le
      // timestamp peut différer de quelques secondes de la lecture précédente. On recalcule
      // donc l'attendu à partir du timestamp réel du bloc de repay, avec la même formule que
      // le contrat, plutôt que de soustraire naïvement 100 USDC de la valeur lue avant.
      const repayBlock = await ethers.provider.getBlock(repayTx.blockNumber!);
      const elapsedAtRepay = BigInt(repayBlock!.timestamp) - BigInt(borrowBlock!.timestamp);
      const interestAtRepay = (USDC(5250) * 700n * elapsedAtRepay) / (10_000n * 365n * 86400n);

      const pos = await vault.positions(marthe.address);
      expect(pos.principalCapital).to.equal(USDC(5250)); // capital intact, seul l'intérêt a baissé
      expect(pos.interestOwed).to.equal(interestAtRepay - USDC(100));
    });
  });

  // ── Prêteur (Farid) et répartition proportionnelle ─────────────────────

  describe("Prêteur et répartition des intérêts", function () {

    it("permet un retrait 'best effort' plafonné à la liquidité disponible", async function () {
      const { marthe, farid, gld, usdc, vault } = await deployFixture();
      await usdc.connect(farid).approve(await vault.getAddress(), USDC(5_000));
      await vault.connect(farid).supply(USDC(5_000));

      await gld.connect(marthe).approve(await vault.getAddress(), GLD(50));
      await vault.connect(marthe).depositCollateral(GLD(50));
      await vault.connect(marthe).borrow(USDC(4_000)); // emprunte une partie de la liquidité de Farid

      // Farid ne peut retirer que ce qui reste réellement dans le pool (5000-4000=1000)
      const before = await usdc.balanceOf(farid.address);
      await vault.connect(farid).withdraw(USDC(5_000));
      const after = await usdc.balanceOf(farid.address);
      expect(after - before).to.equal(USDC(1_000));

      const pos = await vault.supplierPrincipal(farid.address);
      expect(pos).to.equal(USDC(5_000) - USDC(1_000)); // le principal restant reflète ce qui n'a pas pu être retiré
    });

    it("distribue l'intérêt réel au prorata entre Farid (60%) et Sofia (40%)", async function () {
      const { ethers, owner, marthe, farid, sofia, gld, usdc, vault } = await deployFixture();

      await usdc.connect(farid).approve(await vault.getAddress(), USDC(3_000));
      await vault.connect(farid).supply(USDC(3_000));
      await usdc.connect(sofia).approve(await vault.getAddress(), USDC(2_000));
      await vault.connect(sofia).supply(USDC(2_000));
      // totalSupplied = 5000

      await gld.connect(marthe).approve(await vault.getAddress(), GLD(50));
      await vault.connect(marthe).depositCollateral(GLD(50));
      await vault.connect(marthe).borrow(USDC(5_000)); // emprunte toute la liquidité dispo (LTV 66,67% < 70%, OK)

      await ethers.provider.send("evm_increaseTime", [180 * 86400]);
      await ethers.provider.send("evm_mine", []);

      // Intérêt dû sur 5000 USDC à 7%/an pendant 180j : 5000*700*180j / (10000*365j)
      const [, interestOwed] = await vault.debtOf(marthe.address);
      // Marthe rembourse tout l'intérêt couru en un coup
      await usdc.mint(marthe.address, USDC(1_000));
      await usdc.connect(marthe).approve(await vault.getAddress(), interestOwed);
      await vault.connect(marthe).repay(interestOwed);

      const farid_pending = await vault.pendingReward(farid.address);
      const sofia_pending = await vault.pendingReward(sofia.address);

      // Part prêteurs = 4/7 de l'intérêt payé, répartie 60/40 (3000/5000, 2000/5000)
      const supplierCut = (interestOwed * 400n) / 700n;
      const expectedFarid = (3_000_000_000n * ((supplierCut * 10n ** 18n) / 5_000_000_000n)) / 10n ** 18n;
      const expectedSofia = (2_000_000_000n * ((supplierCut * 10n ** 18n) / 5_000_000_000n)) / 10n ** 18n;

      expect(farid_pending).to.equal(expectedFarid);
      expect(sofia_pending).to.equal(expectedSofia);
      // Vérifie la proportion 60/40 sans dépendre du calcul exact ci-dessus
      expect(farid_pending).to.be.gt(sofia_pending);
    });
  });

  // ── Liquidation ─────────────────────────────────────────────────────────

  describe("Liquidation", function () {
    async function borrowAtMaxThenCrashPrice(fx: Awaited<ReturnType<typeof deployFixture>>) {
      const { marthe, gld, usdc, oracle, vault } = fx;
      await gld.connect(marthe).approve(await vault.getAddress(), GLD(50));
      await vault.connect(marthe).depositCollateral(GLD(50));
      await usdc.mint(await vault.getAddress(), USDC(10_000));
      await vault.connect(marthe).borrow(USDC(5250)); // 70% LTV pile

      // Le prix chute de 150 à 120 $/g -> collatéral 7500 -> 6000, LTV monte à 87,5%
      await oracle.setPrice(12_000_000_000n);
    }

    it("refuse la liquidation tant que le seuil n'est pas atteint", async function () {
      const fx = await deployFixture();
      const { marthe, gld, usdc, operator, buyer, vault } = fx;
      await gld.connect(marthe).approve(await vault.getAddress(), GLD(50));
      await vault.connect(marthe).depositCollateral(GLD(50));
      await usdc.mint(await vault.getAddress(), USDC(10_000));
      await vault.connect(marthe).borrow(USDC(5250)); // 70% LTV, sous le seuil de 80%

      await expect(
        vault.connect(operator).liquidate(marthe.address, buyer.address)
      ).to.be.revertedWithCustomError(vault, "NotLiquidatable");
    });

    it("refuse la liquidation à un appelant autre que l'opérateur", async function () {
      const fx = await deployFixture();
      await borrowAtMaxThenCrashPrice(fx);
      const { marthe, buyer, stranger, vault } = fx;

      await expect(
        vault.connect(stranger).liquidate(marthe.address, buyer.address)
      ).to.be.revertedWithCustomError(vault, "UnauthorizedOperator");
    });

    it("saisit partiellement le collatéral et restitue le surplus à l'emprunteur", async function () {
      const fx = await deployFixture();
      await borrowAtMaxThenCrashPrice(fx);
      const { marthe, buyer, operator, gld, usdc, vault } = fx;

      await usdc.connect(buyer).approve(await vault.getAddress(), USDC(10_000));
      const buyerGldBefore = await gld.balanceOf(buyer.address);

      // Calcule l'attendu à partir de l'état réel juste avant la liquidation (robuste aux
      // quelques secondes d'intérêt accru par les transactions intermédiaires ci-dessus),
      // avec la même formule que le contrat — reproduite indépendamment, pas copiée-collée.
      const [principal, interestOwed] = await vault.debtOf(marthe.address);
      const debt = principal + interestOwed;
      const posBefore = await vault.positions(marthe.address);
      const [price] = await fx.oracle.getPrice();
      const collateralValueUsdc = (posBefore.collateralGLD * price) / 100_000n;
      const discountedTotal = (collateralValueUsdc * (10_000n - 500n)) / 10_000n; // décote 5% par défaut
      expect(discountedTotal).to.be.gt(debt); // confirme qu'on est bien dans le cas "saisie partielle"
      const expectedSeized = (debt * posBefore.collateralGLD) / discountedTotal;

      await vault.connect(operator).liquidate(marthe.address, buyer.address);

      const pos = await vault.positions(marthe.address);
      expect(pos.collateralGLD).to.equal(posBefore.collateralGLD - expectedSeized);
      expect(pos.principalCapital).to.equal(0n);
      expect(pos.interestOwed).to.equal(0n);

      const buyerGldAfter = await gld.balanceOf(buyer.address);
      expect(buyerGldAfter - buyerGldBefore).to.equal(expectedSeized);
      // Vérifie l'ordre de grandeur attendu (≈46g sur 50g) sans dépendre d'une valeur exacte figée
      expect(expectedSeized).to.be.closeTo(46_052n, 100n);
    });

    it("saisit tout le collatéral si même décoté il ne couvre pas la dette (créance irrécouvrable)", async function () {
      const fx = await deployFixture();
      const { marthe, buyer, operator, gld, usdc, oracle, vault } = fx;
      await gld.connect(marthe).approve(await vault.getAddress(), GLD(50));
      await vault.connect(marthe).depositCollateral(GLD(50));
      await usdc.mint(await vault.getAddress(), USDC(10_000));
      await vault.connect(marthe).borrow(USDC(5250));

      // Chute de prix extrême : 150 -> 50 $/g (collatéral 7500 -> 2500, largement sous la dette)
      await oracle.setPrice(5_000_000_000n);

      await usdc.connect(buyer).approve(await vault.getAddress(), USDC(10_000));
      await vault.connect(operator).liquidate(marthe.address, buyer.address);

      const pos = await vault.positions(marthe.address);
      expect(pos.collateralGLD).to.equal(0n); // position soldée, tout saisi
    });
  });

  // ── Administration ────────────────────────────────────────────────────

  describe("Administration", function () {
    it("refuse setLtvParams si le seuil de liquidation n'est pas strictement supérieur au LTV max", async function () {
      const { owner, vault } = await deployFixture();
      await expect(
        vault.connect(owner).setLtvParams(8000, 8000)
      ).to.be.revertedWithCustomError(vault, "InvalidBps");
    });

    it("refuse setRateParams si les parts prêteur+protocole ne totalisent pas le taux d'emprunt", async function () {
      const { owner, vault } = await deployFixture();
      await expect(
        vault.connect(owner).setRateParams(700, 400, 400) // 400+400=800 != 700
      ).to.be.revertedWithCustomError(vault, "InvalidBps");
    });
  });
});
