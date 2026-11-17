import { Schema, model } from "mongoose";

export const LOGIN_CHALLENGES_COLLECTION = "login_challenges";

const loginChallengeSchema = new Schema(
  {
    // SHA-256(challenge). The challenge itself is never stored.
    challengeHash: { type: String, required: true },
    userId: { type: String, required: true },
    expiresAt: { type: Date, required: true },
  },
  {
    collection: LOGIN_CHALLENGES_COLLECTION,
    autoCreate: false,
    autoIndex: false,
  },
);

loginChallengeSchema.index({ challengeHash: 1 }, { unique: true });
loginChallengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const LoginChallenge = model("LoginChallenge", loginChallengeSchema);
