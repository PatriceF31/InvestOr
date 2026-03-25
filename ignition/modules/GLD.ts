import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
 
const GLDModule = buildModule("GLDModule", (m) => {
  const initialOwner = m.getParameter(
    "initialOwner",
    "0xYOUR_DEPLOYER_ADDRESS"
  );
 
  const gldImpl = m.contract("GLD");
  const initData = m.encodeFunctionCall(gldImpl, "initialize", [initialOwner]);
 
  const proxy = m.contract(
    "ERC1967Proxy",
    [gldImpl, initData],
    { after: [gldImpl], id: "GLDProxy" }
  );
 
  return { gldImpl, proxy };
});
 
export default GLDModule;