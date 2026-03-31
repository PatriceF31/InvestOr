import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const SerialNumberModule = buildModule("SerialNumberModule", (m) => {
  const initialOwner = m.getParameter("initialOwner", "0xYOUR_DEPLOYER_ADDRESS");
  const initPrefix   = m.getParameter("initPrefix",   "GLD");

  const impl     = m.contract("SerialNumber");
  const initData = m.encodeFunctionCall(impl, "initialize", [initialOwner, initPrefix]);

  const proxy = m.contract(
    "ERC1967Proxy",
    [impl, initData],
    { after: [impl], id: "SerialNumberProxy" }
  );

  return { impl, proxy };
});

export default SerialNumberModule;
