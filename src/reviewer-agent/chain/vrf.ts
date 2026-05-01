import { Contract, type ContractRunner } from "ethers";
import { Artifacts } from "../../shared/abis.js";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const VRF_DATA = path.resolve(here, "../../../contracts/lib/vrf-solidity/test/data.json");

interface VRFTestVector {
  hash: string;
  pi: string;
  pub: string;
  message: string;
}

interface VRFData {
  verify: { valid: VRFTestVector[] };
}

export interface DecodedVRF {
  publicKey: [bigint, bigint];
  proof: [bigint, bigint, bigint, bigint];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function decodeVRFTestVector(verifier: any): Promise<DecodedVRF> {
  const data = JSON.parse(readFileSync(VRF_DATA, "utf8")) as VRFData;
  const vec = data.verify.valid[0];
  if (!vec) throw new Error("vrf test vector missing");
  const pubArr = (await verifier.decodePoint(vec.pub)) as readonly [bigint, bigint];
  const proofArr = (await verifier.decodeProof(vec.pi)) as readonly [bigint, bigint, bigint, bigint];
  return {
    publicKey: [pubArr[0], pubArr[1]],
    proof: [proofArr[0], proofArr[1], proofArr[2], proofArr[3]],
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function makeVerifier(address: string, runner: ContractRunner): any {
  return new Contract(address, Artifacts.FRAINVRFVerifier().abi as never[], runner);
}
