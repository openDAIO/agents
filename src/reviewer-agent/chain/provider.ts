import { Wallet, type Provider } from "ethers";
import { makeRpcProvider, parseRpcUrls, rpcFailoverOptionsFromEnv } from "../../shared/rpc.js";

export interface ChainContext {
  provider: Provider;
  wallet: Wallet;
}

export function makeChainContext(rpcUrl: string, privateKey: string, rpcUrls = process.env.RPC_URLS): ChainContext {
  const provider = makeRpcProvider(parseRpcUrls(rpcUrl, rpcUrls), rpcFailoverOptionsFromEnv());
  const wallet = new Wallet(privateKey, provider);
  return { provider, wallet };
}
