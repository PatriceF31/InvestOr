import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const ExchangeModule = buildModule("ExchangeModule", (m) => {
  const initialOwner      = m.getParameter("initialOwner",      "0xYOUR_DEPLOYER_ADDRESS");
  const gldAddress        = m.getParameter("gldAddress",        "0xGLD_PROXY_ADDRESS");
  const treasuryAddress   = m.getParameter("treasuryAddress",   "0xTREASURY_PROXY_ADDRESS");
  const oracleAddress     = m.getParameter("oracleAddress",     "0x0000000000000000000000000000000000000000");
  const initFallbackPrice = m.getParameter("initFallbackPrice", 9000_00000000n); // $90/g = $90 000/kg

  const exchangeImpl = m.contract("Exchange");

  const initData = m.encodeFunctionCall(exchangeImpl, "initialize", [
    initialOwner,
    gldAddress,
    treasuryAddress,
    oracleAddress,
    initFallbackPrice,
  ]);

  const proxy = m.contract(
    "ERC1967Proxy",
    [exchangeImpl, initData],
    { after: [exchangeImpl], id: "ExchangeProxy" }
  );

  return { exchangeImpl, proxy };
});

export default ExchangeModule;
