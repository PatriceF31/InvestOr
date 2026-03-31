import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const EventLoggerModule = buildModule("EventLoggerModule", (m) => {
  const initialOwner = m.getParameter("initialOwner", "0xYOUR_DEPLOYER_ADDRESS");

  const loggerImpl = m.contract("EventLogger");
  const initData   = m.encodeFunctionCall(loggerImpl, "initialize", [initialOwner]);

  const proxy = m.contract(
    "ERC1967Proxy",
    [loggerImpl, initData],
    { after: [loggerImpl], id: "EventLoggerProxy" }
  );

  return { loggerImpl, proxy };
});

export default EventLoggerModule;
