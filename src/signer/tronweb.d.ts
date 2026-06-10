/**
 * Minimal type declarations for the tronweb package.
 *
 * The tronweb npm package does not ship a bundled .d.ts file.
 * These declarations cover only what src/signer/sign.ts uses.
 */
declare module "tronweb" {
  interface TronWebUtils {
    crypto: {
      /**
       * Sign a Tron transaction offline.
       *
       * @param privateKeyHex  Hex-encoded 32-byte private key.
       * @param tx             Transaction object with at least a `txID` field.
       * @returns              The same object with `signature` populated.
       */
      signTransaction(
        privateKeyHex: string,
        tx: Record<string, unknown>,
      ): Record<string, unknown>;
    };
    transaction: {
      /**
       * Re-serialize a transaction's JSON raw_data to protobuf and verify the
       * resulting txID matches tx.txID. Binds the inspectable JSON fields to
       * the bytes that actually get signed (txID = sha256(raw_data bytes)).
       */
      txCheck(tx: Record<string, unknown>): boolean;
      /** Serialize a tx JSON object to a protobuf Transaction (test helper). */
      txJsonToPb(tx: Record<string, unknown>): unknown;
      /** Hex-encode a protobuf Transaction's raw_data (test helper). */
      txPbToRawDataHex(pb: unknown): string;
      /** Compute txID = sha256(raw_data bytes) from a protobuf tx (test helper). */
      txPbToTxID(pb: unknown): string;
    };
    [key: string]: unknown;
  }

  interface TronWebStatic {
    utils: TronWebUtils;
    address: {
      fromPrivateKey(privateKeyHex: string): string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }

  // Constructor
  interface TronWebConstructor {
    new (opts: { fullHost: string; [key: string]: unknown }): TronWebStatic;
    // Static properties (accessed as TronWeb.utils.crypto etc.)
    utils: TronWebUtils;
    address: {
      fromPrivateKey(privateKeyHex: string): string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  }

  const TronWeb: TronWebConstructor;
  export default TronWeb;
}
