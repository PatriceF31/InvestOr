import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const SERIAL_NUMBER_ADDRESS = "0x24622EfA10CfBA2B6F0e2845a89B09711293867d";
const OWNER_ADDRESS         = "0x7f7533Ea6aA203d07eBB6F06aE1a8A4AD0B33917"; // Gnosis Safe
const BASE_URI              = "ipfs://bafybeiaxgne3hpyc7p2bkwagcql4ajqrldgcc775qrghqhum2kzo3mqy5a/";

export default buildModule("LingotOrModule", (m) => {
  const lingotOr = m.contract("LingotOr");

  const proxy = m.contract("InvestOrProxy", [
    lingotOr,
    m.encodeFunctionCall(lingotOr, "initialize", [
      OWNER_ADDRESS,
      SERIAL_NUMBER_ADDRESS,
      BASE_URI,
    ]),
  ]);

  return { lingotOr, proxy };
});