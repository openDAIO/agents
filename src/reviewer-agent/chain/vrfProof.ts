import crypto from "node:crypto";
import { AbiCoder, ZeroAddress, ZeroHash, type Provider } from "ethers";
import { secp256k1 } from "@noble/curves/secp256k1";

export type VrfProof = [bigint, bigint, bigint, bigint];
export type VrfPublicKey = [bigint, bigint];

export interface VrfProofInput {
  coreAddress: string;
  requestId: bigint;
  phase: string;
  epoch: bigint;
  participant: string;
  target?: string;
  phaseStartBlock: bigint;
  finalityFactor: bigint;
}

export interface VrfProofProvider {
  publicKey: VrfPublicKey;
  proofFor(input: VrfProofInput): Promise<VrfProof>;
}

const coder = AbiCoder.defaultAbiCoder();
const CURVE_ORDER = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function parseScalar(raw: string): bigint {
  const trimmed = raw.trim();
  const scalar = trimmed.startsWith("0x") || trimmed.startsWith("0X") ? BigInt(trimmed) : BigInt(trimmed);
  if (scalar <= 0n || scalar >= CURVE_ORDER) {
    throw new Error("VRF private key must be in the secp256k1 scalar range");
  }
  return scalar;
}

function bytesToBigint(bytes: Uint8Array): bigint {
  return BigInt(`0x${Buffer.from(bytes).toString("hex")}`);
}

function bigintToBytes32(value: bigint): Uint8Array {
  if (value < 0n || value >= (1n << 256n)) throw new Error("value does not fit in bytes32");
  return Uint8Array.from(Buffer.from(value.toString(16).padStart(64, "0"), "hex"));
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function sha256Bytes(bytes: Uint8Array): Uint8Array {
  return Uint8Array.from(crypto.createHash("sha256").update(bytes).digest());
}

function pointTuple(point: ReturnType<typeof secp256k1.ProjectivePoint.BASE.toAffine>): VrfPublicKey {
  return [point.x, point.y];
}

function encodePoint(point: VrfPublicKey): Uint8Array {
  return concatBytes([Uint8Array.of(Number(2n + (point[1] & 1n))), bigintToBytes32(point[0])]);
}

function hashToTryAndIncrement(publicKey: VrfPublicKey, message: Uint8Array): typeof secp256k1.ProjectivePoint.BASE {
  const prefix = concatBytes([Uint8Array.of(0xfe, 0x01), encodePoint(publicKey), message]);
  for (let ctr = 0; ctr < 256; ctr++) {
    const digest = sha256Bytes(concatBytes([prefix, Uint8Array.of(ctr)]));
    try {
      return secp256k1.ProjectivePoint.fromHex(concatBytes([Uint8Array.of(0x02), digest]));
    } catch {
      // Try-and-increment: only some x coordinates map to a valid secp256k1 point.
    }
  }
  throw new Error("VRF hash-to-curve failed");
}

function hashPoints(
  h: VrfPublicKey,
  gamma: VrfPublicKey,
  u: VrfPublicKey,
  v: VrfPublicKey,
): bigint {
  const digest = sha256Bytes(
    concatBytes([
      Uint8Array.of(0xfe, 0x02),
      encodePoint(h),
      encodePoint(gamma),
      encodePoint(u),
      encodePoint(v),
    ]),
  );
  return bytesToBigint(digest.slice(0, 16));
}

function randomScalar(): bigint {
  for (;;) {
    const scalar = bytesToBigint(crypto.randomBytes(32));
    if (scalar > 0n && scalar < CURVE_ORDER) return scalar;
  }
}

export async function daioVrfMessage(provider: Provider, input: VrfProofInput): Promise<Uint8Array> {
  const network = await provider.getNetwork();
  const stableBlock = input.phaseStartBlock > input.finalityFactor ? input.phaseStartBlock - input.finalityFactor : 0n;
  let stableBlockHash = ZeroHash;
  if (stableBlock > 0n) {
    const currentBlock = BigInt(await provider.getBlockNumber());
    if (currentBlock >= stableBlock && currentBlock - stableBlock <= 256n) {
      stableBlockHash = (await provider.getBlock(Number(stableBlock)))?.hash ?? ZeroHash;
    }
  }

  const encoded = coder.encode(
    ["uint256", "address", "uint256", "bytes32", "uint256", "address", "address", "uint256", "bytes32"],
    [
      network.chainId,
      input.coreAddress,
      input.requestId,
      input.phase,
      input.epoch,
      input.participant,
      input.target ?? ZeroAddress,
      stableBlock,
      stableBlockHash,
    ],
  );
  return Uint8Array.from(Buffer.from(encoded.slice(2), "hex"));
}

export function makeFixtureVrfProvider(publicKey: VrfPublicKey, proof: VrfProof): VrfProofProvider {
  return {
    publicKey,
    proofFor: async () => proof,
  };
}

export function makeSecp256k1VrfProvider(privateKey: string, provider: Provider): VrfProofProvider {
  const scalar = parseScalar(privateKey);
  const publicKey = pointTuple(secp256k1.ProjectivePoint.BASE.multiply(scalar).toAffine());
  return {
    publicKey,
    proofFor: async (input) => {
      const message = await daioVrfMessage(provider, input);
      const hPoint = hashToTryAndIncrement(publicKey, message);
      const h = pointTuple(hPoint.toAffine());
      const gamma = pointTuple(hPoint.multiply(scalar).toAffine());
      for (;;) {
        const nonce = randomScalar();
        const u = pointTuple(secp256k1.ProjectivePoint.BASE.multiply(nonce).toAffine());
        const v = pointTuple(hPoint.multiply(nonce).toAffine());
        const c = hashPoints(h, gamma, u, v);
        const s = (nonce + c * scalar) % CURVE_ORDER;
        if (s !== 0n) return [gamma[0], gamma[1], c, s];
      }
    },
  };
}
