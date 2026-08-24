import type { ErrorRequestHandler } from "express";

export const errorHandler: ErrorRequestHandler = (
  error: unknown,
  _request,
  response,
  _next,
) => {
  console.error(error);

  if (response.headersSent) {
    return;
  }

  response.status(500).json({
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "The server could not complete the request",
    },
  });
};
