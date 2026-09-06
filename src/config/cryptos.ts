import { z } from "zod";
import rawCryptos from "./cryptos.json" with { type: "json" };

const networkConfigSchema = z.object({
  name: z.string().min(1),
  decimals: z.number().int().nonnegative().max(36),
  dustThreshold: z.number().int().nonnegative().optional(),
  contractAddress: z.string().min(1).optional(),
  explorerTransactionUrl: z.string().min(1).includes("{txId}"),
});

const assetConfigSchema = z.object({
  name: z.string().min(1),
  networks: z
    .record(z.string(), networkConfigSchema)
    .refine((networks) => Object.keys(networks).length > 0, {
      message: "an asset must have at least one network",
    }),
});

const cryptoConfigSchema = z.record(z.string(), assetConfigSchema);

export type NetworkConfig = z.infer<typeof networkConfigSchema>;
export type AssetConfig = z.infer<typeof assetConfigSchema>;

export function parseCryptoConfig(raw: unknown): Record<string, AssetConfig> {
  const result = cryptoConfigSchema.safeParse(raw);

  if (!result.success) {
    throw new Error(`invalid crypto config: ${result.error.message}`);
  }
  return result.data;
}

export const cryptos: Record<string, AssetConfig> =
  parseCryptoConfig(rawCryptos);

export function findNetwork(
  asset: string,
  network: string,
): NetworkConfig | undefined {
  if (!Object.hasOwn(cryptos, asset)) return undefined;

  // to avoid user input cryptos["constructor"]
  const {networks} = cryptos[asset]
  return Object.hasOwn(networks, network)? networks[network]: undefined;
}

export function explorerTransactionUrl(
  asset: string,
  network: string,
  txId: string,
): string | undefined {
  const networkConfig = findNetwork(asset, network);

  if (!networkConfig) {
    return undefined;
  }
  return networkConfig.explorerTransactionUrl.replace("{txId}", txId);
}
