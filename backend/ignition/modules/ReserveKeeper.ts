import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const RESERVE_ADDRESS  = "0x130A6A02eee28C4f9A5b01B854ce4aE7BE7D65Ce";
const CHECK_INTERVAL   = 3600n; // 1 heure en secondes

export default buildModule("ReserveKeeperModule", (m) => {
  const reserveKeeper = m.contract("ReserveKeeper", [
    RESERVE_ADDRESS,
    CHECK_INTERVAL,
  ]);

  return { reserveKeeper };
});