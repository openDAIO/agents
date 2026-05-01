const DEFAULT_MULTIPLIER = 3n;

function parseGasFloor(envName: string, fallback: bigint): bigint {
  const raw = process.env[envName];
  if (!raw) return fallback;
  try {
    const value = BigInt(raw);
    return value > 0n ? value : fallback;
  } catch (_err) {
    return fallback;
  }
}

export async function gasLimitWithHeadroom(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  method: any,
  args: readonly unknown[],
  envName: string,
  fallbackFloor: bigint,
): Promise<bigint> {
  const floor = parseGasFloor(envName, fallbackFloor);
  try {
    const estimated = BigInt(await method.estimateGas(...args));
    const padded = estimated * DEFAULT_MULTIPLIER;
    return padded > floor ? padded : floor;
  } catch (_err) {
    return floor;
  }
}
