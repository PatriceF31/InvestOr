import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const ReserveModule = buildModule("ReserveModule", (m) => {
  const initialOwner    = m.getParameter("initialOwner",    "0xYOUR_DEPLOYER_ADDRESS");
  const gldAddress      = m.getParameter("gldAddress",      "0xGLD_PROXY");
  const treasuryAddress = m.getParameter("treasuryAddress", "0xTREASURY_PROXY");
  const exchangeAddress = m.getParameter("exchangeAddress", "0xEXCHANGE_PROXY");
  const oracleAddress   = m.getParameter("oracleAddress",   "0x0000000000000000000000000000000000000000");
  const initMinRatio    = m.getParameter("initMinRatio",    10_000n); // 100%

  const reserveImpl = m.contract("Reserve");

  const initData = m.encodeFunctionCall(reserveImpl, "initialize", [
    initialOwner,
    gldAddress,
    treasuryAddress,
    exchangeAddress,
    oracleAddress,
    initMinRatio,
  ]);

  const proxy = m.contract(
    "ERC1967Proxy",
    [reserveImpl, initData],
    { after: [reserveImpl], id: "ReserveProxy" }
  );

  return { reserveImpl, proxy };
});

export default ReserveModule;
