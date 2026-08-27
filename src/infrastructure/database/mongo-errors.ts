export function hasMongoErrorCode(error: unknown, ...codes: number[]): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    codes.includes(error.code as number)
  );
}