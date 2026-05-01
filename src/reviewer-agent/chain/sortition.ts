import { AbiCoder, keccak256, ZeroAddress } from "ethers";
import { SCALE } from "../../shared/types.js";

const coder = AbiCoder.defaultAbiCoder();

export interface SortitionParams {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vrfCoordinator: any;
  coreAddress: string;
  publicKey: [bigint, bigint];
  proof: [bigint, bigint, bigint, bigint];
  requestId: bigint;
  phase: string;
  epoch: bigint;
  participant: string;
  target?: string;
  phaseStartBlock: bigint;
  finalityFactor: bigint;
  difficulty: bigint;
}

export async function sortitionPass(params: SortitionParams): Promise<boolean> {
  const target = params.target ?? ZeroAddress;
  const randomness = (await params.vrfCoordinator.randomness(
    params.publicKey,
    params.proof,
    params.coreAddress,
    params.requestId,
    params.phase,
    params.epoch,
    params.participant,
    target,
    params.phaseStartBlock,
    params.finalityFactor,
  )) as string;
  const score =
    BigInt(
      keccak256(
        coder.encode(
          ["bytes32", "uint256", "address", "address", "bytes32"],
          [params.phase, params.requestId, params.participant, target, randomness],
        ),
      ),
    ) % SCALE;
  return score < params.difficulty;
}
