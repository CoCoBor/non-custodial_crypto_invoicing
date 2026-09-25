import "bitcore-lib";

declare module "bitcore-lib" {
  namespace Address {
    function isValid(
      data: string,
      network?: Networks.Network | string,
      type?: string,
    ): boolean;
    function getValidationError(
      data: string,
      network?: Networks.Network | string,
      type?: string,
    ): Error | null;
  }

  // Runtime accepts serialization-check options; the published types omit them.
  interface Transaction {
    serialize(options?: {
      disableDustOutputs?: boolean;
      disableSmallFees?: boolean;
      disableLargeFees?: boolean;
      disableIsFullySigned?: boolean;
      disableMoreOutputThanInput?: boolean;
    }): string;
  }
}
