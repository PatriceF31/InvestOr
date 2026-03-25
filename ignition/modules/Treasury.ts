import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const TreasuryModule = buildModule("TreasuryModule", (m) => {
  const initialOwner = m.getParameter("initialOwner", "0xYOUR_DEPLOYER_ADDRESS");
  const usdcAddress  = m.getParameter("usdcAddress",  "0xYOUR_USDC_ADDRESS");

  // 1. Implémentation Treasury
  const treasuryImpl = m.contract("Treasury");

  // 2. Encodage initialize
  const initData = m.encodeFunctionCall(treasuryImpl, "initialize", [
    initialOwner,
    usdcAddress,
  ]);

  // 3. Proxy UUPS
  const proxy = m.contract(
    "ERC1967Proxy",
    [treasuryImpl, initData],
    { after: [treasuryImpl], id: "TreasuryProxy" }
  );

  return { treasuryImpl, proxy };
});

export default TreasuryModule;