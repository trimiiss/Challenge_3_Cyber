// Local dev chain for Vula. Chain id 31337 matches DCAP.Web's default (DCAP__BlockchainId).
// Account #0 (0xf39F...2266, key 0xac09...ff80) is the well-known Hardhat dev account DCAP.Web signs with locally.
module.exports = {
  networks: {
    hardhat: {
      chainId: 31337,
      mining: { auto: true },
    },
  },
};
