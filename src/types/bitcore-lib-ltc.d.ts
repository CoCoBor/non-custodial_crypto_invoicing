declare module "bitcore-lib-ltc" {
  const litecore: Pick<
    typeof import("bitcore-lib"),
    "Address" | "Networks" | "PrivateKey" | "Script" | "Transaction"
  >;

  export default litecore;
}