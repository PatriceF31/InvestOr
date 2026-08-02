// test/MorphoYieldStrategy.test.ts
//
// Suite de tests pour MorphoYieldStrategy + intégration Treasury (2.2).
// Utilise MockMorpho.sol (simulateur local, pas le vrai Morpho Blue) pour rester
// rapide et déterministe — voir contracts/mocks/MockMorpho.sol pour ses limites
// assumées (pas de vraie courbe IRM, intérêt/tension de liquidité pilotés à la main
// via testAccrueYield / testBorrowLiquidity).

import { expect } from "chai";
import { network } from "hardhat";

describe("MorphoYieldStrategy + Treasury (2.2)", function () {
  async function deployFixture() {
    const { ethers } = await network.create();
    const [owner, reserveSigner, operator, borrower, user] = await ethers.getSigners();

    // ── Tokens ──────────────────────────────────────────────────────────
    const MockUSDC = await ethers.getContractFactory("MockUSDC");
    const usdc = await MockUSDC.deploy();

    const MockUSDC2 = await ethers.getContractFactory("MockUSDC"); // réutilisé comme cbBTC de test (8 déc non nécessaires ici)
    const cbbtc = await MockUSDC2.deploy();

    // ── Morpho mock + marché ────────────────────────────────────────────
    const MockMorpho = await ethers.getContractFactory("MockMorpho");
    const morpho = await MockMorpho.deploy();

    const marketParams = {
      loanToken: await usdc.getAddress(),
      collateralToken: await cbbtc.getAddress(),
      // setMarketParams() refuse address(0) sur oracle/irm (garde-fou volontaire,
      // même si MockMorpho ne les consulte jamais) — adresses factices non nulles.
      oracle: owner.address,
      irm: reserveSigner.address,
      lltv: 860000000000000000n,
    };
    await morpho.createMarket(marketParams);

    // ── Treasury — déployée via InvestOrProxy (ERC1967Proxy), comme en
    //    production. Appeler initialize() sur l'implémentation nue est
    //    impossible : _disableInitializers() dans son constructeur bloque
    //    exprès ce cas — c'est tout l'intérêt du garde-fou. ─────────────────
    const treasuryImpl = await ethers.deployContract("Treasury");
    const treasuryInitData = treasuryImpl.interface.encodeFunctionData("initialize", [
      owner.address, await usdc.getAddress(), ethers.ZeroAddress,
    ]);
    const treasuryProxy = await ethers.deployContract("InvestOrProxy", [
      await treasuryImpl.getAddress(), treasuryInitData,
    ]);
    const treasury = await ethers.getContractAt("Treasury", await treasuryProxy.getAddress());
    await treasury.setOperator(operator.address);
    await treasury.setReserve(reserveSigner.address);

    // ── MorphoYieldStrategy — même chose, via proxy ─────────────────────
    const strategyImpl = await ethers.deployContract("MorphoYieldStrategy");
    const strategyInitData = strategyImpl.interface.encodeFunctionData("initialize", [
      owner.address, await morpho.getAddress(), await treasury.getAddress(),
    ]);
    const strategyProxy = await ethers.deployContract("InvestOrProxy", [
      await strategyImpl.getAddress(), strategyInitData,
    ]);
    const strategy = await ethers.getContractAt("MorphoYieldStrategy", await strategyProxy.getAddress());
    await strategy.setMarketParams(
      marketParams.loanToken,
      marketParams.collateralToken,
      marketParams.oracle,
      marketParams.irm,
      marketParams.lltv
    );

    // Treasury pointe vers la stratégie — appelé par `reserve` (onlyReserveOrOwner)
    await treasury.connect(reserveSigner).setYieldStrategy(await strategy.getAddress());

    // Fonds de départ
    await usdc.mint(operator.address, ethers.parseUnits("100000", 6));
    await usdc.mint(borrower.address, ethers.parseUnits("100000", 6));
    await usdc.mint(user.address, ethers.parseUnits("100000", 6));

    return {
      ethers, owner, reserveSigner, operator, borrower, user,
      usdc, cbbtc, morpho, marketParams, treasury, strategy,
    };
  }

  // ── deposit() ───────────────────────────────────────────────────────────

  describe("deposit()", function () {
    it("refuse tout appelant autre que Treasury", async function () {
      const { strategy, user } = await deployFixture();
      await expect(strategy.connect(user).deposit(1000))
        .to.be.revertedWithCustomError(strategy, "UnauthorizedTreasury");
    });

    it("dépose bien dans Morpho et crédite des shares", async function () {
      const { ethers, treasury, strategy, morpho, reserveSigner, operator, usdc, marketParams } = await deployFixture();

      await usdc.connect(operator).approve(await treasury.getAddress(), ethers.parseUnits("10000", 6));
      await treasury.connect(operator).deposit(ethers.parseUnits("10000", 6), await usdc.getAddress());

      // Treasury pousse 3000 USDC vers la stratégie (simulateur d'un rebalance manuel)
      await treasury.connect(reserveSigner).rebalance(await usdc.getAddress(), 7000); // cible 70% liquide -> dépose 30%
      // 30% de 10000 = 3000
      const id = await morpho.id(marketParams);
      const [supplyShares] = await morpho.position(id, await strategy.getAddress());
      expect(supplyShares).to.be.gt(0n);

      expect(await strategy.totalAssets()).to.equal(ethers.parseUnits("3000", 6));
      expect(await usdc.balanceOf(await treasury.getAddress())).to.equal(ethers.parseUnits("7000", 6));
    });
  });

  // ── totalAssets() reflète le rendement ───────────────────────────────────

  describe("totalAssets()", function () {
    it("augmente quand un rendement est accru sur le marché", async function () {
      const { ethers, treasury, strategy, morpho, reserveSigner, operator, usdc, marketParams, owner } = await deployFixture();

      await usdc.connect(operator).approve(await treasury.getAddress(), ethers.parseUnits("10000", 6));
      await treasury.connect(operator).deposit(ethers.parseUnits("10000", 6), await usdc.getAddress());
      await treasury.connect(reserveSigner).rebalance(await usdc.getAddress(), 5000); // 50/50 -> 5000 déposés

      expect(await strategy.totalAssets()).to.equal(ethers.parseUnits("5000", 6));

      // Simule un rendement de 100 USDC gagné sur le marché
      await usdc.mint(owner.address, ethers.parseUnits("100", 6));
      await usdc.connect(owner).approve(await morpho.getAddress(), ethers.parseUnits("100", 6));
      await morpho.connect(owner).testAccrueYield(marketParams, ethers.parseUnits("100", 6));

      expect(await strategy.totalAssets()).to.equal(ethers.parseUnits("5100", 6));
    });
  });

  // ── withdraw() — scénario nominal + marché tendu ─────────────────────────

  describe("withdraw() en situation de marché tendu", function () {
    it("plafonne le retrait à la liquidité disponible plutôt que de revert", async function () {
      const {
        ethers, treasury, strategy, morpho, reserveSigner, operator, borrower, usdc, marketParams,
      } = await deployFixture();

      // Treasury dépose 10 000 USDC dans la stratégie
      await usdc.connect(operator).approve(await treasury.getAddress(), ethers.parseUnits("10000", 6));
      await treasury.connect(operator).deposit(ethers.parseUnits("10000", 6), await usdc.getAddress());
      await treasury.connect(reserveSigner).rebalance(await usdc.getAddress(), 0); // tout déposer -> 10 000 dans Morpho

      expect(await usdc.balanceOf(await treasury.getAddress())).to.equal(0n);

      // Un emprunteur externe tire 9 000 USDC de liquidité (simulateur de marché tendu,
      // cf. le cas réel du vault Morpho "AlphaUSDC Delta V2", juin 2026)
      await morpho.testBorrowLiquidity(marketParams, ethers.parseUnits("9000", 6), borrower.address);
      // Il ne reste que 1 000 USDC de liquidité disponible dans le marché

      // Treasury tente de vendre pour 5 000 USDC de GLD (operatorWithdraw) —
      // il ne devrait récupérer que les 1 000 USDC disponibles, pas plus, et donc
      // reverter avec InsufficientBalance plutôt qu'un revert Morpho brut.
      await expect(
        treasury.connect(operator).operatorWithdraw(operator.address, ethers.parseUnits("5000", 6), await usdc.getAddress())
      ).to.be.revertedWithCustomError(treasury, "InsufficientBalance")
        .withArgs(ethers.parseUnits("5000", 6), ethers.parseUnits("1000", 6));

      // Mais un retrait de 1 000 USDC ou moins doit, lui, réussir normalement
      // (pas de wrapper .to.not.be.reverted — déprécié selon la version des
      // chai-matchers ; un await direct échoue déjà tout seul si ça revert)
      const balanceBefore = await usdc.balanceOf(operator.address);
      await treasury.connect(operator).operatorWithdraw(
        operator.address, ethers.parseUnits("1000", 6), await usdc.getAddress()
      );
      const balanceAfter = await usdc.balanceOf(operator.address);
      expect(balanceAfter - balanceBefore).to.equal(ethers.parseUnits("1000", 6));
    });

    it("rapatrie automatiquement le manquant quand la liquidité du marché suffit", async function () {
      const { ethers, treasury, strategy, reserveSigner, operator, usdc } = await deployFixture();

      await usdc.connect(operator).approve(await treasury.getAddress(), ethers.parseUnits("10000", 6));
      await treasury.connect(operator).deposit(ethers.parseUnits("10000", 6), await usdc.getAddress());
      await treasury.connect(reserveSigner).rebalance(await usdc.getAddress(), 2000); // 20% liquide -> 2000 liquide / 8000 investis

      expect(await usdc.balanceOf(await treasury.getAddress())).to.equal(ethers.parseUnits("2000", 6));

      // Une vente de 5000 USDC dépasse le liquide (2000) mais la stratégie a 8000 dispo
      await expect(
        treasury.connect(operator).operatorWithdraw(operator.address, ethers.parseUnits("5000", 6), await usdc.getAddress())
      ).to.emit(treasury, "YieldShortfallCovered")
        .withArgs(await usdc.getAddress(), ethers.parseUnits("3000", 6));

      expect(await usdc.balanceOf(await strategy.getAddress())).to.equal(0n); // rien ne traîne dans la stratégie elle-même
    });
  });

  // ── setMarketParams() ─────────────────────────────────────────────────

  describe("setMarketParams()", function () {
    it("refuse la bascule tant qu'une position de supply est active", async function () {
      const { ethers, treasury, strategy, reserveSigner, operator, usdc, owner, cbbtc, user } = await deployFixture();

      await usdc.connect(operator).approve(await treasury.getAddress(), ethers.parseUnits("1000", 6));
      await treasury.connect(operator).deposit(ethers.parseUnits("1000", 6), await usdc.getAddress());
      await treasury.connect(reserveSigner).rebalance(await usdc.getAddress(), 0); // tout déposer

      // oracle/irm factices non nuls — seul le test de position active nous intéresse ici
      await expect(
        strategy.connect(owner).setMarketParams(
          await usdc.getAddress(), await cbbtc.getAddress(), user.address, owner.address, 770000000000000000n
        )
      ).to.be.revertedWithCustomError(strategy, "ActivePositionExists");
    });
  });

  // ── rescueTokens() ────────────────────────────────────────────────────

  describe("rescueTokens()", function () {
    it("refuse de rescue le loanToken actif", async function () {
      const { strategy, owner, usdc, user } = await deployFixture();
      await expect(
        strategy.connect(owner).rescueTokens(await usdc.getAddress(), user.address, 1)
      ).to.be.revertedWithCustomError(strategy, "CannotRescueActiveAsset");
    });
  });
});
