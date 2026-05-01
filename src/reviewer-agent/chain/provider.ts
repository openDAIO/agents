import { JsonRpcProvider, Wallet } from "ethers";

export interface ChainContext {
  provider: JsonRpcProvider;
  wallet: Wallet;
}

export function makeChainContext(rpcUrl: string, privateKey: string): ChainContext {
  const provider = new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true });
  const wallet = new Wallet(privateKey, provider);
  return { provider, wallet };
}
